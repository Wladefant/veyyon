#!/usr/bin/env python3
"""Report and enforce the Cloudflare lane's named skipped-test allowlist."""

from __future__ import annotations

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path, PurePosixPath

VALID_CLASSES = {"E2E", "GATEWAY", "LOCAL_SERVICE", "PROVIDER_KEY", "VERTEX", "WINDOWS"}


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


def _read_skips(
    report_root: Path, repo_root: Path
) -> tuple[Counter[tuple[str, str]], list[Path], list[dict[str, str]], list[dict[str, str]]]:
    reports = _report_files(report_root)
    if not reports:
        raise ValueError(f"no JUnit XML reports found under {report_root}")
    skips: Counter[tuple[str, str]] = Counter()
    unidentified: list[dict[str, str]] = []
    suite_fallbacks: list[dict[str, str]] = []
    for report in reports:
        root = ET.parse(report).getroot()
        suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
        for suite in suites:
            for case in suite.findall("testcase"):
                if case.find("skipped") is None:
                    continue
                try:
                    file_name = _repo_relative_file(case, suite, report, repo_root)
                except ValueError as error:
                    file_name = case.get("file") or suite.get("file") or ""
                    unidentified.append(
                        {
                            "file": file_name,
                            "testcase_name": case.get("name", ""),
                            "testcase_classname": case.get("classname", ""),
                            "suite_name": suite.get("name", ""),
                            "suite_classname": suite.get("classname", ""),
                            "report": report.name,
                            "error": str(error),
                        }
                    )
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
                        unidentified.append(
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
                    suite_fallbacks.append(
                        {
                            "file": file_name,
                            "test": f"{test_class} > {test_name}",
                            "report": report.name,
                            "junit_case": case_xml,
                        }
                    )
                test_name = f"{test_class} > {test_name}"
                skips[(file_name, test_name)] += 1
    return skips, reports, unidentified, suite_fallbacks


def _read_allowlist(path: Path, shard: str) -> dict[tuple[str, str], dict[str, str]]:
    entries: dict[tuple[str, str], dict[str, str]] = {}
    seen: set[tuple[str, str]] = set()
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
        file_name = PurePosixPath(entry["file"].replace("\\", "/")).as_posix()
        key = (file_name, entry["test"])
        if key in seen:
            raise ValueError(f"{path}:{line_number}: duplicate skip entry {key!r}")
        seen.add(key)
        if entry["shard"] == shard:
            entries[key] = entry
    return entries


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
        if args.shard is not None and args.shard not in {"1/3", "2/3", "3/3"}:
            raise ValueError(f"unsupported shard {args.shard!r}")
        if args.mode == "check" and args.shard is None:
            raise ValueError("check mode requires --shard <index>/3")
        actual, reports, unidentified, suite_fallbacks = _read_skips(args.report_root, repo_root)
        named_total = sum(actual.values())
        total = named_total + len(unidentified)
        count_mismatch = args.expected_total is not None and total != args.expected_total
        print(
            f"CLOUDFLARE_JUNIT_REPORTS count={len(reports)} skips={total} "
            f"named={named_total} unidentified={len(unidentified)} suite_fallbacks={len(suite_fallbacks)}"
        )
        for entry in suite_fallbacks:
            print(
                "CLOUDFLARE_TEST_SKIP_SUITE_FALLBACK "
                f"{json.dumps(entry, ensure_ascii=False, sort_keys=True)}"
            )
        for entry in unidentified:
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
        allowed = _read_allowlist(args.allowlist, args.shard)
        unlisted = actual - Counter({key: 1 for key in allowed})
        stale = Counter({key: 1 for key in allowed}) - actual
        class_counts: Counter[str] = Counter()
        for (file_name, test_name), count in sorted(actual.items()):
            entry = allowed.get((file_name, test_name))
            allowed_count = min(count, 1) if entry is not None else 0
            if entry is not None:
                class_counts[entry["class"]] += allowed_count
                print(
                    "CLOUDFLARE_TEST_SKIP_ALLOWLISTED "
                    f"file={json.dumps(file_name, ensure_ascii=False)} "
                    f"test={json.dumps(test_name, ensure_ascii=False)} class={entry['class']} "
                    f"reason={json.dumps(entry['reason'], ensure_ascii=False)} count={allowed_count}"
                )
            if count > allowed_count:
                print(
                    "CLOUDFLARE_TEST_SKIP_UNLISTED "
                    f"file={json.dumps(file_name, ensure_ascii=False)} "
                    f"test={json.dumps(test_name, ensure_ascii=False)} count={count - allowed_count}"
                )
        for (file_name, test_name), count in sorted(stale.items()):
            print(
                "CLOUDFLARE_TEST_SKIP_STALE "
                f"file={json.dumps(file_name, ensure_ascii=False)} "
                f"test={json.dumps(test_name, ensure_ascii=False)} count={count}"
            )
        if count_mismatch:
            print(f"CLOUDFLARE_SKIP_COUNT_MISMATCH expected={args.expected_total} actual={total}")
        classes = ",".join(f"{name}:{class_counts[name]}" for name in sorted(VALID_CLASSES))
        print(
            f"CLOUDFLARE_SKIP_ALLOWLIST_SUMMARY total={total} "
            f"allowlisted={sum(class_counts.values())} by_class={classes}"
        )
        if unidentified or count_mismatch:
            return 2
        return 1 if unlisted or stale else 0
    except (OSError, ET.ParseError, ValueError) as error:
        print(f"CLOUDFLARE_SKIP_REPORT_ERROR {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())


