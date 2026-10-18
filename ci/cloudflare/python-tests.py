#!/usr/bin/env python3
"""Run the Python client suites in an isolated, reproducible pytest environment."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SUITES = {
    "rpc": REPO_ROOT / "clients/python/veyyon-rpc/tests",
    "veybot": REPO_ROOT / "clients/python/veybot/tests",
}


def _child_env() -> dict[str, str]:
    env = os.environ.copy()
    env.pop("CLOUDFLARE_API_TOKEN", None)
    return env


def selected_suites(suite: str) -> list[str]:
    if suite == "all":
        return list(SUITES)
    if suite not in SUITES:
        raise ValueError(f"unknown Python suite: {suite}")
    return [suite]


def _xml_counts(report: Path) -> tuple[int, int, int, int]:
    root = ET.parse(report).getroot()
    suites = list(root) if root.tag == "testsuites" else [root]
    collected = passed = failed = skipped = 0
    for suite in suites:
        tests = int(suite.attrib.get("tests", "0"))
        errors = int(suite.attrib.get("errors", "0"))
        failures = int(suite.attrib.get("failures", "0"))
        skips = int(suite.attrib.get("skipped", "0"))
        collected += tests
        failed += errors + failures
        skipped += skips
        passed += max(0, tests - errors - failures - skips)
    return collected, passed, failed, skipped
def run_pytest(python: str, test_path: Path, suite: str) -> int:
    """Run real pytest and return nonzero for failures, collection errors, or no tests."""
    with tempfile.TemporaryDirectory(prefix="veyyon-pytest-") as temp_dir:
        report = Path(temp_dir) / "pytest.xml"
        env = _child_env()
        command = [python, "-m", "pytest", "-q", f"--junitxml={report}", str(test_path)]
        result = subprocess.run(command, cwd=test_path.parent.parent, env=env, check=False)
        if not report.is_file():
            print(f"PYTEST_SUMMARY suite={suite} collected=0 pass=0 fail=1 skip=0", flush=True)
            return result.returncode or 1
        try:
            collected, passed, failed, skipped = _xml_counts(report)
        except (ET.ParseError, OSError, ValueError) as error:
            print(f"PYTEST_REPORT_INVALID suite={suite} error={error}", file=sys.stderr, flush=True)
            return 1
        print(
            f"PYTEST_SUMMARY suite={suite} collected={collected} pass={passed} fail={failed} skip={skipped}",
            flush=True,
        )
        return result.returncode if result.returncode != 0 else (1 if collected == 0 or failed else 0)


def bootstrap_venv(venv_dir: Path) -> Path:
    """Install both clients and their declared development dependencies into an isolated venv."""
    subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], env=_child_env(), check=True)
    python = venv_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    subprocess.run(
        [str(python), "-m", "pip", "install", "-e", str(REPO_ROOT / "clients/python/veyyon-rpc")],
        env=_child_env(),
        check=True,
    )
    subprocess.run(
        [str(python), "-m", "pip", "install", "-e", f"{REPO_ROOT / 'clients/python/veybot'}[dev]"],
        check=True,
        env=_child_env(),
    )
    return python


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runner-tests", action="store_true", help="run this helper's real-pytest regression suite")
    args = parser.parse_args()
    try:
        suites = selected_suites(args.suite)
    except ValueError as error:
        parser.error(str(error))
    if args.runner_tests and args.suite != "all":
        parser.error("--runner-tests cannot be combined with --suite")
    with tempfile.TemporaryDirectory(prefix="veyyon-python-venv-") as temp_dir:
        python = bootstrap_venv(Path(temp_dir) / "venv")
        if args.runner_tests:
            return run_pytest(str(python), Path(__file__).with_name("test-python-tests.py"), "runner-tests")
        results = [run_pytest(str(python), SUITES[name], name) for name in suites]
    return max(results, default=1)


if __name__ == "__main__":
    raise SystemExit(main())
