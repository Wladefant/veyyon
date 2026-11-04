#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
# Bound writer work to 1200s overall, retaining time for R2 upload.
writer_started_ms="$(date +%s%3N)"

# Writer cannot run on PR branch; strictly main only
current_branch="${WORKERS_CI_BRANCH:-$(git branch --show-current 2>/dev/null || echo "")}"
if [[ "$current_branch" != "main" ]]; then
  echo "CLOUDFLARE_NATIVE_CACHE_WRITER_FORBIDDEN branch=${current_branch:-unset}; writer runs on main branch only" >&2
  exit 1
fi
echo "CLOUDFLARE_NATIVE_CACHE_WRITER branch=main label=cache-writer tests=0 test_result=NO-RESULT"

# Writer uses WRITE secret only; strip release tokens and reader credentials
unset VEYYON_RELEASE_TOKEN VEYYON_RELEASE_TAG VEYYON_RELEASE_SHA VEYYON_RELEASE_PRERELEASE \
  VEYYON_RELEASE_PUBLISH VEYYON_RELEASE_REPO VEYYON_NATIVE_CACHE_CREDENTIALS

# Pinned repository Bun installation and frozen lockfile install
expected_bun="$(node -p "require('./package.json').packageManager.split('@')[1]")"
if ! command -v bun >/dev/null 2>&1 || [[ "$(bun --version)" != "$expected_bun" ]]; then
  echo "Installing repository-pinned Bun $expected_bun for the Workers Builds container."
  npm install --global "bun@$expected_bun"
fi
bun --version
bun install --frozen-lockfile

# System dependencies (reused from existing lane)
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

# Rust/Zig toolchain setup (reused from existing lane)
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
  rustup toolchain install nightly-2026-04-29 --profile minimal \
    --target x86_64-unknown-linux-gnu
fi

# Match the release workflow's Linux x64 portability toolchain
zig_version=0.16.0
zig_archive="$HOME/.cache/zig-x86_64-linux-${zig_version}.tar.xz"
if ! command -v zig >/dev/null 2>&1 || [[ "$(zig version)" != "$zig_version" ]]; then
  mkdir -p "$HOME/.cache" "$HOME/.local/bin"
  curl --proto '=https' --tlsv1.2 -fsSL \
    "https://ziglang.org/download/${zig_version}/zig-x86_64-linux-${zig_version}.tar.xz" \
    -o "$zig_archive"
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

bootstrap_finished_ms="$(date +%s%3N)"
bootstrap_ms="$((bootstrap_finished_ms - writer_started_ms))"
build_timeout_ms="$((1200000 - bootstrap_ms - 100000))"
if (( build_timeout_ms > 1100000 )); then build_timeout_ms=1100000; fi
if (( build_timeout_ms <= 0 )); then
  echo "NO-RESULT native-writer-budget-exhausted bootstrap_ms=${bootstrap_ms}" >&2
  exit 1
fi
export CARGO_BUILD_JOBS=4
export VEYYON_NATIVE_BUILD_TIMEOUT_MS="$build_timeout_ms"

# Invoke native cache helper in --write mode
CROSS_TARGET=x86_64-unknown-linux-gnu.2.17 TARGET_PLATFORM=linux TARGET_ARCH=x64 \
  TARGET_VARIANTS='baseline modern' bun ci/cloudflare/native-cache.mjs --write

echo 'CLOUDFLARE_CI_WORKER_VERSION_UPLOAD=deferred-to-Workers-Builds-deploy-command'
