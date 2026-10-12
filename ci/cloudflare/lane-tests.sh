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
    echo 'Required native test dependencies are missing and apt-get is unavailable.' >&2
    exit 1
  fi
  apt-get update
  apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    fd-find ripgrep imagemagick pkg-config libfontconfig-dev libfreetype-dev \
    libwayland-dev libxkbcommon-dev libxkbcommon-x11-dev libvulkan1 libvulkan-dev mesa-vulkan-drivers
  if command -v fdfind >/dev/null 2>&1 && ! command -v fd >/dev/null 2>&1; then
    ln -sf "$(command -v fdfind)" /usr/local/bin/fd
  fi
  if command -v convert >/dev/null 2>&1 && ! command -v magick >/dev/null 2>&1; then
    ln -sf "$(command -v convert)" /usr/local/bin/magick
  fi
fi
bun run ci:build:native
# Keep the sandbox boundary enabled for every focused test file. These are the
# checkpoint, native recovery, synchronized-session, and CLI regression suites.
export CI=true
export VEYYON_TEST_CONCURRENCY=2
focused_tests=(
  cloud/checkpoints/worker.test.ts
  packages/coding-agent/test/cloud-checkpoints.test.ts
  packages/coding-agent/test/native-recovery.test.ts
  packages/coding-agent/test/synchronized-session.test.ts
  packages/coding-agent/test/checkpoint-cli.test.ts
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
