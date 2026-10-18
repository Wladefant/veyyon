#!/usr/bin/env python3
"""Report and enforce the Cloudflare lane's named skipped-test allowlist.

``--shard i/3`` keeps the canonical three-shard contract: entries are selected by their stored ``shard``
label, and an allowed identity may repeat. ``--shard i/12`` checks a twelve-shard partition without that
label. Its expected identities are the allowlist entries whose files a JUnit case executed in this report
root (passed, failed or skipped), and the actual skips must match those identities exactly, one for one.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

VALID_CLASSES = {"E2E", "GATEWAY", "LOCAL_SERVICE", "PROVIDER_KEY", "VERTEX", "WINDOWS"}
SHARD_PATTERN = re.compile(r"([1-9][0-9]*)/(3|12)")

Identity = tuple[str, str]


@dataclass
class _Scan:
    skips: Counter[Identity]
    reports: list[Path]
    unidentified: list[dict[str, str]]
    suite_fallbacks: list[dict[str, str]]
    executed_files: set[str]
    unattributed_executed: list[str]


def _report_files(report_root: Path) -> list[Path]:
    return sorted(path for path in report_root.rglob("*.xml") if path.is_file())


def _repo_relative_file(case: ET.Element, suite: ET.Element, report: Path, repo_root: Path) -> str:
    raw = case.get("file") or suite.get("file")
    if not raw:
        raise ValueError(f"JUnit testcase has no file attribute: {report}")
    raw = raw.replace("\\", "/")
    candidate = Path(raw)
    if candidate.is_absolute():
        try:
            relative = candidate.resolve().relative_to(repo_root.resolve())
            return relative.as_posix()
        except ValueError:
            raw = PurePosixPath(raw).as_posix().lstrip("/")
    else:
        raw = PurePosixPath(raw).as_posix()
    raw = raw.removeprefix("./")
    scope = report.stem.split("--", 1)[0]
    if scope != "root":
        scope_path = scope.replace("__", "/")
        if raw != scope_path and not raw.startswith(f"{scope_path}/"):
            raw = f"{scope_path}/{raw}"
    return PurePosixPath(raw).as_posix()


def _read_skips(report_root: Path, repo_root: Path) -> _Scan:
    reports = _report_files(report_root)
    if not reports:
        raise ValueError(f"no JUnit XML reports found under {report_root}")
    scan = _Scan(Counter(), reports, [], [], set(), [])
    for report in reports:
        root = ET.parse(report).getroot()
        suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
        for suite in suites:
            for case in suite.findall("testcase"):
                skipped = case.find("skipped") is not None
                try:
                    file_name = _repo_relative_file(case, suite, report, repo_root)
                except ValueError as error:
                    if not skipped:
                        scan.unattributed_executed.append(f"{report.name}: {error}")
                        continue
                    scan.unidentified.append(
                        {
                            "file": case.get("file") or suite.get("file") or "",
                            "testcase_name": case.get("name", ""),
                            "testcase_classname": case.get("classname", ""),
                            "suite_name": suite.get("name", ""),
                            "suite_classname": suite.get("classname", ""),
                            "report": report.name,
                            "error": str(error),
                        }
                    )
                    continue
                scan.executed_files.add(file_name)
                if not skipped:
                    continue
                test_name = case.get("name") or ""
                test_class = case.get("classname") or ""
                if not test_name or not test_class:
                    suite_name = suite.get("name") or ""
                    suite_class = suite.get("classname") or ""
                    safe_case_attributes = {
                        key: value for key, value in case.attrib.items() if key in {"name", "classname", "file", "time"}
                    }
                    raw_case = ET.Element(case.tag, safe_case_attributes)
                    raw_case.append(ET.Element("skipped"))
                    case_xml = ET.tostring(raw_case, encoding="unicode")
                    if not test_name:
                        test_name = suite_name
                    if not test_class:
                        test_class = suite_class
                    if not test_name or not test_class:
                        scan.unidentified.append(
                            {
                                "file": file_name,
                                "testcase_name": case.get("name", ""),
                                "testcase_classname": case.get("classname", ""),
                                "suite_name": suite_name,
                                "suite_classname": suite_class,
                                "report": report.name,
                                "junit_case": case_xml,
                            }
                        )
                        continue
                    scan.suite_fallbacks.append(
                        {
                            "file": file_name,
                            "test": f"{test_class} > {test_name}",
                            "report": report.name,
                            "junit_case": case_xml,
                        }
                    )
                test_name = f"{test_class} > {test_name}"
                scan.skips[(file_name, test_name)] += 1
    return scan


def _parse_shard(value: str) -> tuple[int, int]:
    match = SHARD_PATTERN.fullmatch(value)
    if match is None or not 1 <= int(match.group(1)) <= int(match.group(2)):
        raise ValueError(f"unsupported shard {value!r}")
    return int(match.group(1)), int(match.group(2))


def _allowlist_identity(entry: dict[str, str]) -> Identity:
    return PurePosixPath(entry["file"].replace("\\", "/")).as_posix(), entry["test"]


def _read_allowlist_entries(path: Path) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    expected_fields = {"file", "test", "class", "reason", "shard"}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{line_number}: invalid JSON: {error}") from error
        if not isinstance(entry, dict) or set(entry) != expected_fields:
            raise ValueError(
                f"{path}:{line_number}: expected exactly file, test, class, reason, shard"
            )
        if not all(isinstance(entry[key], str) and entry[key].strip() for key in entry):
            raise ValueError(f"{path}:{line_number}: all fields must be non-empty strings")
        if entry["class"] not in VALID_CLASSES:
            raise ValueError(f"{path}:{line_number}: unsupported gate class {entry['class']!r}")
        if entry["shard"] not in {"1/3", "2/3", "3/3"}:
            raise ValueError(f"{path}:{line_number}: unsupported shard {entry['shard']!r}")
        file_name = _allowlist_identity(entry)[0]
        seen_key = (entry["shard"], file_name, entry["test"])
        if seen_key in seen:
            raise ValueError(f"{path}:{line_number}: duplicate skip entry {seen_key!r}")
        seen.add(seen_key)
        entries.append(entry)
    return entries


def _select_three_shard(entries: list[dict[str, str]], label: str) -> dict[Identity, dict[str, str]]:
    return {_allowlist_identity(entry): entry for entry in entries if entry["shard"] == label}


def _partition_allowlist(entries: list[dict[str, str]], executed: set[str]) -> dict[Identity, dict[str, str]]:
    scoped: dict[Identity, dict[str, str]] = {}
    for entry in entries:
        identity = _allowlist_identity(entry)
        if identity[0] not in executed:
            continue
        if identity in scoped:
            raise ValueError(f"duplicate expected skip in executed files: {identity[0]} > {identity[1]}")
        scoped[identity] = entry
    return scoped


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("report", "check"))
    parser.add_argument("report_root", type=Path)
    parser.add_argument("allowlist", type=Path, nargs="?")
    parser.add_argument("--expected-total", type=int)
    parser.add_argument("--shard")
    args = parser.parse_args()
    repo_root = Path.cwd()
    try:
        shard = _parse_shard(args.shard) if args.shard is not None else None
        if args.mode == "check" and shard is None:
            raise ValueError("check mode requires --shard <index>/3 or --shard <index>/12")
        scan = _read_skips(args.report_root, repo_root)
        actual = scan.skips
        named_total = sum(actual.values())
        total = named_total + len(scan.unidentified)
        count_mismatch = args.expected_total is not None and total != args.expected_total
        print(
            f"CLOUDFLARE_JUNIT_REPORTS count={len(scan.reports)} skips={total} "
            f"named={named_total} unidentified={len(scan.unidentified)} suite_fallbacks={len(scan.suite_fallbacks)}"
        )
        for entry in scan.suite_fallbacks:
            print(
                "CLOUDFLARE_TEST_SKIP_SUITE_FALLBACK "
                f"{json.dumps(entry, ensure_ascii=False, sort_keys=True)}"
            )
        for entry in scan.unidentified:
            print(
                "CLOUDFLARE_TEST_SKIP_UNIDENTIFIED "
                f"{json.dumps(entry, ensure_ascii=False, sort_keys=True)}"
            )
        if args.mode == "report":
            for (file_name, test_name), count in sorted(actual.items()):
                for _ in range(count):
                    print(
                        "CLOUDFLARE_TEST_SKIP "
                        f"file={json.dumps(file_name, ensure_ascii=False)} "
                        f"test={json.dumps(test_name, ensure_ascii=False)}"
                    )
            if count_mismatch:
                print(
                    f"CLOUDFLARE_SKIP_COUNT_MISMATCH expected={args.expected_total} actual={total}"
                )
            return 0
        if args.allowlist is None:
            raise ValueError("check mode requires an allowlist path")
        assert shard is not None
        index, partition = shard
        entries = _read_allowlist_entries(args.allowlist)
        if partition == 12:
            if scan.unattributed_executed:
                raise ValueError(
                    "executed JUnit case has no file attribute: " + "; ".join(scan.unattributed_executed)
                )
            if not scan.executed_files:
                raise ValueError("12-shard partition executed no test files")
            expected = _partition_allowlist(entries, scan.executed_files)
        else:
            expected = _select_three_shard(entries, f"{index}/3")
        class_counts: Counter[str] = Counter()
        has_unlisted = False
        for (file_name, test_name), count in sorted(actual.items()):
            entry = expected.get((file_name, test_name))
            if entry is None:
                allowed_count = 0
            elif partition == 12:
                allowed_count = min(count, 1)
            else:
                allowed_count = count
            if entry is not None and allowed_count:
                class_counts[entry["class"]] += allowed_count
                print(
                    "CLOUDFLARE_TEST_SKIP_ALLOWLISTED "
                    f"file={json.dumps(file_name, ensure_ascii=False)} "
                    f"test={json.dumps(test_name, ensure_ascii=False)} class={entry['class']} "
                    f"reason={json.dumps(entry['reason'], ensure_ascii=False)} count={allowed_count}"
                )
            if count > allowed_count:
                has_unlisted = True
                print(
                    "CLOUDFLARE_TEST_SKIP_UNLISTED "
                    f"file={json.dumps(file_name, ensure_ascii=False)} "
                    f"test={json.dumps(test_name, ensure_ascii=False)} count={count - allowed_count}"
                )
        has_stale = False
        for file_name, test_name in sorted(identity for identity in expected if identity not in actual):
            has_stale = True
            print(
                "CLOUDFLARE_TEST_SKIP_STALE "
                f"file={json.dumps(file_name, ensure_ascii=False)} "
                f"test={json.dumps(test_name, ensure_ascii=False)} count=1"
            )
        if count_mismatch:
            print(f"CLOUDFLARE_SKIP_COUNT_MISMATCH expected={args.expected_total} actual={total}")
        classes = ",".join(f"{name}:{class_counts[name]}" for name in sorted(VALID_CLASSES))
        print(
            f"CLOUDFLARE_SKIP_ALLOWLIST_SUMMARY total={total} "
            f"allowlisted={sum(class_counts.values())} by_class={classes}"
        )
        if scan.unidentified or count_mismatch:
            return 2
        return 1 if has_unlisted or has_stale else 0
    except (OSError, ET.ParseError, ValueError) as error:
        print(f"CLOUDFLARE_SKIP_REPORT_ERROR {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
