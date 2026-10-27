#!/usr/bin/env python3
"""Dispatch a pinned main-branch commit to an existing Workers Builds trigger.

The host scheduler checks out the repository's main branch, then runs this file.
Required environment: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_TRIGGER_ID,
CLOUDFLARE_WORKER_TAG, and CLOUDFLARE_API_TOKEN. The worker tag scopes receipt
lookup; the script does not create triggers or deploy Workers.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
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

BUILD_RECEIPT_WAIT_SECONDS = 60
BUILD_RECEIPT_POLL_SECONDS = 5


def ensure_nightly_branch(branch: str, commit_hash: str, git_runner=None) -> None:
    """Create or fast-forward the nightly ref; never force-move it."""
    run = git_runner or subprocess.run
    check = run(
        ["git", "ls-remote", "--exit-code", "--heads", "origin", branch],
        capture_output=True,
        text=True,
        check=False,
    )
    if check.returncode == 2:
        remote_hash = ""
    elif check.returncode != 0:
        raise OSError(f"git ls-remote failed with exit {check.returncode}; nightly ref state is unknown")
    else:
        fields = check.stdout.split()
        if (
            len(fields) != 2
            or fields[1] != f"refs/heads/{branch}"
            or not SHA40_RE.fullmatch(fields[0].lower())
        ):
            raise OSError("git ls-remote returned an ambiguous nightly ref")
        remote_hash = fields[0].lower()
    if remote_hash != commit_hash:
        run(
            ["git", "push", "origin", f"{commit_hash}:refs/heads/{branch}"],
            check=True,
            capture_output=True,
            text=True,
        )


def _parse_utc(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _matching_build_receipt(
    result: object,
    commit_hash: str,
    branch: str,
    invocation_started: datetime,
) -> dict | None:
    if not isinstance(result, list):
        raise ValueError("Workers Builds list response did not contain a result array")
    matching: list[tuple[datetime, dict]] = []
    for build in result:
        if not isinstance(build, dict):
            continue
        metadata = build.get("build_trigger_metadata")
        if not isinstance(metadata, dict):
            continue
        created_on = _parse_utc(build.get("created_on"))
        build_uuid = build.get("build_uuid")
        if (
            created_on is not None
            and created_on >= invocation_started
            and metadata.get("branch") == branch
            and isinstance(metadata.get("commit_hash"), str)
            and metadata["commit_hash"].lower() == commit_hash
            and isinstance(build_uuid, str)
            and build_uuid
        ):
            matching.append((created_on, {"build_uuid": build_uuid, "created_on": build["created_on"]}))
    return max(matching, key=lambda item: item[0])[1] if matching else None


def find_nightly_build_receipt(
    account_id: str,
    worker_tag: str,
    token: str,
    commit_hash: str,
    invocation_started: datetime,
    *,
    timeout_seconds: int = BUILD_RECEIPT_WAIT_SECONDS,
    poll_seconds: int = BUILD_RECEIPT_POLL_SECONDS,
    opener=None,
    monotonic=None,
    sleeper=None,
) -> dict | None:
    open_url = opener or urllib.request.urlopen
    now = monotonic or time.monotonic
    sleep = sleeper or time.sleep
    deadline = now() + timeout_seconds
    page = 1
    while True:
        remaining = deadline - now()
        if remaining <= 0:
            if page == 1:
                return None
            raise TimeoutError("timed out before the Workers Builds receipt scan completed")
        url = (
            f"{API}/accounts/{account_id}/builds/workers/{worker_tag}/builds"
            f"?page={page}&per_page=200"
        )
        request = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            method="GET",
        )
        with open_url(request, timeout=min(10, remaining)) as response:
            body = json.loads(response.read().decode("utf-8"))
        if not isinstance(body, dict) or body.get("success") is not True:
            raise ValueError("Cloudflare build listing returned an invalid response")
        receipt = _matching_build_receipt(body.get("result"), commit_hash, NIGHTLY_BRANCH, invocation_started)
        if receipt is not None:
            return receipt
        pagination = body.get("result_info")
        total_pages = pagination.get("total_pages") if isinstance(pagination, dict) else None
        if isinstance(total_pages, bool) or not isinstance(total_pages, int) or total_pages < 0:
            raise ValueError("Cloudflare build listing omitted valid pagination metadata")
        if page < total_pages:
            page += 1
            continue
        remaining = deadline - now()
        if remaining <= 0:
            return None
        sleep(min(poll_seconds, remaining))
        page = 1


def _dispatch_build(account_id: str, trigger_id: str, token: str, commit_hash: str) -> dict:
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
        raise OSError(f"Cloudflare build dispatch failed: HTTP {error.code}") from error
    if body.get("success") is not True:
        raise ValueError("Cloudflare build dispatch returned success=false")
    result = body.get("result")
    if not isinstance(result, dict) or not result.get("build_uuid") or not result.get("created_on"):
        raise ValueError("Cloudflare accepted no complete build receipt")
    return {"build_uuid": result["build_uuid"], "created_on": result["created_on"]}


def main() -> int:
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    trigger_id = os.environ.get("CLOUDFLARE_TRIGGER_ID", "")
    worker_tag = os.environ.get("CLOUDFLARE_WORKER_TAG", "")
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if not account_id or not trigger_id or not worker_tag or not token:
        raise ValueError(
            "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_TRIGGER_ID, CLOUDFLARE_WORKER_TAG, "
            "and CLOUDFLARE_API_TOKEN are required"
        )

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

    invocation_started = datetime.now(timezone.utc)
    utc_day = invocation_started.date().isoformat()
    if not claim_once_per_utc_day(state_root_from_environment(), utc_day):
        print(f"dispatch=skipped reason=already-dispatched utc_date={utc_day}")
        return 0

    ensure_nightly_branch(NIGHTLY_BRANCH, commit_hash)
    # Receipt dedupe enforces the no-double-nightly-dispatch rule: a push-created build
    # with this fresh, pinned full-run identity replaces an API POST.
    receipt = find_nightly_build_receipt(
        account_id, worker_tag, token, commit_hash, invocation_started
    )
    source = "git"
    if receipt is None:
        receipt = _dispatch_build(account_id, trigger_id, token, commit_hash)
        source = "api"
    print(
        f"dispatch=accepted branch={NIGHTLY_BRANCH} commit_hash={commit_hash} "
        f"build_uuid={receipt['build_uuid']} created_on={receipt['created_on']} source={source}"
    )
    verification = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).with_name("cf_ci.py")),
            "verify",
            "--build-id",
            str(receipt["build_uuid"]),
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
