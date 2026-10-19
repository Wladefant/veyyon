#!/usr/bin/env python3
"""Dispatch a pinned main-branch commit to an existing Workers Builds trigger.

The host scheduler checks out the repository's main branch, then runs this file.
Required environment: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_TRIGGER_ID, CLOUDFLARE_API_TOKEN.
The script sends only branch and commit_hash; it does not create triggers or deploy Workers.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

NIGHTLY_BRANCH = Path(__file__).with_name("nightly-branch.txt").read_text(encoding="utf-8").strip()
if not NIGHTLY_BRANCH:
    raise ValueError("nightly-branch.txt must name a branch")


def claim_once_per_utc_day(state_root: Path, utc_day: str) -> bool:
    state_root.mkdir(parents=True, exist_ok=True)
    claim = state_root / f"nightly-{utc_day}.claimed"
    try:
        descriptor = os.open(claim, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(descriptor, "w", encoding="utf-8") as state:
        state.write(f"claimed_at_utc={datetime.now(timezone.utc).isoformat()}\n")
    return True


def state_root_from_environment() -> Path:
    configured = os.environ.get("CLOUDFLARE_NIGHTLY_STATE_DIR")
    if configured:
        return Path(configured)
    return Path.home() / ".veyyon" / "run" / "nightly-cloudflare-ci"


def current_utc_day() -> str:
    return datetime.now(timezone.utc).date().isoformat()



API = "https://api.cloudflare.com/client/v4"
SHA40_RE = re.compile(r"^[0-9a-f]{40}$")


def ensure_nightly_branch_exists(branch: str, commit_hash: str, git_runner=None) -> bool:
    """Create the nightly ref at the pinned commit when it is missing; never force-move it.

    `git ls-remote --exit-code` exits 2 only when no matching head exists. Any other failure
    raises, so a network error is never read as "missing" and never leads to a push.
    """
    run = git_runner or subprocess.run
    check = run(
        ["git", "ls-remote", "--exit-code", "--heads", "origin", branch],
        capture_output=True,
        text=True,
        check=False,
    )
    if check.returncode == 0:
        return False
    if check.returncode != 2:
        raise OSError(f"git ls-remote failed with exit {check.returncode}; nightly ref state is unknown")
    run(
        ["git", "push", "origin", f"{commit_hash}:refs/heads/{branch}"],
        check=True,
        capture_output=True,
        text=True,
    )
    return True


def main() -> int:
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    trigger_id = os.environ.get("CLOUDFLARE_TRIGGER_ID", "")
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if not account_id or not trigger_id or not token:
        raise ValueError("CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_TRIGGER_ID, and CLOUDFLARE_API_TOKEN are required")

    branch = subprocess.run(
        ["git", "branch", "--show-current"], check=True, capture_output=True, text=True
    ).stdout.strip()
    if branch != "main":
        raise ValueError(f"nightly dispatcher requires a main checkout, got {branch!r}")
    commit_hash = subprocess.run(
        ["git", "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip().lower()
    if not SHA40_RE.fullmatch(commit_hash):
        raise ValueError("git returned an invalid commit hash")

    utc_day = current_utc_day()
    if not claim_once_per_utc_day(state_root_from_environment(), utc_day):
        print(f"dispatch=skipped reason=already-dispatched utc_date={utc_day}")
        return 0

    ensure_nightly_branch_exists(NIGHTLY_BRANCH, commit_hash)

    payload = json.dumps({"branch": NIGHTLY_BRANCH, "commit_hash": commit_hash}).encode()
    request = urllib.request.Request(
        f"{API}/accounts/{account_id}/builds/triggers/{trigger_id}/builds",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        print(f"Cloudflare build dispatch failed: HTTP {error.code}", file=sys.stderr)
        return 1
    if body.get("success") is not True:
        print("Cloudflare build dispatch returned success=false", file=sys.stderr)
        return 1
    result = body.get("result") or {}
    build_id = result.get("id") or result.get("build_uuid")
    if not build_id:
        print("Cloudflare accepted no build identifier in the response", file=sys.stderr)
        return 1
    print(f"dispatch=accepted branch={NIGHTLY_BRANCH} commit_hash={commit_hash} build_id={build_id}")
    verification = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).with_name("cf_ci.py")),
            "verify",
            "--build-id",
            str(build_id),
            "--expected-sha",
            commit_hash,
            "--account-id",
            account_id,
        ],
        check=False,
        timeout=23 * 60,
    )
    return verification.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
