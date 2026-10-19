#!/usr/bin/env bash
set -Eeuo pipefail
# Cloudflare injects the branch name from the push event:
# https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#default-variables
if [[ -z "${WORKERS_CI_BRANCH:-}" ]]; then
  echo "Cloudflare lane branch is unknown; running tests"
fi

# Fail-fast CI execution
export CI=1

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# Parse command-line shard arguments if provided
changed_since="${CF_CHANGED_SINCE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --changed-since)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --changed-since requires a commit SHA" >&2
        exit 1
      fi
      changed_since="$2"
      shift 2
      ;;
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

if [[ -n "${WORKERS_CI_COMMIT_SHA:-}" ]] && [[ "$(git rev-parse HEAD)" != "$WORKERS_CI_COMMIT_SHA" ]]; then
  echo "ERROR: checkout does not match WORKERS_CI_COMMIT_SHA" >&2
  exit 1
fi

selection_args=()
is_nightly=0
if [[ "${WORKERS_CI_BRANCH:-}" == "main" ]] || [[ "${WORKERS_CI_BRANCH:-}" == *"nightly"* ]] || [[ "${CI_NIGHTLY:-0}" == "1" ]]; then
  is_nightly=1
  echo "CLOUDFLARE_NIGHTLY_RUN branch=${WORKERS_CI_BRANCH:-unset} mode=full"
fi

if [[ $is_nightly -eq 1 ]]; then
  CF_SHARD_INDEX="${CF_SHARD_INDEX:-0}"
  CF_SHARD_COUNT="${CF_SHARD_COUNT:-1}"
fi

if [[ $is_nightly -eq 1 ]]; then
  echo "CLOUDFLARE_SELECTION_MODE mode=full reason=nightly-main"
elif [[ -n "$changed_since" ]]; then
  selection_args=(--changed-since "$changed_since")
  if [[ "$changed_since" =~ ^[0-9a-fA-F]{40}$ ]]; then
    if ! git cat-file -e "${changed_since}^{commit}" >/dev/null 2>&1; then
      if ! git fetch --no-tags --depth=1 origin "$changed_since"; then
        echo "CLOUDFLARE_SELECTION_FALLBACK reason=base-fetch-failed base=$changed_since"
      fi
    fi
  else
    echo "CLOUDFLARE_SELECTION_FALLBACK reason=invalid-base-sha"
  fi
else
  base_sha=""
  if git rev-parse --verify origin/main >/dev/null 2>&1 || git fetch --no-tags --depth=20 origin main >/dev/null 2>&1; then
    base_sha="$(git merge-base HEAD origin/main 2>/dev/null || echo "")"
  fi
  if [[ -n "$base_sha" && "$base_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "Resolved comparison base SHA against main: $base_sha"
    selection_args=(--changed-since "$base_sha")
  else
    echo "CLOUDFLARE_SELECTION_FALLBACK reason=unable-to-resolve-merge-base"
  fi
fi

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
bash scripts/test-sandbox/run.sh bun test \
  ./scripts/cf-runtime-sharding.test.ts \
  ./scripts/workspace-layout.test.ts \
  ./scripts/workspace-dependency-graph.test.ts \
  ./scripts/affected-workspace-selection-keeps-safe-coverage.test.ts

if [[ "$CF_SHARD_INDEX" == "0" ]]; then
  echo "Running affected-selection historical PR replay inside sandbox on shard 0..."
  bash scripts/test-sandbox/run.sh bun ci/cloudflare/replay-affected-selection.ts
fi

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
echo "CLOUDFLARE_TEST_EXCLUSION file=packages/utils/test/slice-extract-fuzz.test.ts reason=bun-native-16GiB-allocation-aborts-in-workers-guest"
# Outer memory sampler & safe minimal bridge (every 5s, stops with runner)
diag_dir="$repo_root/.cf-diagnostics"
mkdir -p "$diag_dir"

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

write_cgroup_bridge

OUTER_SAMPLER_PID=""
(
  while true; do
    sleep 5
    write_cgroup_bridge
    free_summary="$(free -m 2>/dev/null | awk '/^Mem:/{printf "total=%sMB used=%sMB free=%sMB avail=%sMB", $2, $3, $4, $7}' || echo "unavailable")"
    cur="$(sed -n 's/.*"current": "\([^"]*\)".*/\1/p' "$diag_dir/cgroup-latest.json" 2>/dev/null || echo "unavailable")"
    peak="$(sed -n 's/.*"peak": "\([^"]*\)".*/\1/p' "$diag_dir/cgroup-latest.json" 2>/dev/null || echo "unavailable")"
    oom="$(sed -n 's/.*"oom": "\([^"]*\)".*/\1/p' "$diag_dir/cgroup-latest.json" 2>/dev/null || echo "unavailable")"
    oom_kill="$(sed -n 's/.*"oom_kill": "\([^"]*\)".*/\1/p' "$diag_dir/cgroup-latest.json" 2>/dev/null || echo "unavailable")"
    echo "CLOUDFLARE_OUTER_SAMPLER_5S current=$cur peak=$peak oom=$oom oom_kill=$oom_kill free=\"$free_summary\""
  done
) &
OUTER_SAMPLER_PID=$!

stop_outer_sampler() {
  if [[ -n "${OUTER_SAMPLER_PID:-}" ]]; then
    kill "$OUTER_SAMPLER_PID" 2>/dev/null || true
    wait "$OUTER_SAMPLER_PID" 2>/dev/null || true
  fi
}
trap stop_outer_sampler EXIT INT TERM

if [[ -n "$changed_since" ]]; then
  echo "Emitting affected-selection plan JSON in sandbox..."
  bash scripts/test-sandbox/run.sh bun scripts/ci-test-ts.ts all --dry-run --plan-json "${selection_args[@]}"
fi

echo "Running test suite in sandbox..."
test_exit=0
bash scripts/test-sandbox/run.sh bun scripts/ci-test-ts.ts all "${selection_args[@]}" || test_exit=$?

stop_outer_sampler
trap - EXIT INT TERM

HEAD_SHA="$(git rev-parse HEAD)"
echo "CLOUDFLARE_EXACT_HEAD sha=$HEAD_SHA"

if [[ -n "${GITHUB_TOKEN:-}" && -n "$HEAD_SHA" ]]; then
  status_state="success"
  if [[ $test_exit -ne 0 ]]; then
    status_state="failure"
  fi
  status_desc="Cloudflare CI ${status_state} on shard ${CF_SHARD_INDEX}/${CF_SHARD_COUNT} (exact head ${HEAD_SHA:0:8})"
  echo "Reporting GitHub commit status on exact SHA $HEAD_SHA ($status_state)..."
  curl -s -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/Wladefant/veyyon/statuses/$HEAD_SHA" \
    -d "{\"state\":\"$status_state\",\"context\":\"Workers Builds: veyyon-ci-${CF_SHARD_INDEX}\",\"description\":\"$status_desc\"}" >/dev/null || true
fi

if [[ $test_exit -ne 0 ]]; then
  echo "FATAL: Test suite failed with exit code $test_exit" >&2
  exit "$test_exit"
fi

echo "CLOUDFLARE_LANE_SUCCESS=1"
