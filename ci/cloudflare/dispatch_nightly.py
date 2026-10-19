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

API = "https://api.cloudflare.com/client/v4"
SHA40_RE = re.compile(r"^[0-9a-f]{40}$")


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

    payload = json.dumps({"branch": branch, "commit_hash": commit_hash}).encode()
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
    print(f"dispatch=accepted branch={branch} commit_hash={commit_hash} build_id={build_id}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
