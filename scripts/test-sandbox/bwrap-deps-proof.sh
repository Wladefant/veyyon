#!/usr/bin/env bash
# Prove external Linux dependencies resolve workspace links to tested source and keep the sandbox independent of host package copies.
# Run: bash scripts/test-sandbox/bwrap-deps-proof.sh
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
HOST_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
SANDBOX_GITDIR=""
. "${SCRIPT_DIR}/rungs/bwrap.sh"
stage="$(mktemp -d /tmp/veyyon-deps-proof.XXXXXX)"
trap 'rm -rf "$stage"' EXIT
REPO_ROOT="$stage/repo"
export VEYYON_SANDBOX_NODE_MODULES="$stage/deps/node_modules"
mkdir -p "$REPO_ROOT/packages/example" "$VEYYON_SANDBOX_NODE_MODULES/@veyyon"
printf 'tested-source\n' > "$REPO_ROOT/packages/example/identity"
ln -s ../../packages/example "$VEYYON_SANDBOX_NODE_MODULES/@veyyon/example"
run_bwrap /bin/sh -c '
set -e
[ "$(cat node_modules/@veyyon/example/identity)" = tested-source ]
[ ! -e "$VEYYON_TEST_HOST_HOME" ]
if touch node_modules/forbidden 2>/dev/null; then exit 1; fi
'
printf 'bwrap dependency mount proof: PASS\n'
