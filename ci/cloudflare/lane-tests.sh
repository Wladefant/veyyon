#!/usr/bin/env bash
set -Eeuo pipefail
# Cloudflare injects the branch name from the push event:
# https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#default-variables
if [[ -z "${WORKERS_CI_BRANCH:-}" ]]; then
  echo "Cloudflare lane branch is unknown; running tests"
elif [[ "$WORKERS_CI_BRANCH" != cf-ci/* ]]; then
  echo "Skipping Cloudflare lane tests: WORKERS_CI_BRANCH is not a cf-ci/ branch"
  exit 0
fi

# Fail-fast CI execution
export CI=1

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# Parse command-line shard arguments if provided
while [[ $# -gt 0 ]]; do
  case "$1" in
    --shard-index)
      CF_SHARD_INDEX="$2"
      shift 2
      ;;
    --shard-count)
      CF_SHARD_COUNT="$2"
      shift 2
      ;;
    --shard=*)
      val="${1#*=}"
      CF_SHARD_INDEX="${val%%[/:*]}"
      CF_SHARD_COUNT="${val##*[/:*]}"
      shift
      ;;
    *)
      if [[ -z "${CF_SHARD_INDEX:-}" ]]; then
        CF_SHARD_INDEX="$1"
      elif [[ -z "${CF_SHARD_COUNT:-}" ]]; then
        CF_SHARD_COUNT="$1"
      fi
      shift
      ;;
  esac
done

echo "=== Cloudflare Workers Builds CI ==="
echo "Branch: ${WORKERS_CI_BRANCH:-unset}"
echo "Commit: ${WORKERS_CI_COMMIT_SHA:-unset}"
echo "Shard Index: ${CF_SHARD_INDEX:-unset}"
echo "Shard Count: ${CF_SHARD_COUNT:-unset}"

# Validate shard variables before installing dependencies
if [[ -z "${CF_SHARD_INDEX:-}" || -z "${CF_SHARD_COUNT:-}" ]]; then
  echo "FATAL: Shard configuration required: CF_SHARD_INDEX and CF_SHARD_COUNT must be set via env or arguments (e.g. --shard-index 0 --shard-count 12)." >&2
  exit 1
fi

if ! [[ "$CF_SHARD_INDEX" =~ ^[0-9]+$ ]] || ! [[ "$CF_SHARD_COUNT" =~ ^[0-9]+$ ]] || (( CF_SHARD_COUNT < 1 )) || (( CF_SHARD_INDEX >= CF_SHARD_COUNT )); then
  echo "FATAL: Invalid shard configuration: index=$CF_SHARD_INDEX, count=$CF_SHARD_COUNT (expected 0 <= index < count and count >= 1)." >&2
  exit 1
fi

export CF_SHARD_INDEX
export CF_SHARD_COUNT
export VEYYON_SANDBOX_FORWARD="CF_SHARD_INDEX CF_SHARD_COUNT"

# Pin Bun from packageManager
expected_bun="$(node -p "require('./package.json').packageManager.split('@')[1]")"
if ! command -v bun >/dev/null 2>&1 || [[ "$(bun --version)" != "$expected_bun" ]]; then
  echo "Installing repository-pinned Bun $expected_bun for Workers Builds..."
  npm install --global "bun@$expected_bun"
fi
echo "Bun version: $(bun --version)"

# Frozen dependency install
echo "Installing dependencies from frozen lockfile..."
bun install --frozen-lockfile
# Download bubblewrap from the distro without root, then expose its extracted binary.
bwrap_tools="$repo_root/.cf-bwrap"
mkdir -p "$bwrap_tools/packages" "$bwrap_tools/root" \
  "$bwrap_tools/lists/partial" "$bwrap_tools/cache/archives/partial"
(
  cd "$bwrap_tools/packages"
  apt_config="$bwrap_tools/apt.conf"
  printf '%s\n' '#clear APT::Update::Post-Invoke;' > "$apt_config"
  apt_options=(-c "$apt_config" -o "Dir::State::Lists=$bwrap_tools/lists" -o "Dir::Cache=$bwrap_tools/cache")
  timeout 120 apt-get "${apt_options[@]}" update
  timeout 120 apt-get "${apt_options[@]}" download bubblewrap
  timeout 120 dpkg-deb -x ./*.deb "$bwrap_tools/root"
)
export PATH="$bwrap_tools/root/usr/bin:$PATH"
if ! command -v bwrap >/dev/null 2>&1; then
  echo "FATAL: bubblewrap was not extracted to $bwrap_tools/root/usr/bin/bwrap" >&2
  exit 1
fi
export VEYYON_SANDBOX_REMOTE=0
export VEYYON_SANDBOX_RUNG=bwrap
# The bwrap rung binds the requested repository path verbatim. Use an alias outside
# the hidden build user's home and TMPDIR: a /tmp alias is scanned as repository
# data by the test temp-directory janitor, while the real checkout is under HOME.
sandbox_root="$(mktemp -d /var/tmp/veyyon-workers-XXXXXX)"
ln -s "$repo_root" "$sandbox_root/repo"
export VEYYON_SANDBOX_REPO_ROOT="$sandbox_root/repo"

# Pre-native regression gate: run pure shard helper regression suite inside sandbox
# This proves sharding logic remotely even if native compilation encounters time or toolchain issues
echo "Bun version inside bwrap:"
bash scripts/test-sandbox/run.sh bun --version

echo "Running pure sharding helper regression suite inside sandbox before native build..."
bash scripts/test-sandbox/run.sh bun test ./scripts/cf-runtime-sharding.test.ts

# Rust toolchain probe & dynamic pinned install
echo "Deriving pinned Rust toolchain from rust-toolchain.toml..."
pinned_channel="$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' rust-toolchain.toml | head -n1)"
if [[ -z "$pinned_channel" ]]; then
  echo "FATAL: Could not resolve channel from rust-toolchain.toml" >&2
  exit 1
fi
echo "Pinned Rust channel: $pinned_channel"

if ! command -v rustup >/dev/null 2>&1; then
  if command -v curl >/dev/null 2>&1; then
    echo "rustup not present. Installing rustup via official route (https://sh.rustup.rs)..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none --no-modify-path
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
fi

if ! command -v rustup >/dev/null 2>&1; then
  echo "FATAL: rustup is required to install pinned toolchain $pinned_channel" >&2
  exit 1
fi

echo "Installing and selecting pinned toolchain $pinned_channel via rustup..."
rustup toolchain install "$pinned_channel" --profile minimal --target x86_64-unknown-linux-gnu
export RUSTUP_TOOLCHAIN="$pinned_channel"

echo "Rust toolchain verified:"
rustc --version
cargo --version

# Build host-only baseline native addon
echo "Building host-only baseline native addon from source..."
export VEYYON_NATIVE_HOST_ONLY=1
export TARGET_VARIANTS=baseline
export CARGO_BUILD_JOBS=4
bun run ci:build:native

# Native readiness proof: verify binary exists at canonical path (underscore) and report artifact digest
node_addon_path="natives/bridge/bindings/native/veyyon_natives.linux-x64-baseline.node"
if [[ ! -f "$node_addon_path" ]]; then
  node_addon_path="natives/bridge/bindings/native/veyyon_natives.linux-x64.node"
fi

if [[ -f "$node_addon_path" ]]; then
  addon_digest="$(sha256sum "$node_addon_path" | awk '{print $1}')"
  echo "CLOUDFLARE_NATIVE_ARTIFACT path=$node_addon_path sha256=$addon_digest"
else
  echo "FATAL: Native addon binary not found at canonical path $node_addon_path" >&2
  exit 1
fi

echo "Proving native addon execution readiness..."
bun -e "import { visibleWidth } from './natives/bridge/bindings'; const w = visibleWidth('abc', 4); if (w !== 3) throw new Error('visibleWidth failed: expected 3, got ' + w); console.log('CLOUDFLARE_NATIVE_LOADED ok width=' + w);"

# Explicit quota-refusals verification on shard 0
if [[ "$CF_SHARD_INDEX" == "0" ]]; then
  echo "Running explicit quota-refusals single-file verification on shard 0..."
  bash scripts/test-sandbox/run.sh bun test ./packages/coding-agent/test/session/quota-refusals-belong-to-the-failed-request.test.ts
fi

# Run test suite using existing sandbox runner invocation
echo "Running test suite in sandbox..."
bash scripts/test-sandbox/run.sh bun scripts/ci-test-ts.ts all

echo "CLOUDFLARE_LANE_SUCCESS=1"
