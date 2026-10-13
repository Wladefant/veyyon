#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

expected_bun="$(node -p "require('./package.json').packageManager.split('@')[1]")"
if ! command -v bun >/dev/null 2>&1 || [[ "$(bun --version)" != "$expected_bun" ]]; then
  echo "Installing repository-pinned Bun $expected_bun for the Workers Builds container."
  npm install --global "bun@$expected_bun"
fi
bun --version
bun install --frozen-lockfile
bun run check:ts

if ! command -v fd >/dev/null 2>&1 || ! command -v rg >/dev/null 2>&1 || \
  ! command -v magick >/dev/null 2>&1 || \
  ! pkg-config --exists cairo pango fontconfig freetype2 wayland-client xkbcommon xkbcommon-x11 2>/dev/null || \
  ! ldconfig -p 2>/dev/null | grep -q 'libvulkan\.so\.1' || \
  [[ ! -f /usr/share/vulkan/icd.d/lvp_icd.json ]]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo 'CLOUDFLARE_SYSTEM_DEPS=unavailable; apt-get is not installed.'
  elif ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
    echo 'CLOUDFLARE_SYSTEM_DEPS=unavailable; required packages are missing and passwordless sudo is not available.'
  else
    sudo -n apt-get update
    sudo -n apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
      fd-find ripgrep imagemagick pkg-config libfontconfig-dev libfreetype-dev \
      libwayland-dev libxkbcommon-dev libxkbcommon-x11-dev libvulkan1 libvulkan-dev mesa-vulkan-drivers
    if command -v fdfind >/dev/null 2>&1 && ! command -v fd >/dev/null 2>&1; then
      sudo -n ln -sf "$(command -v fdfind)" /usr/local/bin/fd
    fi
    if command -v convert >/dev/null 2>&1 && ! command -v magick >/dev/null 2>&1; then
      sudo -n ln -sf "$(command -v convert)" /usr/local/bin/magick
    fi
  fi
fi

if ! command -v rustup >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || {
    echo 'CLOUDFLARE_RUST_SETUP=failed; rustup and curl are unavailable.' >&2
    exit 1
  }
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none --no-modify-path
  export PATH="$HOME/.cargo/bin:$PATH"
fi
export PATH="$HOME/.cargo/bin:$PATH"
if ! rustup toolchain list | grep -Eq '^nightly-2026-04-29(-|$)'; then
  rustup toolchain install nightly-2026-04-29 --profile minimal --component rustfmt --component clippy \
    --target x86_64-unknown-linux-gnu
fi
# Match the release workflow's Linux x64 portability toolchain.
zig_version=0.16.0
zig_archive="$HOME/.cache/zig-x86_64-linux-${zig_version}.tar.xz"
if ! command -v zig >/dev/null 2>&1 || [[ "$(zig version)" != "$zig_version" ]]; then
  mkdir -p "$HOME/.cache" "$HOME/.local/bin"
  curl --proto '=https' --tlsv1.2 -fsSL \
    "https://ziglang.org/download/${zig_version}/zig-x86_64-linux-${zig_version}.tar.xz" \
    -o "$zig_archive"
  # SHA-256 from Zig's official download index.json for 0.16.0 x86_64-linux.
  printf '%s  %s\n' '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00' "$zig_archive" \
    | sha256sum --check
  tar -xJf "$zig_archive" -C "$HOME/.cache"
  ln -sf "$HOME/.cache/zig-x86_64-linux-${zig_version}/zig" "$HOME/.local/bin/zig"
fi
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v cargo-zigbuild >/dev/null 2>&1; then
  cargo +nightly-2026-04-29 install --locked cargo-zigbuild
fi
zig version
cargo-zigbuild --version
CROSS_TARGET=x86_64-unknown-linux-gnu.2.17 TARGET_PLATFORM=linux TARGET_ARCH=x64 \
  TARGET_VARIANTS='baseline modern' bun run ci:build:native
# Workers Builds cannot start Docker containers. Install the existing bwrap
# rung tools into a repo-local directory without requiring root or a host fallback.
proof_tools="$repo_root/.cf-proof-tools"
mkdir -p "$proof_tools/packages" "$proof_tools/root" "$proof_tools/bin" \
  "$proof_tools/lists/partial" "$proof_tools/cache/archives/partial"
(
  cd "$proof_tools/packages"
  apt_options=(-o "Dir::State::Lists=$proof_tools/lists" -o "Dir::Cache=$proof_tools/cache")
  timeout 120 apt-get "${apt_options[@]}" update
  timeout 120 apt-get "${apt_options[@]}" download bubblewrap fakeroot libfakeroot cpio
  for package in ./*.deb; do
    dpkg-deb -x "$package" "$proof_tools/root"
  done
)
export PATH="$proof_tools/root/usr/bin:$PATH"
real_bun="$(bun -p 'process.execPath')"
cp -L "$real_bun" "$proof_tools/bin/bun"
export VEYYON_SANDBOX_REMOTE=0
export VEYYON_SANDBOX_RUNG=bwrap
export VEYYON_SANDBOX_FORWARD=VEYYON_TEST_CONCURRENCY

# Assert the exact initramfs device metadata required by the guest kernel.
fakeroot -l "$proof_tools/root/usr/lib/x86_64-linux-gnu/libfakeroot/libfakeroot-sysv.so" \
  -f "$proof_tools/root/usr/bin/faked-sysv" /bin/sh -ceu '
    proof_dir="$(mktemp -d)"
    mkdir -p "$proof_dir/dev"
    cd "$proof_dir"
    mknod -m 600 dev/console c 5 1
    mknod -m 666 dev/null c 1 3
    find . -print0 | cpio --null -o --format=newc > "${proof_dir}.cpio"
    python3 "$1" "${proof_dir}.cpio"
  ' _ "$repo_root/ci/cloudflare/device-node-check.py"

# The bwrap rung binds the requested repository path verbatim. Use an alias outside
# the hidden build user's home and TMPDIR: a /tmp alias is scanned as repository
# data by the test temp-directory janitor, while the real checkout is under HOME.
sandbox_root="$(mktemp -d /var/tmp/veyyon-workers-XXXXXX)"
ln -s "$repo_root" "$sandbox_root/repo"
export VEYYON_SANDBOX_REPO_ROOT="$sandbox_root/repo"
sandbox_repo_root="$(bash scripts/test-sandbox/run.sh --rung=bwrap /bin/pwd)"
if [[ -z "$sandbox_repo_root" || "$sandbox_repo_root" == /tmp || "$sandbox_repo_root" == /tmp/* ]]; then
  echo "CLOUDFLARE_BWRAP_REPO_ROOT_INVALID path=${sandbox_repo_root:-empty}" >&2
  exit 1
fi
runtime_bin_dir="$sandbox_repo_root/.cf-proof-tools/bin"
# Child commands resolve `bun` by name. Add only this checkout-mounted real binary
# directory after bwrap has applied its fixed PATH, then exec the test runner.
if ! bash scripts/test-sandbox/run.sh --rung=bwrap /bin/sh -c \
  'export PATH="$1:$PATH"; shift; exec "$@"' _ "$runtime_bin_dir" \
  "$runtime_bin_dir/bun" -e \
  'const result = Bun.spawnSync(["bun", "--version"]); if (result.exitCode !== 0) process.exit(result.exitCode ?? 1); process.stdout.write(result.stdout);'; then
  echo "CLOUDFLARE_BWRAP_BUN_CHILD_FAILED" >&2
  exit 1
fi
echo "CLOUDFLARE_TEST_EXCLUSION file=packages/utils/test/slice-extract-fuzz.test.ts reason=bun-native-16GiB-allocation-aborts-in-workers-guest"
# Existing runner buckets preserve the same shard lists, timeouts and bounded
# process sizes as the repository's GitHub CI. Quiet mode emits real Bun case
# counts separately from child-command chunk totals and replays details on failure.
export CI=true
export VEYYON_TEST_CONCURRENCY=2
report_run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
test_report_root="$proof_tools/test-reports/run-$report_run_id"
sandbox_test_report_root="$sandbox_repo_root/.cf-proof-tools/test-reports/run-$report_run_id"
mkdir -p "$test_report_root"
test_passes=0
test_failures=0
test_skips=0
junit_test_skips=0
test_todos=0
test_reported=0
test_files=0
test_runs=0
chunk_passes=0
chunk_failures=0
run_bucket() {
  local mode="$1"
  echo "CLOUDFLARE_TEST_BUCKET_START $mode"
  local bucket_report_dir="$test_report_root/$mode"
  local sandbox_report_dir="$sandbox_test_report_root/$mode"
  mkdir -p "$bucket_report_dir"
  local bucket_log
  bucket_log="$(mktemp)"
  local bucket_status=0
  if bash scripts/test-sandbox/run.sh --rung=bwrap /bin/sh -c \
    'export PATH="$1:$PATH"; shift; exec "$@"' _ "$runtime_bin_dir" \
    "$runtime_bin_dir/bun" scripts/ci-test-ts.ts "$mode" "--junit-report-dir=$sandbox_report_dir" 2>&1 | tee "$bucket_log"; then
    :
  else
    bucket_status=$?
  fi
  local report_status=0
  python3 ci/cloudflare/check-test-skips.py report "$bucket_report_dir" || report_status=$?
  if (( report_status != 0 && bucket_status == 0 )); then
    bucket_status=$report_status
  fi
  local bucket_junit_reports
  bucket_junit_reports="$(find "$bucket_report_dir" -type f -name '*.xml' | wc -l | tr -d '[:space:]')"
  read -r bucket_chunk_passes bucket_chunk_failures bucket_passes bucket_failures \
    bucket_skips bucket_todos bucket_reported bucket_files bucket_runs bucket_summaries < <(
    awk '
      /^[[:space:]]*[0-9]+ chunks passed$/ { chunks_passed += $1 }
      /^[[:space:]]*[0-9]+ failed chunks$/ { chunks_failed += $1 }
      /^CLOUDFLARE_CI_TEST_COUNTS / {
        summaries += 1
        for (i = 2; i <= NF; i++) {
          split($i, field, "=")
          if (field[1] == "pass") passes += field[2]
          if (field[1] == "fail") failures += field[2]
          if (field[1] == "skip") skips += field[2]
          if (field[1] == "todo") todos += field[2]
          if (field[1] == "reported") reported += field[2]
          if (field[1] == "files") files += field[2]
          if (field[1] == "runs") runs += field[2]
        }
      }
      END {
        printf "%d %d %d %d %d %d %d %d %d %d\n",
          chunks_passed, chunks_failed, passes, failures, skips, todos,
          reported, files, runs, summaries
      }
    ' "$bucket_log"
  )
  chunk_passes=$((chunk_passes + bucket_chunk_passes))
  chunk_failures=$((chunk_failures + bucket_chunk_failures))
  test_passes=$((test_passes + bucket_passes))
  test_failures=$((test_failures + bucket_failures))
  test_skips=$((test_skips + bucket_skips))
  junit_test_skips=$((junit_test_skips + bucket_skips))
  test_todos=$((test_todos + bucket_todos))
  test_reported=$((test_reported + bucket_reported))
  test_files=$((test_files + bucket_files))
  test_runs=$((test_runs + bucket_runs))
  echo "CLOUDFLARE_TEST_BUCKET_END $mode chunks_pass=$bucket_chunk_passes chunks_fail=$bucket_chunk_failures pass=$bucket_passes fail=$bucket_failures skip=$bucket_skips todo=$bucket_todos reported=$bucket_reported files=$bucket_files runs=$bucket_runs junit_reports=$bucket_junit_reports"
  rm -f "$bucket_log"
  local bucket_tests=$((bucket_passes + bucket_failures + bucket_skips + bucket_todos))
  if (( bucket_status == 0 )) && \
    (( bucket_summaries > 0 && bucket_runs > 0 && bucket_files > 0 && bucket_tests > 0 && \
       bucket_reported == bucket_tests && bucket_chunk_passes > 0 && bucket_chunk_failures == 0 && \
       bucket_passes > 0 && bucket_failures == 0 && bucket_todos == 0 && \
       bucket_junit_reports == bucket_runs )); then
    return 0
  fi
  if (( bucket_status != 0 )); then
    echo "CLOUDFLARE_TEST_BUCKET_FAILED $mode status=$bucket_status summaries=$bucket_summaries" >&2
    return "$bucket_status"
  fi
  echo "CLOUDFLARE_TEST_BUCKET_FAILED $mode status=1 summaries=$bucket_summaries" >&2
  return 1
}
echo "CLOUDFLARE_TEST_BUCKET_START health-worker"
worker_output="$(env -u CLOUDFLARE_API_TOKEN node --test --test-reporter=tap ci/cloudflare/worker.test.mjs 2>&1)" || {
  worker_status=$?
  printf '%s\n' "$worker_output"
  exit "$worker_status"
}
printf '%s\n' "$worker_output"
read -r worker_tests worker_passes worker_failures worker_skips worker_todos worker_cancelled < <(
  awk '
    /^# tests [0-9]+$/ { tests = $3 }
    /^# pass [0-9]+$/ { passes = $3 }
    /^# fail [0-9]+$/ { failures = $3 }
    /^# skipped [0-9]+$/ { skips = $3 }
    /^# todo [0-9]+$/ { todos = $3 }
    /^# cancelled [0-9]+$/ { cancelled = $3 }
    END { printf "%d %d %d %d %d %d\n", tests, passes, failures, skips, todos, cancelled }
  ' <<< "$worker_output"
)
test_passes=$((test_passes + worker_passes))
test_failures=$((test_failures + worker_failures + worker_cancelled))
test_skips=$((test_skips + worker_skips))
test_todos=$((test_todos + worker_todos))
test_reported=$((test_reported + worker_tests))
test_files=$((test_files + 1))
test_runs=$((test_runs + 1))
echo "CLOUDFLARE_TEST_BUCKET_END health-worker tests=$worker_tests pass=$worker_passes fail=$worker_failures skip=$worker_skips todo=$worker_todos cancelled=$worker_cancelled files=1 runs=1"
if (( worker_tests == 0 || worker_tests != worker_passes + worker_failures + worker_skips + worker_todos || \
      worker_passes == 0 || worker_failures != 0 || worker_skips != 0 || worker_todos != 0 || worker_cancelled != 0 )); then
  echo 'CLOUDFLARE_TEST_BUCKET_FAILED health-worker summary missing, empty, or non-green' >&2
  exit 1
fi

# `coding-agent-heavy` aggregates the four following coding-agent buckets. Run
# their named CI buckets once each instead of repeating the same assertions.
run_bucket workspace-cloudflare
run_bucket native
run_bucket coding-agent-singleton
run_bucket coding-agent-ui
run_bucket coding-agent-runtime
run_bucket coding-agent-native
run_bucket scripts

# Require real test cases and matching test-runner totals; chunk completion is reported separately.
test_total=$((test_passes + test_failures + test_skips + test_todos))
skip_allowlist_status=0
if python3 ci/cloudflare/check-test-skips.py check "$test_report_root" ci/cloudflare/expected-skips.txt --expected-total "$junit_test_skips"; then
  echo 'CLOUDFLARE_SKIP_ALLOWLIST=passed'
else
  skip_allowlist_status=$?
  echo "CLOUDFLARE_SKIP_ALLOWLIST=failed status=$skip_allowlist_status"
fi
if (( test_total == 0 || test_passes == 0 || test_failures != 0 || \
      test_todos != 0 || test_reported != test_total || test_files == 0 || test_runs == 0 || \
      chunk_passes == 0 || chunk_failures != 0 )); then
  echo "CLOUDFLARE_TEST_SUMMARY pass=$test_passes fail=$test_failures skip=$test_skips todo=$test_todos tests=$test_total reported=$test_reported files=$test_files runs=$test_runs chunks_pass=$chunk_passes chunks_fail=$chunk_failures"
  echo 'Expected positive named test counts, zero failures, zero todos, and matching runner and JUnit reports.' >&2
  exit 1
fi
echo "CLOUDFLARE_TEST_SUMMARY pass=$test_passes fail=$test_failures skip=$test_skips todo=$test_todos tests=$test_total reported=$test_reported files=$test_files runs=$test_runs chunks_pass=$chunk_passes chunks_fail=$chunk_failures"

# Cargo comes from the pinned Rustup installation above; compiler failures are fatal.
bun run check:rs
echo 'CLOUDFLARE_RUST_BUILD=passed'

# Build the production Linux x64 CLI binary using the release's canonical compiler.
RELEASE_TARGETS=linux-x64 bun run ci:release:build-binaries
npx --yes wrangler@4 versions upload --config ci/cloudflare/wrangler.jsonc

echo 'CLOUDFLARE_WORKER_UPLOAD=passed'
if (( skip_allowlist_status != 0 )); then
  exit "$skip_allowlist_status"
fi
