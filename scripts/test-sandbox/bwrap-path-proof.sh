#!/usr/bin/env bash
# Exercise the WSL inherited-PATH case through the real bwrap boundary. It sets PATH to a Windows-only value, as `wsl --exec` leaves it, then checks that bun, git and sh still resolve inside the sandbox and that the host home stays absent.
# Usage: bash scripts/test-sandbox/bwrap-path-proof.sh   (Linux or WSL with bubblewrap; prints `bwrap PATH proof: PASS` on success)
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && /bin/pwd -P)"
HOST_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
SANDBOX_GITDIR=""
BWRAP_BIN="$(command -v bwrap)"
. "${SCRIPT_DIR}/rungs/bwrap.sh"
# WSL --exec may inherit only Windows paths. Keep bwrap callable while removing
# Linux tools from PATH, as happens in that invocation.
bwrap() { "${BWRAP_BIN}" "$@"; }
export PATH=/windows-only
probe_output="$(binprobe_bwrap 'for b in bun git sh; do command -v "$b" || exit 1; done')"
printf '%s\n' "$probe_output"
run_bwrap /bin/sh -c '
set -e
for b in bun git sh; do command -v "$b"; done
[ ! -e "$VEYYON_TEST_HOST_HOME" ]
[ "$VEYYON_TEST_SANDBOX" = bwrap-userns ]
'
printf 'bwrap PATH proof: PASS\n'
