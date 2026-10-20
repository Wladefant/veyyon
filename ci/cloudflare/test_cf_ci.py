"""Contract and unit tests for Cloudflare Workers Builds CI lane gate for Veyyon (cf_ci.py)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from io import StringIO
from pathlib import Path
from unittest import mock

from dispatch_nightly import claim_once_per_utc_day
from dispatch_nightly import main as dispatch_nightly_main

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from cf_ci import (
    CheckoutError,
    extract_exact_head,
    main as cf_ci_main,
    parse_bun_summary,
    parse_python_unittest_summary,
    publish_github_commit_status,
    validate_exact_head,
)


class TestNightlyDispatchGuard(unittest.TestCase):
    def test_claim_is_atomic_and_limited_to_one_dispatch_per_utc_day(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertTrue(claim_once_per_utc_day(root, "2026-10-19"))
            self.assertFalse(claim_once_per_utc_day(root, "2026-10-19"))
            self.assertTrue(claim_once_per_utc_day(root, "2026-10-20"))



class TestNightlyBuildReceiptDeduplication(unittest.TestCase):
    SHA = "1111222233334444555566667777888899990000"
    OLD_SHA = "0000000000000000000000000000000000000000"

    def run_dispatch(
        self,
        remote_ref: str | None,
        receipt_age: str | None,
    ) -> tuple[list[list[str]], list[bytes], str]:

        commands: list[list[str]] = []
        payloads: list[bytes] = []
        clock = {"now": 0.0}
        stdout = StringIO()

        def fake_git(cmd, **kwargs):
            commands.append(cmd)
            if cmd[1:3] == ["branch", "--show-current"]:
                return subprocess.CompletedProcess(cmd, 0, stdout="main\n", stderr="")
            if cmd[1] == "rev-parse":
                return subprocess.CompletedProcess(cmd, 0, stdout=f"{self.SHA}\n", stderr="")
            if cmd[1] == "ls-remote":
                return subprocess.CompletedProcess(
                    cmd,
                    2 if remote_ref is None else 0,
                    stdout="" if remote_ref is None else f"{remote_ref}\trefs/heads/cf-nightly-main\n",
                    stderr="",
                )
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        def capture(request, timeout):
            if request.get_method() == "GET":
                created_on = (
                    (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
                    if receipt_age == "stale"
                    else datetime.now(timezone.utc).isoformat()
                )
                builds = (
                    []
                    if receipt_age is None
                    else [
                        {
                            "build_uuid": "auto-build-1",
                            "created_on": created_on,
                            "build_trigger_metadata": {
                                "branch": "cf-nightly-main",
                                "commit_hash": self.SHA,
                            },
                        }
                    ]
                )
                body = {
                    "success": True,
                    "result": builds,
                    "result_info": {
                        "page": 1,
                        "per_page": 200,
                        "count": len(builds),
                        "total_count": len(builds),
                        "total_pages": 1,
                    },
                }
            else:
                payloads.append(request.data)
                body = {
                    "success": True,
                    "result": {
                        "build_uuid": "api-build-1",
                        "created_on": datetime.now(timezone.utc).isoformat(),
                    },
                }
            response = mock.MagicMock()
            response.read.return_value = json.dumps(body).encode()
            opened = mock.MagicMock()
            opened.__enter__.return_value = response
            return opened

        def sleep(seconds):
            clock["now"] += seconds

        with tempfile.TemporaryDirectory() as state_dir, mock.patch.dict(
            os.environ,
            {
                "CLOUDFLARE_ACCOUNT_ID": "account",
                "CLOUDFLARE_TRIGGER_ID": "trigger",
                "CLOUDFLARE_WORKER_TAG": "worker-tag",
                "CLOUDFLARE_API_TOKEN": "token",
                "CLOUDFLARE_NIGHTLY_STATE_DIR": state_dir,
            },
        ), mock.patch("subprocess.run", side_effect=fake_git), mock.patch(
            "urllib.request.urlopen", side_effect=capture
        ), mock.patch("dispatch_nightly.time.monotonic", side_effect=lambda: clock["now"]), mock.patch(
            "dispatch_nightly.time.sleep", side_effect=sleep
        ), redirect_stdout(stdout):
            self.assertEqual(dispatch_nightly_main(), 0)
        return commands, payloads, stdout.getvalue()

    def test_new_ref_with_matching_build_receipt_does_not_post_twice(self) -> None:
        commands, payloads, output = self.run_dispatch(None, "new")
        self.assertTrue(any(command[1] == "push" for command in commands))
        self.assertEqual(payloads, [])
        self.assertIn("build_uuid=auto-build-1", output)
        self.assertIn("created_on=", output)

    def test_no_matching_build_receipt_posts_once(self) -> None:
        commands, payloads, output = self.run_dispatch(None, None)
        self.assertTrue(any(command[1] == "push" for command in commands))
        self.assertEqual(len(payloads), 1)
        self.assertIn(b'"branch": "cf-nightly-main"', payloads[0])
        self.assertIn(f'"commit_hash": "{self.SHA}"'.encode(), payloads[0])
        self.assertIn("build_uuid=api-build-1", output)
        self.assertIn("created_on=", output)

    def test_existing_ref_with_matching_receipt_does_not_post(self) -> None:
        commands, payloads, output = self.run_dispatch(self.SHA, "new")
        self.assertFalse(any(command[1] == "push" for command in commands))
        self.assertEqual(payloads, [])
        self.assertIn("created_on=", output)

    def test_outdated_ref_fast_forwards_and_matches_its_build_receipt(self) -> None:
        commands, payloads, output = self.run_dispatch(self.OLD_SHA, "new")
        pushes = [command for command in commands if command[1] == "push"]
        self.assertEqual(
            pushes,
            [["git", "push", "origin", f"{self.SHA}:refs/heads/cf-nightly-main"]],
        )
        self.assertEqual(payloads, [])
        self.assertIn("build_uuid=auto-build-1", output)

    def test_stale_same_sha_receipt_does_not_suppress_current_post(self) -> None:
        commands, payloads, output = self.run_dispatch(self.SHA, "stale")
        self.assertFalse(any(command[1] == "push" for command in commands))
        self.assertEqual(len(payloads), 1)
        self.assertIn("build_uuid=api-build-1", output)

class TestCfCiBunSummaryParser(unittest.TestCase):
    def test_parses_the_actual_lane_summary(self) -> None:
        log = (
            "CLOUDFLARE_TEST_SUMMARY pass=31759 fail=0 skip=16 todo=2 tests=31777 "
            "reported=31777 files=4 runs=12 chunks_pass=12 chunks_fail=0\n"
        )
        self.assertEqual(
            parse_bun_summary(log),
            {"pass": 31759, "fail": 0, "skip": 16, "todo": 2, "total": 31777, "chunks": 12},
        )

    def test_rejects_targeted_runner_records_without_lane_summary(self) -> None:
        log = (
            "CLOUDFLARE_CI_TEST_COUNTS pass=2 fail=0 skip=1 todo=0 tests=3 reported=3 files=1 runs=1\n"
            "CLOUDFLARE_CI_TEST_COUNTS pass=4 fail=0 skip=0 todo=0 tests=4 reported=4 files=2 runs=1\n"
        )
        with self.assertRaisesRegex(ValueError, "missing or malformed"):
            parse_bun_summary(log)

    def test_rejects_inconsistent_declared_total(self) -> None:
        with self.assertRaisesRegex(ValueError, "inconsistent"):
            parse_bun_summary(
                "CLOUDFLARE_TEST_SUMMARY pass=5 fail=0 skip=0 todo=0 tests=9 reported=9 "
                "files=1 runs=1 chunks_pass=1 chunks_fail=0\n"
            )

    def test_rejects_multiple_or_truncated_lane_summaries(self) -> None:
        line = (
            "CLOUDFLARE_TEST_SUMMARY pass=5 fail=0 skip=0 todo=0 tests=5 reported=5 "
            "files=1 runs=1 chunks_pass=1 chunks_fail=0\n"
        )
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            parse_bun_summary(line + line)
        with self.assertRaisesRegex(ValueError, "Malformed"):
            parse_bun_summary("CLOUDFLARE_TEST_SUMMARY pass=5 fail=0")

    def test_rejects_malformed_targeted_runner_records(self) -> None:
        with self.assertRaisesRegex(ValueError, "Malformed"):
            parse_bun_summary(
                "CLOUDFLARE_CI_TEST_COUNTS pass=5 fail=0 skip=0 todo=0 tests=5 reported=5\n"
                "CLOUDFLARE_TEST_SUMMARY pass=5 fail=0 skip=0 todo=0 tests=5 reported=5 "
                "files=1 runs=1 chunks_pass=1 chunks_fail=0\n"
            )

    def test_fails_closed_when_actual_lane_summary_is_missing(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing or malformed"):
            parse_bun_summary("Compilation error occurred before tests started\nexit code 1")

    def test_fails_closed_on_empty_log(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing or malformed"):
            parse_bun_summary("")
class TestPythonUnittestSummaryParser(unittest.TestCase):
    def test_parses_success_and_counts_skips(self) -> None:
        log = "Ran 3 tests in 0.004s\n\nOK (skipped=1)\n"
        self.assertEqual(
            parse_python_unittest_summary(log),
            {
                "pass": 2,
                "fail": 0,
                "skip": 1,
                "todo": 0,
                "tests": 3,
                "reported": 3,
                "files": 1,
                "runs": 1,
            },
        )

    def test_parses_failed_tests_and_skips(self) -> None:
        log = "Ran 4 tests in 0.010s\n\nFAILED (failures=1, errors=1, skipped=1)\n"
        self.assertEqual(
            parse_python_unittest_summary(log),
            {
                "pass": 1,
                "fail": 2,
                "skip": 1,
                "todo": 0,
                "tests": 4,
                "reported": 4,
                "files": 1,
                "runs": 1,
            },
        )

    def test_rejects_unparsable_output(self) -> None:
        with self.assertRaisesRegex(ValueError, "Ran count"):
            parse_python_unittest_summary("Compilation error; tests did not start\n")

    def test_parses_plain_ok_summary(self) -> None:
        log = "Ran 2 tests in 0.001s\n\nOK\n"
        self.assertEqual(
            parse_python_unittest_summary(log),
            {"pass": 2, "fail": 0, "skip": 0, "todo": 0, "tests": 2, "reported": 2, "files": 1, "runs": 1},
        )

    def test_fails_closed_when_zero_tests_ran(self) -> None:
        with self.assertRaisesRegex(ValueError, "Ran count"):
            parse_python_unittest_summary("Ran 0 tests in 0.000s\n\nOK\n")


class TestCfCiExactHeadValidation(unittest.TestCase):
    def test_accepts_matching_40_hex_sha(self) -> None:
        sha1 = "5646799e6ea503953b5029f414ff85cd39fb8e4b"
        sha2 = "5646799E6EA503953B5029F414FF85CD39FB8E4B"
        validate_exact_head(sha1, sha2)

    def test_rejects_sha_mismatch(self) -> None:
        sha1 = "5646799e6ea503953b5029f414ff85cd39fb8e4b"
        sha2 = "a22c571bc914a0c19883aecdb9fdf487815bb968"
        with self.assertRaises(CheckoutError) as ctx:
            validate_exact_head(sha1, sha2)
        self.assertIn("mismatch", str(ctx.exception).lower())

    def test_rejects_branch_name_as_sha(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            validate_exact_head("main", "5646799e6ea503953b5029f414ff85cd39fb8e4b")
        self.assertIn("40-character hex", str(ctx.exception))

    def test_extract_exact_head_from_log(self) -> None:
        log = "CLOUDFLARE_EXACT_HEAD sha=5646799e6ea503953b5029f414ff85cd39fb8e4b\n"
        sha = extract_exact_head(log)
        self.assertEqual(sha, "5646799e6ea503953b5029f414ff85cd39fb8e4b")

    def test_extract_head_from_commit_line(self) -> None:
        log = "Commit: 5646799e6ea503953b5029f414ff85cd39fb8e4b\n"
        sha = extract_exact_head(log)
        self.assertEqual(sha, "5646799e6ea503953b5029f414ff85cd39fb8e4b")


class TestCfCiGithubTokenFallback(unittest.TestCase):
    def test_reads_gh_cli_token_when_no_env_token_is_set(self) -> None:
        sha = "5646799e6ea503953b5029f414ff85cd39fb8e4b"
        gh_token = subprocess.CompletedProcess(["gh", "auth", "token"], 0, stdout="gh-cli-token\n", stderr="")
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"id": 7}'
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
            "cf_ci.subprocess.run", return_value=gh_token
        ) as run, mock.patch("cf_ci.urllib.request.urlopen", return_value=response) as urlopen:
            res = publish_github_commit_status(
                owner="Wladefant",
                repo="veyyon",
                sha=sha,
                state="success",
                description="ok",
            )
        run.assert_called_once()
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer gh-cli-token")
        self.assertEqual(res, {"id": 7})


class TestCfCiVerifyOutputLabels(unittest.TestCase):
    SHA = "5646799e6ea503953b5029f414ff85cd39fb8e4b"

    def test_verify_prints_aggregate_test_labels(self) -> None:
        build = {
            "status": "stopped",
            "build_outcome": "success",
            "script_tag": "ci",
            "build_trigger_metadata": {"commit_hash": self.SHA},
        }
        log = (
            f"CLOUDFLARE_EXACT_HEAD sha={self.SHA}\n"
            "CLOUDFLARE_TEST_SUMMARY pass=3 fail=0 skip=1 todo=0 tests=4 reported=4 "
            "files=1 runs=1 chunks_pass=1 chunks_fail=0\n"
        )
        stdout = StringIO()
        with mock.patch("cf_ci.wait_for_cloudflare_build", return_value=build), mock.patch(
            "cf_ci.fetch_cloudflare_build_log", return_value=log
        ), mock.patch("cf_ci.publish_github_commit_status", return_value={}), redirect_stdout(stdout):
            exit_code = cf_ci_main(
                ["verify", "--build-id", "build-1", "--expected-sha", self.SHA, "--account-id", "acc-1"]
            )
        self.assertEqual(exit_code, 0)
        lines = stdout.getvalue().splitlines()
        self.assertIn("tests_passed=3 tests_failed=0 tests_skipped=1", lines)
        self.assertFalse(any(line.startswith("bun_") for line in lines))

class TestCfCiVerifyRefusesPassWithoutStatusPublication(unittest.TestCase):
    SHA = "5646799e6ea503953b5029f414ff85cd39fb8e4b"
    VERIFY_ARGS = ["verify", "--build-id", "build-1", "--expected-sha", SHA, "--account-id", "acc-1"]

    def test_missing_cloudflare_token_fails_before_any_request(self) -> None:
        stdout, stderr = StringIO(), StringIO()
        no_gh_token = subprocess.CompletedProcess(["gh", "auth", "token"], 1, stdout="", stderr="")
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
            "cf_ci.subprocess.run", return_value=no_gh_token
        ), mock.patch("cf_ci.urllib.request.urlopen") as urlopen, redirect_stdout(stdout), redirect_stderr(stderr):
            exit_code = cf_ci_main(self.VERIFY_ARGS)
        urlopen.assert_not_called()
        self.assertEqual(exit_code, 1)
        self.assertNotIn("gate=PASS", stdout.getvalue())
        self.assertIn("No Cloudflare API token", stderr.getvalue())

    def test_passing_build_with_skipped_status_publication_exits_nonzero(self) -> None:
        build = {
            "status": "stopped",
            "build_outcome": "success",
            "script_tag": "ci",
            "build_trigger_metadata": {"commit_hash": self.SHA},
        }
        log = (
            f"CLOUDFLARE_EXACT_HEAD sha={self.SHA}\n"
            "CLOUDFLARE_TEST_SUMMARY pass=3 fail=0 skip=0 todo=0 tests=3 reported=3 "
            "files=1 runs=1 chunks_pass=1 chunks_fail=0\n"
        )
        no_gh_token = subprocess.CompletedProcess(["gh", "auth", "token"], 1, stdout="", stderr="")
        stdout, stderr = StringIO(), StringIO()
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
            "cf_ci.wait_for_cloudflare_build", return_value=build
        ), mock.patch("cf_ci.fetch_cloudflare_build_log", return_value=log), mock.patch(
            "cf_ci.subprocess.run", return_value=no_gh_token
        ), mock.patch("cf_ci.urllib.request.urlopen") as urlopen, redirect_stdout(stdout), redirect_stderr(stderr):
            exit_code = cf_ci_main(self.VERIFY_ARGS)
        urlopen.assert_not_called()
        self.assertEqual(exit_code, 1)
        self.assertNotIn("gate=PASS", stdout.getvalue())
        self.assertIn("gate=FAIL", stderr.getvalue())
        self.assertIn("not published", stderr.getvalue())



class TestCfCiGithubCommitStatus(unittest.TestCase):
    def test_refuses_branch_tip_or_symbolic_ref(self) -> None:
        for invalid_ref in ["main", "origin/main", "HEAD", "refs/heads/main", "feat/ci"]:
            with self.assertRaises(ValueError) as ctx:
                publish_github_commit_status(
                    owner="Wladefant",
                    repo="veyyon",
                    sha=invalid_ref,
                    state="success",
                    description="test",
                )
            self.assertIn("refusing branch tip or ref", str(ctx.exception))

    def test_refuses_invalid_state(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            publish_github_commit_status(
                owner="Wladefant",
                repo="veyyon",
                sha="5646799e6ea503953b5029f414ff85cd39fb8e4b",
                state="passed",  # Invalid GitHub status state (must be success/failure/pending/error)
                description="test",
            )
        self.assertIn("Invalid commit status state", str(ctx.exception))

    def test_formats_status_payload_correctly_when_token_skipped(self) -> None:
        sha = "5646799e6ea503953b5029f414ff85cd39fb8e4b"
        no_gh_token = subprocess.CompletedProcess(["gh", "auth", "token"], 1, stdout="", stderr="")
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
            "cf_ci.subprocess.run", return_value=no_gh_token
        ), mock.patch("cf_ci.urllib.request.urlopen") as urlopen:
            res = publish_github_commit_status(
                owner="Wladefant",
                repo="veyyon",
                sha=sha,
                state="success",
                description="pass=31759 fail=0 skip=16",
                target_url="https://dash.cloudflare.com/build/123",
            )
        urlopen.assert_not_called()
        self.assertEqual(res["status"], "skipped")
        self.assertEqual(res["payload"]["state"], "success")
        self.assertEqual(res["payload"]["context"], "Workers Builds: veyyon-ci")
        self.assertEqual(res["payload"]["description"], "pass=31759 fail=0 skip=16")
        self.assertEqual(res["payload"]["target_url"], "https://dash.cloudflare.com/build/123")


if __name__ == "__main__":
    unittest.main()
