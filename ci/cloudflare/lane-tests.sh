#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

route_output="$(node ci/cloudflare/lane-routing.mjs)"
IFS='|' read -r route_kind route_arg route_shard route_count <<< "$route_output"
case "$route_kind" in
  release-skip)
    echo "release branch: shard $route_shard skipped"
    exit 0
    ;;
  release)
    route_mode="$route_arg"
    shard_index="$route_shard"
    echo "release branch: shard 1 runs unsplit release mode $route_mode"
    if [[ -f ci/cloudflare/release-linux.sh ]]; then
      exec bash ci/cloudflare/release-linux.sh "$route_mode"
    fi
    echo "release branch: shard 1 skipped; release path is unavailable in this checkout"
    exit 0
    ;;
  tests)
    shard_index="$route_arg"
    shard_count="$route_shard"
    shard_spec="$shard_index/$shard_count"
    case "$shard_index" in
      2)
        native_variant=modern
        ;;
      *)
        native_variant=baseline
        ;;
    esac
    export VEYYON_NATIVE_VARIANT="$native_variant"
    echo "CLOUDFLARE_CI_SHARD branch=${WORKERS_CI_BRANCH:-unset} shard=$shard_spec"
    ;;
  *)
    echo "CLOUDFLARE_CI_ROUTE_INVALID route=$route_kind" >&2
    exit 1
    ;;
esac
unset VEYYON_RELEASE_TOKEN VEYYON_RELEASE_TAG VEYYON_RELEASE_SHA VEYYON_RELEASE_PRERELEASE \
  VEYYON_RELEASE_PUBLISH VEYYON_RELEASE_REPO


setup_seconds=0
SECONDS=0
expected_bun="$(node -p "require('./package.json').packageManager.split('@')[1]")"
if ! command -v bun >/dev/null 2>&1 || [[ "$(bun --version)" != "$expected_bun" ]]; then
  echo "Installing repository-pinned Bun $expected_bun for the Workers Builds container."
  npm install --global "bun@$expected_bun"
fi
bun --version
bun install --frozen-lockfile
echo "CLOUDFLARE_TYPECHECK_START package=coding-agent"
bun run --cwd packages/coding-agent check:types
echo "CLOUDFLARE_TYPECHECK_PASS package=coding-agent"
phase_seconds=$SECONDS
setup_seconds=$((setup_seconds + phase_seconds))
echo "CLOUDFLARE_SETUP_PHASE name=dependencies-and-types seconds=$phase_seconds"
SECONDS=0

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
phase_seconds=$SECONDS
setup_seconds=$((setup_seconds + phase_seconds))
echo "CLOUDFLARE_SETUP_PHASE name=system-dependencies seconds=$phase_seconds"
SECONDS=0

if ! command -v rustup >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || {
    echo 'CLOUDFLARE_RUST_SETUP=failed; rustup and curl are unavailable.' >&2
    exit 1
  }
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none --no-modify-path
  export PATH="$HOME/.cargo/bin:$PATH"
fi
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS=4
if ! rustup toolchain list | grep -Eq '^nightly-2026-04-29(-|$)'; then
  rustup toolchain install nightly-2026-04-29 --profile minimal \
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
phase_seconds=$SECONDS
setup_seconds=$((setup_seconds + phase_seconds))
echo "CLOUDFLARE_SETUP_PHASE name=rust-zig-toolchain seconds=$phase_seconds"
SECONDS=0
CARGO_BUILD_JOBS=4 CROSS_TARGET=x86_64-unknown-linux-gnu.2.17 TARGET_PLATFORM=linux TARGET_ARCH=x64 \
  TARGET_VARIANTS="$native_variant" bun run ci:build:native
unset VEYYON_NATIVE_CACHE_CREDENTIALS VEYYON_NATIVE_CACHE_WRITE_CREDENTIALS
phase_seconds=$SECONDS
setup_seconds=$((setup_seconds + phase_seconds))
echo "CLOUDFLARE_SETUP_PHASE name=native-addon-build seconds=$phase_seconds"
SECONDS=0
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
phase_seconds=$SECONDS
setup_seconds=$((setup_seconds + phase_seconds))
echo "CLOUDFLARE_SETUP_PHASE name=bwrap-bootstrap seconds=$phase_seconds"
echo "CLOUDFLARE_SETUP_TOTAL seconds=$setup_seconds"
if ! bash scripts/test-sandbox/run.sh --rung=bwrap /bin/sh -c \
  'export PATH="$1:$PATH"; export VEYYON_NATIVE_VARIANT="$2"; shift 2; exec "$@"' _ "$runtime_bin_dir" "$native_variant" \
  "$runtime_bin_dir/bun" ci/cloudflare/native-variant-proof.mjs "$native_variant"; then
  echo "CLOUDFLARE_NATIVE_VARIANT_PROOF_FAILED" >&2
  exit 1
fi
# This proof branch changes only CI. Run the two requested regression contracts
# through the existing bwrap boundary, with secrets removed from child processes.
export CI=true
unset CLOUDFLARE_API_TOKEN
run_focused() {
  local label="$1"
  shift
  local log="$proof_tools/$label.log"
  local status=0
  bash scripts/test-sandbox/run.sh --rung=bwrap /bin/sh -c \
    'export PATH="$1:$PATH"; export VEYYON_NATIVE_VARIANT="$2"; shift 2; exec "$@"' \
    _ "$runtime_bin_dir" "$native_variant" "$runtime_bin_dir/bun" test "$@" \
    2>&1 | tee "$log" || status=$?
  python3 ci/cloudflare/focused-counts.py "$label" "$log" "$status"
}
run_focused credential-block packages/coding-agent/test/session/quota-refusals-belong-to-the-failed-request.test.ts
run_focused stream-cycle packages/ai/test/stream-auth-retry.test.ts \
  --test-name-pattern "stops replay-safe usage rotation when the resolver cycles to an attempted credential"
read -r credential_pass credential_fail < "$proof_tools/credential-block.log.counts"
read -r stream_pass stream_fail < "$proof_tools/stream-cycle.log.counts"
if [[ "${WORKERS_CI_BRANCH:-}" == "cf-ci/619-red" ]]; then
  (( credential_fail > 0 && stream_pass == 1 && stream_fail == 0 ))
else
  (( credential_pass == 9 && credential_fail == 0 && stream_pass == 1 && stream_fail == 0 ))
fi
