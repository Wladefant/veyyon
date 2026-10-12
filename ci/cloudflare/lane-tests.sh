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
# Keep the sandbox boundary enabled for every focused test file. These are the
# checkpoint, native recovery, synchronized-session, and CLI regression suites.
export CI=true
export VEYYON_SANDBOX_REMOTE=0
export VEYYON_TEST_CONCURRENCY=2
# Workers Builds has a Docker daemon but no prebuilt Veyyon test guest.
bash -n scripts/test-sandbox/guest/build-guest.sh
VEYYON_SANDBOX_USERLAND_ONLY=1 bash scripts/test-sandbox/run.sh --rung=docker --build
docker run --rm --network=none --cap-drop=MKNOD \
  --mount "type=bind,src=$repo_root,dst=/repo,readonly" \
  --entrypoint /usr/bin/fakeroot "veyyon-test-guest:$expected_bun" /bin/sh -ceu '
    mkdir -p /tmp/device-proof/dev
    cd /tmp/device-proof
    mknod -m 600 dev/console c 5 1
    mknod -m 666 dev/null c 1 3
    find . -print0 | cpio --null -o --format=newc > /tmp/device-proof.cpio
    python3 /repo/ci/cloudflare/device-node-check.py /tmp/device-proof.cpio
  '
focused_tests=(
  cloud/checkpoints/worker.test.ts
  packages/coding-agent/test/cloud-checkpoints.test.ts
  packages/coding-agent/test/native-recovery.test.ts
  packages/coding-agent/test/synchronized-session.test.ts
  packages/coding-agent/test/checkpoint-cli.test.ts
  packages/coding-agent/test/cli/session-command-alias-reaches-stats.test.ts
)
echo "CLOUDFLARE_TEST_START ${focused_tests[*]}"
test_output="$(bash scripts/test-sandbox/run.sh bun test "${focused_tests[@]}" 2>&1)" || {
  printf '%s\n' "$test_output"
  exit 1
}
printf '%s\n' "$test_output"
read -r test_passes test_failures < <(
  awk '
    /^[[:space:]]*[0-9]+ pass$/ { passes += $1 }
    /^[[:space:]]*[0-9]+ fail$/ { failures += $1 }
    END { printf "%d %d\n", passes, failures }
  ' <<< "$test_output"
)
echo "CLOUDFLARE_TEST_SUMMARY pass=$test_passes fail=$test_failures"
if (( test_passes == 0 || test_failures != 0 )); then
  echo 'Expected at least one passing focused test and zero failures.' >&2
  exit 1
fi

npx --yes wrangler@4 versions upload --config ci/cloudflare/wrangler.jsonc
