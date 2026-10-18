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

# Outer memory sampler & safe minimal bridge (every 30s, stops with runner)
diag_dir=""
OUTER_SAMPLER_PID=""

write_cgroup_bridge() {
  local cur="unavailable"
  local peak="unavailable"
  local oom="unavailable"
  local oom_kill="unavailable"
  local raw_events=""
  local supported="false"
  local cgroup_base="/sys/fs/cgroup"

  if [[ -f "$cgroup_base/memory.current" ]]; then
    cur="$(cat "$cgroup_base/memory.current" 2>/dev/null || echo "unavailable")"
    supported="true"
  fi
  if [[ -f "$cgroup_base/memory.peak" ]]; then
    peak="$(cat "$cgroup_base/memory.peak" 2>/dev/null || echo "unavailable")"
    supported="true"
  fi
  if [[ -f "$cgroup_base/memory.events" ]]; then
    raw_events="$(tr '\n' ' ' < "$cgroup_base/memory.events" 2>/dev/null || echo "")"
    oom="$(awk '$1=="oom"{print $2}' "$cgroup_base/memory.events" 2>/dev/null || echo "unavailable")"
    oom_kill="$(awk '$1=="oom_kill"{print $2}' "$cgroup_base/memory.events" 2>/dev/null || echo "unavailable")"
    supported="true"
  fi
  if [[ "$cur" == "unavailable" && -f "$cgroup_base/memory/memory.usage_in_bytes" ]]; then
    cur="$(cat "$cgroup_base/memory/memory.usage_in_bytes" 2>/dev/null || echo "unavailable")"
    peak="$(cat "$cgroup_base/memory/memory.max_usage_in_bytes" 2>/dev/null || echo "unavailable")"
    supported="true"
    if [[ -f "$cgroup_base/memory/memory.oom_control" ]]; then
      raw_events="$(tr '\n' ' ' < "$cgroup_base/memory/memory.oom_control" 2>/dev/null || echo "")"
      oom_kill="$(awk '$1=="oom_kill"{print $2}' "$cgroup_base/memory/memory.oom_control" 2>/dev/null || echo "unavailable")"
    fi
  fi

  cat > "$diag_dir/cgroup-latest.json.tmp" <<EOF
{
  "supported": $supported,
  "current": "$cur",
  "peak": "$peak",
  "oom": "$oom",
  "oom_kill": "$oom_kill",
  "raw_events": "$raw_events"
}
EOF
  mv "$diag_dir/cgroup-latest.json.tmp" "$diag_dir/cgroup-latest.json"
}

stop_outer_sampler() {
  if [[ -n "${OUTER_SAMPLER_PID:-}" ]]; then
    kill "$OUTER_SAMPLER_PID" 2>/dev/null || true
    wait "$OUTER_SAMPLER_PID" 2>/dev/null || true
  fi
}
on_lane_exit() {
  local status=$?
  stop_outer_sampler
  echo "CLOUDFLARE_LANE_EXIT status=$status"
}
trap on_lane_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

diag_dir="$(mktemp -d /var/tmp/veyyon-diag-XXXXXX)"
write_cgroup_bridge

(
  while true; do
    sleep 30
    write_cgroup_bridge
    free_summary="$(free -m 2>/dev/null | awk '/^Mem:/{printf "total=%sMB used=%sMB free=%sMB avail=%sMB", $2, $3, $4, $7}' || echo "unavailable")"
    cur="$(sed -n 's/.*"current": "\([^"]*\)".*/\1/p' "$diag_dir/cgroup-latest.json" 2>/dev/null || echo "unavailable")"
    peak="$(sed -n 's/.*"peak": "\([^"]*\)".*/\1/p' "$diag_dir/cgroup-latest.json" 2>/dev/null || echo "unavailable")"
    oom="$(sed -n 's/.*"oom": "\([^"]*\)".*/\1/p' "$diag_dir/cgroup-latest.json" 2>/dev/null || echo "unavailable")"
    oom_kill="$(sed -n 's/.*"oom_kill": "\([^"]*\)".*/\1/p' "$diag_dir/cgroup-latest.json" 2>/dev/null || echo "unavailable")"
    echo "CLOUDFLARE_HEARTBEAT_30S current=$cur peak=$peak oom=$oom oom_kill=$oom_kill free=\"$free_summary\""
  done
) &
OUTER_SAMPLER_PID=$!

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
echo "Build uid: $(id -u) ($(id -un))"
echo "Node version: $(node --version)"

# Frozen dependency install
echo "Installing dependencies from frozen lockfile..."
bun install --frozen-lockfile

# Prepare the exact Git baseline needed by test suites without fetching unrelated history.
echo "=== Preparing Git History ==="
baseline_sha="81eee11283051f29967dbfc506b297d45fd375b1"
if ! git cat-file -e "${baseline_sha}^{commit}" >/dev/null 2>&1; then
  echo "Baseline commit $baseline_sha is missing. Fetching it from origin..."
  fetch_started=$SECONDS
  if git fetch --no-tags --depth=1 origin "$baseline_sha"; then
    fetch_elapsed=$((SECONDS - fetch_started))
    echo "Targeted baseline fetch completed in ${fetch_elapsed}s."
  else
    fetch_status=$?
    fetch_elapsed=$((SECONDS - fetch_started))
    echo "ERROR: targeted baseline fetch failed after ${fetch_elapsed}s (exit status $fetch_status)." >&2
    exit "$fetch_status"
  fi
fi
if ! git cat-file -e "${baseline_sha}^{commit}" >/dev/null 2>&1; then
  echo "ERROR: baseline commit $baseline_sha is unavailable after targeted fetch." >&2
  exit 1
fi
echo "Baseline commit $baseline_sha verified in object store."
# Download bubblewrap from the distro without root, then expose its extracted binary.
bwrap_tools="$(mktemp -d /var/tmp/veyyon-bwrap-tools-XXXXXX)"
mkdir -p "$bwrap_tools/packages" "$bwrap_tools/root" \
  "$bwrap_tools/lists/partial" "$bwrap_tools/cache/archives/partial"
(
  cd "$bwrap_tools/packages"
  apt_config="$bwrap_tools/apt.conf"
  printf '%s\n' '#clear APT::Update::Post-Invoke;' > "$apt_config"
  apt_options=(-c "$apt_config" -o "Dir::State::Lists=$bwrap_tools/lists" -o "Dir::Cache=$bwrap_tools/cache")
  timeout 120 apt-get "${apt_options[@]}" update
  timeout 120 apt-get "${apt_options[@]}" download bubblewrap
  timeout 120 apt-get "${apt_options[@]}" download gh
  for deb in ./*.deb; do
    timeout 120 dpkg-deb -x "$deb" "$bwrap_tools/root"
  done
)
export PATH="$bwrap_tools/root/usr/bin:$PATH"
export VEYYON_BWRAP_GH="$bwrap_tools/root/usr/bin/gh"
if [[ ! -x "$VEYYON_BWRAP_GH" ]]; then
  echo "FATAL: gh was not extracted to $VEYYON_BWRAP_GH" >&2
  exit 1
fi
echo "gh version: $("$VEYYON_BWRAP_GH" --version | head -n1)"
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
# Guest permission probe, run through the rung. It fails loud unless the guest is non-root, HOME and
# TMPDIR accept a write, and a write to the root path is refused with EACCES. It removes only its own
# probe file, and only when the root write was accepted.
guest_probe_sh='set -eu
uid="$(id -u)"
if [ "$uid" = 0 ]; then echo "GUEST PROBE FAILED: id -u is 0" >&2; exit 1; fi
echo "guest id: uid=$uid gid=$(id -g)"
echo "guest caps: $(grep "^CapEff" /proc/self/status)"
node --version >/dev/null
gh --version >/dev/null
bun --version >/dev/null
echo "guest runtimes: node $(node --version) gh $(gh --version | head -n1) bun $(bun --version)"
bun -e "$1"'
guest_probe_js='const fs = require("node:fs");
const fail = (message) => { console.error("GUEST PROBE FAILED: " + message); process.exit(1); };
for (const dir of [process.env.HOME, process.env.TMPDIR]) {
  const file = dir + "/.guest-probe-" + process.pid;
  try { fs.writeFileSync(file, "ok"); fs.rmSync(file); } catch (error) { fail("cannot write " + dir + ": " + error.code); }
}
const rootFile = "/.guest-probe-root-" + process.pid;
let rootWritten = false;
try { fs.writeFileSync(rootFile, "x"); rootWritten = true; } catch (error) { if (error.code !== "EACCES") fail("root write expected EACCES, got " + error.code); }
if (rootWritten) { fs.rmSync(rootFile, { force: true }); fail("root path accepted a write: " + rootFile); }
console.log("GUEST PROBE OK: root write refused with EACCES");'
echo "Guest permission probe inside bwrap..."
bash scripts/test-sandbox/run.sh /bin/sh -c "$guest_probe_sh" _ "$guest_probe_js" || { echo "FATAL: guest permission probe failed" >&2; exit 1; }

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
# Remove only the gitignored evals cache left by an earlier step of this checkout.
# A path git tracks is never deleted, so tracked fixtures survive.
if [[ -d tests/evals/.cache ]] && git check-ignore -q tests/evals/.cache \
  && ! git ls-files --error-unmatch -- tests/evals/.cache >/dev/null 2>&1; then
  echo "Removing generated cache tests/evals/.cache before the test scan"
  rm -rf -- tests/evals/.cache
fi

# Run test suite using existing sandbox runner invocation
echo "CLOUDFLARE_TEST_EXCLUSION file=packages/utils/test/slice-extract-fuzz.test.ts reason=bun-native-16GiB-allocation-aborts-in-workers-guest"

echo "Running test suite in sandbox..."
test_exit=0
bash scripts/test-sandbox/run.sh bun scripts/ci-test-ts.ts all || test_exit=$?

if [[ $test_exit -ne 0 ]]; then
  echo "FATAL: Test suite failed with exit code $test_exit" >&2
  exit "$test_exit"
fi

echo "CLOUDFLARE_LANE_SUCCESS=1"
