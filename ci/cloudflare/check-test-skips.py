#!/usr/bin/env python3
"""Report and enforce the Cloudflare lane's named skipped-test allowlist."""

from __future__ import annotations

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path, PurePosixPath

VALID_CLASSES = {"E2E", "PROVIDER_KEY", "GATEWAY", "VERTEX", "WINDOWS"}


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


def _read_skips(report_root: Path, repo_root: Path) -> tuple[Counter[tuple[str, str]], list[Path]]:
    reports = _report_files(report_root)
    if not reports:
        raise ValueError(f"no JUnit XML reports found under {report_root}")
    skips: Counter[tuple[str, str]] = Counter()
    for report in reports:
        root = ET.parse(report).getroot()
        suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
        for suite in suites:
            for case in suite.findall("testcase"):
                if case.find("skipped") is None:
                    continue
                file_name = _repo_relative_file(case, suite, report, repo_root)
                test_name = case.get("name")
                test_class = case.get("classname")
                if not test_name or not test_class:
                    raise ValueError(f"JUnit skipped testcase needs classname and name: {report}")
                test_name = f"{test_class} > {test_name}"
                skips[(file_name, test_name)] += 1
    return skips, reports


def _read_allowlist(path: Path) -> dict[tuple[str, str], dict[str, str]]:
    entries: dict[tuple[str, str], dict[str, str]] = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{line_number}: invalid JSON: {error}") from error
        if not isinstance(entry, dict) or set(entry) != {"file", "test", "class", "reason"}:
            raise ValueError(f"{path}:{line_number}: expected exactly file, test, class, reason")
        if not all(isinstance(entry[key], str) and entry[key].strip() for key in entry):
            raise ValueError(f"{path}:{line_number}: all fields must be non-empty strings")
        if entry["class"] not in VALID_CLASSES:
            raise ValueError(f"{path}:{line_number}: unsupported gate class {entry['class']!r}")
        file_name = PurePosixPath(entry["file"].replace("\\", "/")).as_posix()
        key = (file_name, entry["test"])
        if key in entries:
            raise ValueError(f"{path}:{line_number}: duplicate skip entry {key!r}")
        entries[key] = entry
    return entries


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("report", "check"))
    parser.add_argument("report_root", type=Path)
    parser.add_argument("allowlist", type=Path, nargs="?")
    parser.add_argument("--expected-total", type=int)
    args = parser.parse_args()
    repo_root = Path.cwd()
    try:
        actual, reports = _read_skips(args.report_root, repo_root)
        if args.expected_total is not None and sum(actual.values()) != args.expected_total:
            raise ValueError(
                f"JUnit skip count {sum(actual.values())} does not match runner summary {args.expected_total}"
            )
        print(f"CLOUDFLARE_JUNIT_REPORTS count={len(reports)} skips={sum(actual.values())}")
        if args.mode == "report":
            for (file_name, test_name), count in sorted(actual.items()):
                for _ in range(count):
                    print(
                        "CLOUDFLARE_TEST_SKIP "
                        f"file={json.dumps(file_name, ensure_ascii=False)} "
                        f"test={json.dumps(test_name, ensure_ascii=False)}"
                    )
            return 0
        if args.allowlist is None:
            raise ValueError("check mode requires an allowlist path")
        allowed = _read_allowlist(args.allowlist)
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
        classes = ",".join(f"{name}:{class_counts[name]}" for name in sorted(VALID_CLASSES))
        print(
            f"CLOUDFLARE_SKIP_ALLOWLIST_SUMMARY total={sum(actual.values())} "
            f"allowlisted={sum(class_counts.values())} by_class={classes}"
        )
        return 1 if unlisted or stale else 0
    except (OSError, ET.ParseError, ValueError) as error:
        print(f"CLOUDFLARE_SKIP_REPORT_ERROR {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
