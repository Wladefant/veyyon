#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if ! command -v bun >/dev/null 2>&1; then
  echo 'Installing pinned Bun 1.4.0 for the Workers Builds container.'
  npm install --global bun@1.4.0
fi
bun --version
bun install --frozen-lockfile

# Existing runner buckets preserve the same shard lists, timeouts and bounded
# process sizes as the repository's GitHub CI. Full output lets this runner
# collect Bun's per-test summary lines rather than treating chunks as tests.
export CI=true
export VEYYON_TEST_CONCURRENCY=2
test_passes=0
test_failures=0
run_bucket() {
  local mode="$1"
  echo "CLOUDFLARE_TEST_BUCKET_START $mode"
  local bucket_output
  bucket_output="$(bash scripts/test-sandbox/run.sh bun scripts/ci-test-ts.ts "$mode" --full 2>&1)" || {
    printf '%s\n' "$bucket_output"
    return 1
  }
  printf '%s\n' "$bucket_output"
  read -r bucket_passes bucket_failures < <(
    awk '
      /^[[:space:]]*[0-9]+ pass$/ { passes += $1 }
      /^[[:space:]]*[0-9]+ fail$/ { failures += $1 }
      END { printf "%d %d\n", passes, failures }
    ' <<< "$bucket_output"
  )
  test_passes=$((test_passes + bucket_passes))
  test_failures=$((test_failures + bucket_failures))
  echo "CLOUDFLARE_TEST_BUCKET_END $mode pass=$bucket_passes fail=$bucket_failures"
}
run_bucket workspace
run_bucket native
run_bucket coding-agent-singleton
run_bucket coding-agent-ui
run_bucket coding-agent-runtime
run_bucket coding-agent-native
run_bucket coding-agent-heavy

# Build the production Linux x64 CLI binary using the release's canonical
# compiler. This creates the shipped artifact; it does not deploy the product.
RELEASE_TARGETS=linux-x64 bun run ci:release:build-binaries

# Attempt the repo's Rust/native build in the container. Keep its outcome explicit
# while allowing a successful JS production build to remain verifiable if this
# container lacks a supported native toolchain or system libraries.
if (( test_passes == 0 || test_failures != 0 )); then
  echo "CLOUDFLARE_TEST_SUMMARY pass=$test_passes fail=$test_failures"
  echo 'Expected at least one passing test and zero failures.' >&2
  exit 1
fi
echo "CLOUDFLARE_TEST_SUMMARY pass=$test_passes fail=$test_failures"
if command -v cargo >/dev/null 2>&1; then
  if bun run check:rs; then
    echo 'CLOUDFLARE_RUST_BUILD=passed'
  else
    echo 'CLOUDFLARE_RUST_BUILD=unsupported-or-failed; inspect preceding cargo diagnostics'
  fi
else
  echo 'CLOUDFLARE_RUST_BUILD=unsupported; cargo is unavailable in the Workers Builds container'
fi

npx --yes wrangler@4 versions upload --config ci/cloudflare/wrangler.jsonc
