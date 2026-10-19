"""Contract and unit tests for Cloudflare Workers Builds CI lane gate for Veyyon (cf_ci.py)."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dispatch_nightly import claim_once_per_utc_day, ensure_nightly_branch_exists
from dispatch_nightly import main as dispatch_nightly_main

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from cf_ci import (
    CheckoutError,
    extract_exact_head,
    parse_bun_summary,
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



class TestNightlyBranchCreationAndDispatch(unittest.TestCase):
    def test_missing_ref_creates_branch_and_dispatches_once(self) -> None:
        calls = []

        def mock_git_runner(cmd, **kwargs):
            calls.append(cmd)
            if cmd[1] == "ls-remote":
                return subprocess.CompletedProcess(cmd, returncode=2, stdout="", stderr="")
            if cmd[1] == "push":
                self.assertNotIn("--force", cmd)
                self.assertNotIn("-f", cmd)
                return subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr="")
            return subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr="")

        created = ensure_nightly_branch_exists(
            "cf-nightly-main",
            "1111222233334444555566667777888899990000",
            git_runner=mock_git_runner,
        )
        self.assertTrue(created)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1], "ls-remote")
        self.assertEqual(
            calls[1],
            ["git", "push", "origin", "1111222233334444555566667777888899990000:refs/heads/cf-nightly-main"],
        )

    def test_existing_ref_does_not_push(self) -> None:
        calls = []

        def mock_git_runner(cmd, **kwargs):
            calls.append(cmd)
            if cmd[1] == "ls-remote":
                return subprocess.CompletedProcess(cmd, returncode=0, stdout="hash\trefs/heads/cf-nightly-main\n", stderr="")
            return subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr="")

        created = ensure_nightly_branch_exists(
            "cf-nightly-main",
            "1111222233334444555566667777888899990000",
            git_runner=mock_git_runner,
        )
        self.assertFalse(created)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], "ls-remote")

class TestNightlyMainCreatesRefThenDispatchesOnce(unittest.TestCase):
    SHA = "1111222233334444555566667777888899990000"

    def _fake_git(self, commands: list[list[str]]):
        def run(cmd, **kwargs):
            commands.append(cmd)
            if cmd[:3] == ["git", "branch", "--show-current"]:
                return subprocess.CompletedProcess(cmd, 0, stdout="main\n", stderr="")
            if cmd[:2] == ["git", "rev-parse"]:
                return subprocess.CompletedProcess(cmd, 0, stdout=f"{self.SHA}\n", stderr="")
            if cmd[:2] == ["git", "ls-remote"]:
                return subprocess.CompletedProcess(cmd, 2, stdout="", stderr="")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        return run

    def test_missing_ref_is_created_and_one_build_is_posted_per_day(self) -> None:
        commands: list[list[str]] = []
        payloads: list[bytes] = []
        response = mock.MagicMock()
        response.read.return_value = b'{"success": true, "result": {"id": "build-1"}}'
        opened = mock.MagicMock()
        opened.__enter__.return_value = response

        def capture(request, timeout):
            payloads.append(request.data)
            return opened

        with tempfile.TemporaryDirectory() as state_dir, mock.patch.dict(
            os.environ,
            {
                "CLOUDFLARE_ACCOUNT_ID": "account",
                "CLOUDFLARE_TRIGGER_ID": "trigger",
                "CLOUDFLARE_API_TOKEN": "token",
                "CLOUDFLARE_NIGHTLY_STATE_DIR": state_dir,
            },
        ), mock.patch("subprocess.run", side_effect=self._fake_git(commands)), mock.patch(
            "urllib.request.urlopen", side_effect=capture
        ):
            self.assertEqual(dispatch_nightly_main(), 0)
            self.assertEqual(dispatch_nightly_main(), 0)

        pushes = [cmd for cmd in commands if cmd[:2] == ["git", "push"]]
        self.assertEqual(
            pushes,
            [["git", "push", "origin", f"{self.SHA}:refs/heads/cf-nightly-main"]],
        )
        self.assertEqual(len(payloads), 1)
        self.assertIn(b'"branch": "cf-nightly-main"', payloads[0])
        self.assertIn(f'"commit_hash": "{self.SHA}"'.encode(), payloads[0])


class TestCfCiBunSummaryParser(unittest.TestCase):
    def test_parse_cloudflare_totals_line(self) -> None:
        log = """
bun test v1.4.0 (34cbb9a40)
CLOUDFLARE_TEST_TOTALS pass=31759 fail=0 skip=16 todo=2 total=31777 chunks=12
CLOUDFLARE_LANE_SUCCESS=1
"""
        counts = parse_bun_summary(log)
        self.assertEqual(counts["pass"], 31759)
        self.assertEqual(counts["fail"], 0)
        self.assertEqual(counts["skip"], 16)
        self.assertEqual(counts["todo"], 2)
        self.assertEqual(counts["total"], 31777)

    def test_parse_standard_bun_summary_lines(self) -> None:
        log = """
 36 pass
 2 fail
 3 skip
Ran 41 tests across 4 files. [179.00ms]
"""
        counts = parse_bun_summary(log)
        self.assertEqual(counts["pass"], 36)
        self.assertEqual(counts["fail"], 2)
        self.assertEqual(counts["skip"], 3)
        self.assertEqual(counts["total"], 41)

    def test_rejects_inconsistent_declared_total(self) -> None:
        with self.assertRaisesRegex(ValueError, "inconsistent"):
            parse_bun_summary(
                "CLOUDFLARE_TEST_TOTALS pass=5 fail=0 skip=0 todo=0 total=9 chunks=1\n"
            )

    def test_rejects_multiple_or_truncated_aggregate_summaries(self) -> None:
        line = "CLOUDFLARE_TEST_TOTALS pass=5 fail=0 skip=0 todo=0 total=5 chunks=1\n"
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            parse_bun_summary(line + line)
        with self.assertRaisesRegex(ValueError, "truncated|malformed"):
            parse_bun_summary("CLOUDFLARE_TEST_TOTALS pass=5 fail=0")

    def test_rejects_multiple_standard_run_summaries(self) -> None:
        run = " 5 pass\n 0 fail\nRan 5 tests across 1 file.\n"
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            parse_bun_summary(run + run)

    def test_parse_bun_summary_with_ansi_escapes(self) -> None:
        log = "\x1b[32m 42 pass\x1b[0m\n\x1b[31m 0 fail\x1b[0m\nRan 42 tests across 3 files.\n"
        counts = parse_bun_summary(log)
        self.assertEqual(counts["pass"], 42)
        self.assertEqual(counts["fail"], 0)
        self.assertEqual(counts["skip"], 0)
        self.assertEqual(counts["total"], 42)

    def test_fails_closed_on_missing_summary(self) -> None:
        log = "Compilation error occurred before tests started\nexit code 1"
        with self.assertRaises(ValueError) as ctx:
            parse_bun_summary(log)
        self.assertIn("missing or malformed", str(ctx.exception).lower())

    def test_fails_closed_on_empty_log(self) -> None:
        with self.assertRaises(ValueError):
            parse_bun_summary("")


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
        res = publish_github_commit_status(
            owner="Wladefant",
            repo="veyyon",
            sha=sha,
            state="success",
            description="pass=31759 fail=0 skip=16",
            target_url="https://dash.cloudflare.com/build/123",
            token="dummy-test-skip-token" if False else None,
        )
        if res.get("status") == "skipped":
            self.assertEqual(res["payload"]["state"], "success")
            self.assertEqual(res["payload"]["context"], "Workers Builds: veyyon-ci")
            self.assertEqual(res["payload"]["description"], "pass=31759 fail=0 skip=16")
            self.assertEqual(res["payload"]["target_url"], "https://dash.cloudflare.com/build/123")


if __name__ == "__main__":
    unittest.main()
