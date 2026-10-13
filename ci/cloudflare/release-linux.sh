#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

mode="${1:-windows-proof}"
if [[ "$mode" != "windows-proof" && "$mode" != "full" ]]; then
  echo "Usage: $0 [windows-proof|full]" >&2
  exit 1
fi

echo "=== Veyyon Cloudflare Linux Release ($mode) ==="
cleanup() {
  local exit_code=$?
  if [[ -d "$repo_root/.cf-llvm-tools/packages" ]]; then
    rm -rf "$repo_root/.cf-llvm-tools/packages" "$repo_root/.cf-llvm-tools/lists" "$repo_root/.cf-llvm-tools/cache" || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

# 1. Bounded tool bootstrap: Pinned Bun
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

expected_bun="$(node -p "require('./package.json').packageManager.split('@')[1]" 2>/dev/null || grep -oE '"bun@[0-9.]+"' package.json | tr -d '"' | cut -d@ -f2)"
if ! command -v bun >/dev/null 2>&1 || [[ "$(bun --version 2>/dev/null)" != "$expected_bun" ]]; then
  echo "Installing repository-pinned Bun $expected_bun..."
  if ! npm install --global "bun@$expected_bun" 2>/dev/null; then
    bun_tmp="$(mktemp -d)"
    curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${expected_bun}/bun-linux-x64.zip" -o "$bun_tmp/bun.zip"
    unzip -q "$bun_tmp/bun.zip" -d "$bun_tmp"
    cp -f "$bun_tmp/bun-linux-x64/bun" "$HOME/.local/bin/bun"
    chmod +x "$HOME/.local/bin/bun"
    rm -rf "$bun_tmp"
  fi
fi

bun --version
bun install --frozen-lockfile

# 2. Bounded tool bootstrap: Rust toolchain from rust-toolchain.toml
rust_channel=""
if command -v python3 >/dev/null 2>&1; then
  rust_channel="$(python3 -c "
import re
try:
    m = re.search(r'channel\s*=\s*\"([^\"]+)\"', open('rust-toolchain.toml').read())
    print(m.group(1) if m else '')
except Exception:
    pass
" 2>/dev/null || true)"
fi
if [[ -z "$rust_channel" ]]; then
  rust_channel="$(sed -nE 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' rust-toolchain.toml | head -n 1)"
fi
if [[ -z "$rust_channel" ]]; then
  rust_channel="nightly-2026-04-29"
fi
echo "Using repository Rust channel: $rust_channel"

if ! command -v rustup >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || {
    echo "ERROR: curl is required to install rustup." >&2
    exit 1
  }
  echo "Installing rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none --no-modify-path
fi
export PATH="$HOME/.cargo/bin:$PATH"

if ! rustup toolchain list | grep -Eq "^${rust_channel}(-|$)"; then
  echo "Installing Rust toolchain $rust_channel..."
  rustup toolchain install "$rust_channel" --profile minimal --no-self-update
fi
rustup default "$rust_channel"

echo "Adding Windows MSVC target: x86_64-pc-windows-msvc..."
rustup target add --toolchain "$rust_channel" x86_64-pc-windows-msvc

if [[ "$mode" == "full" ]]; then
  echo "Adding Linux targets: x86_64-unknown-linux-gnu and aarch64-unknown-linux-gnu..."
  rustup target add --toolchain "$rust_channel" x86_64-unknown-linux-gnu
  rustup target add --toolchain "$rust_channel" aarch64-unknown-linux-gnu
fi

# 3. LLVM / Clang / LLD tooling for cargo-xwin (without assuming sudo)
if ! command -v clang >/dev/null 2>&1 || (! command -v lld >/dev/null 2>&1 && ! command -v lld-link >/dev/null 2>&1); then
  echo "LLVM tooling missing; checking installation paths without assuming sudo..."
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    echo "Passwordless sudo available: installing clang, lld, llvm via apt-get..."
    sudo -n apt-get update
    sudo -n apt-get install -y clang lld llvm
  elif command -v apt-get >/dev/null 2>&1 && command -v dpkg-deb >/dev/null 2>&1; then
    echo "Sudo unavailable: downloading and unpacking LLVM packages locally into .cf-llvm-tools..."
    llvm_tools="$repo_root/.cf-llvm-tools"
    mkdir -p "$llvm_tools/packages" "$llvm_tools/root" "$llvm_tools/lists/partial" "$llvm_tools/cache/archives/partial"
    (
      cd "$llvm_tools/packages"
      apt_options=(-o "Dir::State::Lists=$llvm_tools/lists" -o "Dir::Cache=$llvm_tools/cache")
      timeout 120 apt-get "${apt_options[@]}" update 2>/dev/null || true
      packages=(
        clang-18 lld-18 llvm-18 libclang-common-18-dev libclang-cpp18 libllvm18 liblld-18
        clang-17 lld-17 llvm-17 libclang-common-17-dev libclang-cpp17 libllvm17
        clang lld llvm
      )
      for pkg in "${packages[@]}"; do
        timeout 60 apt-get "${apt_options[@]}" download "$pkg" 2>/dev/null || true
      done
      for deb in ./*.deb; do
        [[ -f "$deb" ]] && dpkg-deb -x "$deb" "$llvm_tools/root" 2>/dev/null || true
      done
    )
    for bindir in "$llvm_tools/root/usr/lib/llvm-18/bin" \
                  "$llvm_tools/root/usr/lib/llvm-17/bin" \
                  "$llvm_tools/root/usr/bin"; do
      if [[ -d "$bindir" ]]; then
        export PATH="$bindir:$PATH"
      fi
    done
    for libdir in "$llvm_tools/root/usr/lib/llvm-18/lib" \
                  "$llvm_tools/root/usr/lib/llvm-17/lib" \
                  "$llvm_tools/root/usr/lib/x86_64-linux-gnu" \
                  "$llvm_tools/root/usr/lib" \
                  "$llvm_tools/root/lib/x86_64-linux-gnu"; do
      if [[ -d "$libdir" ]]; then
        export LD_LIBRARY_PATH="$libdir:${LD_LIBRARY_PATH:-}"
      fi
    done
  else
    echo "WARN: Neither sudo nor apt-get package extraction available; checking existing toolchain."
  fi
fi

mkdir -p "$HOME/.local/bin"
if ! command -v clang >/dev/null 2>&1; then
  clang_target="$(find "$repo_root/.cf-llvm-tools/root" -type f \( -name "clang-[0-9]*" -o -name "clang" \) -perm -111 2>/dev/null | head -n 1 || true)"
  if [[ -n "$clang_target" ]]; then
    ln -sf "$clang_target" "$HOME/.local/bin/clang"
  fi
fi
if command -v clang >/dev/null 2>&1; then
  ln -sf "$(command -v clang)" "$HOME/.local/bin/clang-cl"
fi

if ! command -v lld >/dev/null 2>&1; then
  lld_target="$(find "$repo_root/.cf-llvm-tools/root" -type f \( -name "lld-[0-9]*" -o -name "lld" \) -perm -111 2>/dev/null | head -n 1 || true)"
  if [[ -n "$lld_target" ]]; then
    ln -sf "$lld_target" "$HOME/.local/bin/lld"
  fi
fi

if ! command -v lld-link >/dev/null 2>&1; then
  lld_link_target="$(find "$repo_root/.cf-llvm-tools/root" -type f -name "lld-link*" -perm -111 2>/dev/null | head -n 1 || true)"
  if [[ -n "$lld_link_target" ]]; then
    ln -sf "$lld_link_target" "$HOME/.local/bin/lld-link"
  elif command -v lld >/dev/null 2>&1; then
    ln -sf "$(command -v lld)" "$HOME/.local/bin/lld-link"
  fi
fi

if ! command -v lld-link >/dev/null 2>&1; then
  rust_sysroot="$(rustc --print sysroot 2>/dev/null || true)"
  if [[ -n "$rust_sysroot" ]]; then
    rust_lld="$(find "$rust_sysroot" -name "rust-lld" -perm -111 2>/dev/null | head -n 1 || true)"
    if [[ -n "$rust_lld" ]]; then
      echo "Using toolchain rust-lld ($rust_lld) for lld-link..."
      ln -sf "$rust_lld" "$HOME/.local/bin/lld-link"
      ln -sf "$rust_lld" "$HOME/.local/bin/lld"
    fi
  fi
fi
export PATH="$HOME/.local/bin:$PATH"

if ! command -v clang >/dev/null 2>&1 || (! command -v lld >/dev/null 2>&1 && ! command -v lld-link >/dev/null 2>&1); then
  echo "ERROR: clang and lld/lld-link are required by cargo-xwin for MSVC cross-compilation." >&2
  exit 1
fi
clang --version | head -n 1
lld-link --version 2>/dev/null || lld --version | head -n 1

# 4. cargo-xwin installation & public SDK acquisition license acceptance
if ! command -v cargo-xwin >/dev/null 2>&1; then
  echo "Installing cargo-xwin..."
  xwin_version="0.18.6"
  if curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/rust-cross/cargo-xwin/releases/download/v${xwin_version}/cargo-xwin-v${xwin_version}-x86_64-unknown-linux-musl.tar.gz" -o /tmp/cargo-xwin.tar.gz 2>/dev/null; then
    tar -xzf /tmp/cargo-xwin.tar.gz -C "$HOME/.local/bin"
    rm -f /tmp/cargo-xwin.tar.gz
    chmod +x "$HOME/.local/bin/cargo-xwin"
  else
    cargo install --locked cargo-xwin
  fi
fi
cargo-xwin --version

# Accept official Microsoft Windows SDK license solely for official cargo-xwin acquisition
export XWIN_ACCEPT_LICENSE=1

# 5. Zig & cargo-zigbuild (full mode only)
if [[ "$mode" == "full" ]]; then
  zig_version=0.16.0
  zig_archive="$HOME/.cache/zig-x86_64-linux-${zig_version}.tar.xz"
  if ! command -v zig >/dev/null 2>&1 || [[ "$(zig version 2>/dev/null)" != "$zig_version" ]]; then
    mkdir -p "$HOME/.cache" "$HOME/.local/bin"
    echo "Downloading Zig $zig_version..."
    curl --proto '=https' --tlsv1.2 -fsSL \
      "https://ziglang.org/download/${zig_version}/zig-x86_64-linux-${zig_version}.tar.xz" \
      -o "$zig_archive"
    printf '%s  %s\n' '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00' "$zig_archive" \
      | sha256sum --check
    tar -xJf "$zig_archive" -C "$HOME/.cache"
    ln -sf "$HOME/.cache/zig-x86_64-linux-${zig_version}/zig" "$HOME/.local/bin/zig"
  fi
  export PATH="$HOME/.local/bin:$PATH"

  if ! command -v cargo-zigbuild >/dev/null 2>&1; then
    echo "Installing cargo-zigbuild..."
    cargo install --locked cargo-zigbuild
  fi
  zig version
  cargo-zigbuild --version
fi

# 5b. Focused Release Tests & Pre-cut Manifest Negative Control Proof
echo "=== 5b. Focused Release Tests & Pre-cut Manifest Negative Control Proof ==="

# Remote red proof against pre-cut original release-policy manifest:
# Negative control: temporary git-show original module file replaced during isolated test and restored trap
echo "Executing remote negative control proof against pre-cut release-policy manifest..."
policy_file="scripts/release-policy.ts"
policy_backup="$(mktemp)"
cp "$policy_file" "$policy_backup"
restore_policy() {
  if [[ -f "$policy_backup" ]]; then
    cp -f "$policy_backup" "$policy_file"
    rm -f "$policy_backup"
  fi
}
trap 'restore_policy; cleanup' EXIT INT TERM

# Obtain pre-cut original module file from origin/main (or ancestor 27bce50e16 in shallow clone)
if ! git show origin/main:"$policy_file" > "$policy_file" 2>/dev/null; then
  git fetch origin main:refs/remotes/origin/main --depth=1 2>/dev/null || true
fi
if ! git show origin/main:"$policy_file" > "$policy_file" 2>/dev/null; then
  echo "Obtaining pre-cut manifest from ancestor commit 27bce50e16..."
  git show "27bce50e16:$policy_file" > "$policy_file"
fi

# Run only new test that rejects macOS then require named assertion failure
set +e
negative_test_output="$(bun test scripts/release-policy.test.ts -t "rejects distribution assets outside the exact manifest, including omitted macOS artifacts" 2>&1)"
negative_test_status=$?
set -e

restore_policy
trap cleanup EXIT

if [[ $negative_test_status -eq 0 ]]; then
  echo "NEGATIVE_CONTROL_FAILED: Expected named assertion failure on pre-cut manifest, but test passed." >&2
  echo "$negative_test_output" >&2
  exit 1
fi

if ! echo "$negative_test_output" | grep -Eq "(expect\(received\)\.toEqual\(expected\)|fail|Assertion|1 fail)"; then
  echo "NEGATIVE_CONTROL_FAILED: Expected named assertion failure in output, but got:" >&2
  echo "$negative_test_output" >&2
  exit 1
fi
echo "NEGATIVE_CONTROL_PASSED: Pre-cut manifest correctly produced named assertion failure (exit $negative_test_status)."

# Run focused release tests on current implementation (expect all green)
echo "Running focused release tests on current implementation..."
bun test scripts/release-policy.test.ts \
  scripts/ci-release-build-binaries.test.ts \
  scripts/release-binaries-bytecode.test.ts \
  scripts/release-native-artifacts-match-ci.test.ts

echo "RELEASE_FOCUSED_TESTS: passed"

# 6. Build Native Addons
export CI=true

echo "Building Windows native addon: x86_64-pc-windows-msvc (baseline)..."
CROSS_TARGET=x86_64-pc-windows-msvc TARGET_PLATFORM=win32 TARGET_ARCH=x64 TARGET_VARIANTS=baseline CI=true \
  bun run ci:build:native

if [[ "$mode" == "full" ]]; then
  echo "Building Linux x64 native addons (baseline modern)..."
  CROSS_TARGET=x86_64-unknown-linux-gnu.2.17 TARGET_PLATFORM=linux TARGET_ARCH=x64 \
    TARGET_VARIANTS='baseline modern' CI=true bun run ci:build:native

  echo "Building Linux arm64 native addon..."
  CROSS_TARGET=aarch64-unknown-linux-gnu TARGET_PLATFORM=linux TARGET_ARCH=arm64 \
    CI=true bun run ci:build:native
fi

# 7. Build Distribution Binaries
binaries_dir="$repo_root/packages/coding-agent/binaries"
native_dir="$repo_root/natives/bridge/bindings/native"
mkdir -p "$binaries_dir"

if [[ "$mode" == "windows-proof" ]]; then
  echo "Compiling Windows production binary (RELEASE_TARGETS=win32-x64)..."
  RELEASE_TARGETS=win32-x64 bun run ci:release:build-binaries
else
  echo "Compiling Linux and Windows production binaries (RELEASE_TARGETS=linux-x64,linux-arm64,win32-x64)..."
  RELEASE_TARGETS=linux-x64,linux-arm64,win32-x64 bun run ci:release:build-binaries
fi

# 8. Assemble Release Distribution Artifacts & Generate Checksum Sidecars
echo "Assembling distribution artifacts and generating SHA-256 sidecars..."
if [[ -f "$native_dir/veyyon_natives.win32-x64-baseline.node" ]]; then
  cp -f "$native_dir/veyyon_natives.win32-x64-baseline.node" "$binaries_dir/"
fi

if [[ "$mode" == "full" ]]; then
  for addon in "$native_dir"/veyyon_natives.linux-*.node; do
    if [[ -f "$addon" ]]; then
      cp -f "$addon" "$binaries_dir/"
    fi
  done
fi

(
  cd "$binaries_dir"
  for f in veyyon-* veyyon_natives.*; do
    [[ -f "$f" ]] || continue
    case "$f" in *.sha256|*.json) continue ;; esac
    sha256sum "$f" > "$f.sha256"
  done

  shopt -s nullglob
  assets=(veyyon-* veyyon_natives.*)
  for asset in "${assets[@]}"; do
    case "$asset" in *.sha256|*.json) continue ;; esac
    digest="$(sha256sum "$asset" | awk '{print $1}')"
    printf '%s  %s\n' "$digest" "$asset"
  done | LC_ALL=C sort -k2 > local-assets.sha256
)

# 9. Execute Artifact Proof Validation
echo "Running artifact proof validation..."
bash "$repo_root/ci/cloudflare/artifact-proof.sh" "$mode"

echo "=== Veyyon Cloudflare Linux Release completed successfully ($mode) ==="
