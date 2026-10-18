"""Behavior tests for the real pytest subprocess used by the Cloudflare Python runner."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("python-tests.py")
SPEC = importlib.util.spec_from_file_location("python_tests_runner", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def make_test_file(directory: Path, contents: str) -> Path:
    directory.mkdir(parents=True)
    test_file = directory / "test_contract.py"
    test_file.write_text(contents, encoding="utf-8")
    return test_file


def test_selects_each_client_or_both_in_order() -> None:
    assert runner.selected_suites("rpc") == ["rpc"]
    assert runner.selected_suites("veybot") == ["veybot"]
    assert runner.selected_suites("all") == ["rpc", "veybot"]


def test_real_pytest_reports_named_pass_and_skip_counts(tmp_path: Path, capsys) -> None:
    test_file = make_test_file(
        tmp_path / "passing",
        "import pytest\n\ndef test_pass():\n    assert 2 + 2 == 4\n\ndef test_skip():\n    pytest.skip('not applicable')\n",
    )

    assert runner.run_pytest(sys.executable, test_file.parent, "fixture-pass-skip") == 0
    output = capsys.readouterr().out
    assert "PYTEST_SUMMARY suite=fixture-pass-skip collected=2 pass=1 fail=0 skip=1" in output


def test_real_pytest_failure_is_nonzero_and_counted(tmp_path: Path, capsys) -> None:
    test_file = make_test_file(tmp_path / "failing", "def test_failure():\n    assert 'expected' == 'actual'\n")

    assert runner.run_pytest(sys.executable, test_file.parent, "fixture-failure") != 0
    assert "PYTEST_SUMMARY suite=fixture-failure collected=1 pass=0 fail=1 skip=0" in capsys.readouterr().out


def test_zero_collection_is_nonzero(tmp_path: Path, capsys) -> None:
    empty_dir = tmp_path / "empty"
    empty_dir.mkdir()

    assert runner.run_pytest(sys.executable, empty_dir, "fixture-empty") != 0
    assert "PYTEST_SUMMARY suite=fixture-empty collected=0 pass=0 fail=0 skip=0" in capsys.readouterr().out


def test_cloudflare_token_is_not_inherited_by_pytest(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "fake-token-for-regression-test")
    test_file = make_test_file(
        tmp_path / "credential-check",
        "import os\n\ndef test_token_is_absent():\n    assert 'CLOUDFLARE_API_TOKEN' not in os.environ\n",
    )

    assert runner.run_pytest(sys.executable, test_file.parent, "fixture-env-scrub") == 0
    assert "PYTEST_SUMMARY suite=fixture-env-scrub collected=1 pass=1 fail=0 skip=0" in capsys.readouterr().out


def test_collection_import_error_is_nonzero(tmp_path: Path, capsys) -> None:
    test_file = make_test_file(tmp_path / "broken", "import module_that_does_not_exist_for_this_test\n")

    assert runner.run_pytest(sys.executable, test_file.parent, "fixture-import-error") != 0
    assert "PYTEST_SUMMARY suite=fixture-import-error collected=0 pass=0 fail=1 skip=0" in capsys.readouterr().out
