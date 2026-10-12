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
bun run ci:build:native
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
run_bucket scripts
run_bucket coding-agent-heavy

# Build the production Linux x64 CLI binary using the release's canonical
# compiler. This creates the shipped artifact; it does not deploy the product.
RELEASE_TARGETS=linux-x64 bun run ci:release:build-binaries

# The repository's Rust gate runs only when Cargo exists. Missing Cargo is an
# explicit container limitation; once present, any real check failure is fatal.
if (( test_passes == 0 || test_failures != 0 )); then
  echo "CLOUDFLARE_TEST_SUMMARY pass=$test_passes fail=$test_failures"
  echo 'Expected at least one passing test and zero failures.' >&2
  exit 1
fi
echo "CLOUDFLARE_TEST_SUMMARY pass=$test_passes fail=$test_failures"
if command -v cargo >/dev/null 2>&1; then
  bun run check:rs
  echo 'CLOUDFLARE_RUST_BUILD=passed'
else
  echo 'CLOUDFLARE_RUST_BUILD=unsupported; cargo is unavailable in the Workers Builds container'
fi

npx --yes wrangler@4 versions upload --config ci/cloudflare/wrangler.jsonc
