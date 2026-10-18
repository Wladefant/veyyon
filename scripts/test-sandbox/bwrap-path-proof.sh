#!/usr/bin/env bash
# Exercise the WSL inherited-PATH case through the real bwrap boundary.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && /bin/pwd -P)"
GUEST_REPO=/srv/veyyon
HOST_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
HOST_BUN="$(bun -e 'process.stdout.write(process.execPath)')"
HOST_BUN="$(readlink -f -- "$HOST_BUN")"
if [ ! -x "$HOST_BUN" ]; then
	printf 'FATAL: host Bun is not executable: %s\n' "$HOST_BUN" >&2
	exit 1
fi
if [ ! -e "$HOST_HOME/bun" ]; then
	ln "$HOST_BUN" "$HOST_HOME/bun"
fi
HOST_BUN_HOME_PATH="$(readlink -f -- "$HOST_HOME/bun")"
if [ "$HOST_BUN_HOME_PATH" != "$HOST_HOME/bun" ] || [ ! -x "$HOST_HOME/bun" ]; then
	printf 'FATAL: %s/bun must resolve to the Bun executable\n' "$HOST_HOME" >&2
	exit 1
fi
BWRAP_PATH_PROOF_MARKER="bwrap-path-proof-marker-$$"
printf 'host-home-marker\n' > "$HOST_HOME/$BWRAP_PATH_PROOF_MARKER"
PATH="$HOST_HOME:$PATH"
BWRAP_BIN="$(command -v bwrap)"
. "${SCRIPT_DIR}/rungs/bwrap.sh"
printf 'Bun resolved on host: %s\n' "$BWRAP_HOST_BUN_PATH"
# WSL --exec may inherit only Windows paths. Keep bwrap callable while removing
# Linux tools from PATH, as happens in that invocation.
bwrap() { "${BWRAP_BIN}" "$@"; }
export PATH=/windows-only
probe_output="$(binprobe_bwrap 'for b in bun node gh git sh; do command -v "$b" || exit 1; done; bun --version')"
printf '%s\n' "$probe_output"
run_bwrap /bin/sh -c '
set -e
for b in bun node gh git sh; do command -v "$b"; done
bun --version
node --version >/dev/null
gh --version >/dev/null
[ ! -e "$VEYYON_TEST_HOST_HOME/$1" ]
[ ! -e "/sandbox/runtime/bun/$1" ]
[ ! -e "$2" ]
[ "$(find /sandbox/runtime/bun -mindepth 1 -maxdepth 1 | wc -l)" -eq 3 ]
[ "$VEYYON_TEST_SANDBOX" = bwrap-userns ]
' _ "$BWRAP_PATH_PROOF_MARKER" "$HOST_HOME/.asdf"
printf 'bwrap PATH proof: PASS\n'
