#!/usr/bin/env python3
"""Cloudflare Workers Builds CI lane adapter for Veyyon (Bun test suite).

Verifies Cloudflare Workers Builds execution, parses Bun test totals (pass/fail/skip),
fails closed on missing or malformed counts, validates exact checked-out SHA,
and reports GitHub commit statuses bound to the exact commit SHA (never branch tip).
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

API = "https://api.cloudflare.com/client/v4"
ACCOUNT_DEFAULT = "a0d288d1c95470cd009cc6e0df7accb7"
API_TIMEOUT = 25
SHA40_RE = re.compile(r"^[0-9a-fA-F]{40}$")


class CheckoutError(ValueError):
    """Raised when the local or remote checkout violates exact-SHA or safety bounds."""
    pass


class BuildError(RuntimeError):
    """Raised when a Cloudflare build fails, times out, or produces invalid output."""
    pass


def parse_bun_summary(log: str) -> Dict[str, int]:
    """Parse Bun test totals from build log, failing closed on missing or malformed counts.

    Looks for CLOUDFLARE_TEST_TOTALS first, then falls back to Bun's runner lines.
    Fails closed (raises ValueError) if neither format is found or numbers are missing.
    """
    totals_match = re.search(
        r"CLOUDFLARE_TEST_TOTALS\s+pass=(\d+)\s+fail=(\d+)\s+skip=(\d+)(?:\s+todo=(\d+))?(?:\s+total=(\d+))?",
        log,
    )
    if totals_match:
        p = int(totals_match.group(1))
        f = int(totals_match.group(2))
        s = int(totals_match.group(3))
        todo = int(totals_match.group(4)) if totals_match.group(4) else 0
        total = int(totals_match.group(5)) if totals_match.group(5) else (p + f + s + todo)
        return {"pass": p, "fail": f, "skip": s, "todo": todo, "total": total}

    clean = re.sub(r"\x1b\[[0-9;]*m", "", log)
    p_m = re.findall(r"^\s*(\d+)\s+pass", clean, re.MULTILINE)
    f_m = re.findall(r"^\s*(\d+)\s+fail", clean, re.MULTILINE)
    s_m = re.findall(r"^\s*(\d+)\s+skip", clean, re.MULTILINE)

    if p_m or f_m:
        p = int(p_m[-1]) if p_m else 0
        f = int(f_m[-1]) if f_m else 0
        s = int(s_m[-1]) if s_m else 0
        return {"pass": p, "fail": f, "skip": s, "todo": 0, "total": p + f + s}

    raise ValueError("Bun test summary missing or malformed in log: expected CLOUDFLARE_TEST_TOTALS or standard pass/fail summary")


def extract_exact_head(log: str) -> Optional[str]:
    """Extract exact commit SHA from Cloudflare build log."""
    m = re.search(r"CLOUDFLARE_EXACT_HEAD\s+sha=([0-9a-fA-F]{40})", log)
    if m:
        return m.group(1).lower()
    m2 = re.search(r"Commit:\s*([0-9a-fA-F]{40})", log)
    if m2:
        return m2.group(1).lower()
    return None


def validate_exact_head(expected_sha: str, actual_sha: str) -> None:
    """Refuse mismatched SHAs; guarantees report is bound to exact checked-out SHA."""
    if not SHA40_RE.match(expected_sha):
        raise ValueError(f"expected_sha must be a 40-character hex commit SHA, got: {expected_sha!r}")
    if not SHA40_RE.match(actual_sha):
        raise ValueError(f"actual_sha must be a 40-character hex commit SHA, got: {actual_sha!r}")
    if expected_sha.lower() != actual_sha.lower():
        raise CheckoutError(f"Exact head mismatch: expected {expected_sha.lower()}, got {actual_sha.lower()}")


def publish_github_commit_status(
    owner: str,
    repo: str,
    sha: str,
    state: str,
    description: str,
    target_url: str = "",
    context: str = "Workers Builds: veyyon-ci",
    token: Optional[str] = None,
) -> Dict[str, Any]:
    """Publish a commit status to GitHub REST API bound strictly to exact commit SHA.

    Refuses branch names or symbolic references to avoid accidentally reporting on branch tip.
    """
    if not SHA40_RE.match(sha):
        raise ValueError(f"sha must be a 40-character hex commit SHA (refusing branch tip or ref): {sha!r}")

    if state not in ("success", "failure", "pending", "error"):
        raise ValueError(f"Invalid commit status state: {state!r}")

    github_token = token or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not github_token:
        # Try reading from gh CLI config or return simulated payload if no token available
        try:
            p = subprocess.run(["gh", "auth", "token"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
            if p.returncode == 0 and p.stdout.strip():
                github_token = p.stdout.strip()
        except Exception:
            pass

    payload = {
        "state": state,
        "context": context,
        "description": description[:140],
    }
    if target_url:
        payload["target_url"] = target_url

    if not github_token:
        return {"status": "skipped", "reason": "no_github_token", "payload": payload, "sha": sha}

    url = f"https://api.github.com/repos/{owner}/{repo}/statuses/{sha}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {github_token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "Veyyon-Cloudflare-CI/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_cloudflare_token() -> Optional[str]:
    """Load Cloudflare token from standard shared-auth locations."""
    candidates = [
        Path.home() / ".veyyon/shared-auth/cloudflare_polysim_builds_user_token.txt",
        Path.home() / ".veyyon/shared-auth/cloudflare_polysim_builds_token.txt",
        Path.home() / ".veyyon/shared-auth/cloudflare_shared_builds_token.txt",
    ]
    for c in candidates:
        if c.is_file():
            val = c.read_text(encoding="utf-8").strip()
            if val:
                return val
    return os.environ.get("CLOUDFLARE_API_TOKEN")


def query_cloudflare_build(
    build_id: str,
    account_id: str = ACCOUNT_DEFAULT,
    token: Optional[str] = None,
) -> Dict[str, Any]:
    """Query Cloudflare API for build status and metadata."""
    cf_token = token or load_cloudflare_token()
    if not cf_token:
        raise BuildError("No Cloudflare API token available to query build")

    url = f"{API}/accounts/{account_id}/builds/builds/{build_id}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {cf_token}", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=API_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8")).get("result", {})


def fetch_cloudflare_build_log(
    build_id: str,
    account_id: str = ACCOUNT_DEFAULT,
    token: Optional[str] = None,
) -> str:
    """Fetch Cloudflare build log lines and concatenate into full log string."""
    cf_token = token or load_cloudflare_token()
    if not cf_token:
        raise BuildError("No Cloudflare API token available to fetch build log")

    url = f"{API}/accounts/{account_id}/builds/builds/{build_id}/logs"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {cf_token}", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=API_TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        lines = data.get("result", {}).get("lines", [])
        return "\n".join(l[1] if isinstance(l, list) and len(l) > 1 else str(l) for l in lines)


def parse_cli_args(args: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="subcommand", required=True)

    p_parse = sub.add_parser("parse-summary", help="Parse Bun test totals from log text or file")
    p_parse.add_argument("--file", help="Path to log file (reads stdin if omitted)")

    p_status = sub.add_parser("report-status", help="Publish GitHub commit status bound to exact SHA")
    p_status.add_argument("--sha", required=True, help="Exact 40-char commit SHA")
    p_status.add_argument("--state", required=True, choices=["success", "failure", "pending", "error"])
    p_status.add_argument("--description", required=True, help="Status description")
    p_status.add_argument("--target-url", default="", help="Target URL (e.g. build logs)")
    p_status.add_argument("--repo", default="Wladefant/veyyon", help="GitHub owner/repo")

    p_verify = sub.add_parser("verify", help="Verify remote Cloudflare build and publish commit status")
    p_verify.add_argument("--build-id", required=True, help="Cloudflare build UUID")
    p_verify.add_argument("--expected-sha", required=True, help="Expected exact 40-char commit SHA")
    p_verify.add_argument("--repo", default="Wladefant/veyyon", help="GitHub owner/repo")
    p_verify.add_argument("--account-id", default=ACCOUNT_DEFAULT, help="Cloudflare account ID")

    return parser.parse_args(args)


def main(args: Optional[List[str]] = None) -> int:
    ns = parse_cli_args(args)

    if ns.subcommand == "parse-summary":
        if ns.file:
            content = Path(ns.file).read_text(encoding="utf-8")
        else:
            content = sys.stdin.read()
        try:
            counts = parse_bun_summary(content)
            print(json.dumps(counts, indent=2))
            return 0 if counts.get("fail", 0) == 0 and counts.get("pass", 0) > 0 else 1
        except Exception as e:
            sys.stderr.write(f"ERROR: {e}\n")
            return 1

    if ns.subcommand == "report-status":
        owner, repo = ns.repo.split("/", 1)
        res = publish_github_commit_status(
            owner=owner,
            repo=repo,
            sha=ns.sha,
            state=ns.state,
            description=ns.description,
            target_url=ns.target_url,
        )
        print(json.dumps(res, indent=2))
        return 0

    if ns.subcommand == "verify":
        owner, repo = ns.repo.split("/", 1)
        build = query_cloudflare_build(ns.build_id, account_id=ns.account_id)
        status = build.get("status")
        outcome = build.get("outcome")

        log = fetch_cloudflare_build_log(ns.build_id, account_id=ns.account_id)
        actual_sha = extract_exact_head(log) or build.get("commit_hash", "")
        validate_exact_head(ns.expected_sha, actual_sha)

        counts = parse_bun_summary(log)
        passed = counts.get("pass", 0)
        failed = counts.get("fail", 0)
        skipped = counts.get("skip", 0)

        gate = "PASS" if status == "success" and outcome == "success" and failed == 0 and passed > 0 else "FAIL"
        logs_url = f"https://dash.cloudflare.com/{ns.account_id}/workers/services/view/{build.get('script_tag', 'ci')}/production/builds/{ns.build_id}"

        publish_github_commit_status(
            owner=owner,
            repo=repo,
            sha=ns.expected_sha,
            state="success" if gate == "PASS" else "failure",
            description=f"Bun test {gate}: pass={passed} fail={failed} skip={skipped} (exact head {ns.expected_sha[:8]})",
            target_url=logs_url,
        )

        print(f"gate={gate} build_id={ns.build_id} head={ns.expected_sha} outcome={outcome} logs={logs_url}")
        print(f"bun_passed={passed} bun_failed={failed} bun_skipped={skipped}")
        return 0 if gate == "PASS" else 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
