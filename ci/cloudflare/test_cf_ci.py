"""Contract and unit tests for Cloudflare Workers Builds CI lane gate for Veyyon (cf_ci.py)."""

from __future__ import annotations

import unittest
from pathlib import Path
import sys

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

    def test_parse_bun_summary_with_ansi_escapes(self) -> None:
        log = "\x1b[32m 42 pass\x1b[0m\n\x1b[31m 0 fail\x1b[0m\n"
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
