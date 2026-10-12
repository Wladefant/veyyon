#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

mode="${1:-windows-proof}"
if [[ "$mode" != "windows-proof" && "$mode" != "full" ]]; then
  echo "Usage: $0 [windows-proof|full]" >&2
  exit 1
fi

echo "=== Veyyon Artifact Proof ($mode) ==="

binaries_dir="$repo_root/packages/coding-agent/binaries"
native_dir="$repo_root/natives/bridge/bindings/native"

# 1. Exact local expected asset list check
missing_assets=0
check_file_exists() {
  local file="$1"
  local desc="$2"
  if [[ ! -f "$file" ]]; then
    echo "FAIL: Missing expected asset: $file ($desc)" >&2
    missing_assets=$((missing_assets + 1))
    return 1
  fi
  local size
  size="$(wc -c < "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo 0)"
  if (( size == 0 )); then
    echo "FAIL: Expected asset is 0 bytes: $file ($desc)" >&2
    missing_assets=$((missing_assets + 1))
    return 1
  fi
  echo "OK: Found asset ($size bytes): $file"
}

# Windows subset assets
check_file_exists "$binaries_dir/veyyon-windows-x64.exe" "Windows CLI executable" || true
check_file_exists "$binaries_dir/veyyon-windows-x64.exe.sha256" "Windows CLI checksum sidecar" || true
check_file_exists "$binaries_dir/veyyon_natives.win32-x64-baseline.node" "Windows native addon in release binaries" || true
check_file_exists "$binaries_dir/veyyon_natives.win32-x64-baseline.node.sha256" "Windows native addon checksum sidecar" || true
check_file_exists "$native_dir/veyyon_natives.win32-x64-baseline.node" "Windows native addon in package native dir" || true
check_file_exists "$binaries_dir/local-assets.sha256" "Release bundle checksum manifest" || true

if [[ "$mode" == "full" ]]; then
  check_file_exists "$binaries_dir/veyyon-linux-x64" "Linux x64 CLI executable" || true
  check_file_exists "$binaries_dir/veyyon-linux-x64.sha256" "Linux x64 CLI checksum sidecar" || true
  check_file_exists "$binaries_dir/veyyon-linux-arm64" "Linux arm64 CLI executable" || true
  check_file_exists "$binaries_dir/veyyon-linux-arm64.sha256" "Linux arm64 CLI checksum sidecar" || true
  check_file_exists "$binaries_dir/veyyon_natives.linux-x64-baseline.node" "Linux x64 baseline native addon in binaries" || true
  check_file_exists "$binaries_dir/veyyon_natives.linux-x64-baseline.node.sha256" "Linux x64 baseline native addon checksum" || true
  check_file_exists "$binaries_dir/veyyon_natives.linux-x64-modern.node" "Linux x64 modern native addon in binaries" || true
  check_file_exists "$binaries_dir/veyyon_natives.linux-x64-modern.node.sha256" "Linux x64 modern native addon checksum" || true
  check_file_exists "$binaries_dir/veyyon_natives.linux-arm64.node" "Linux arm64 native addon in binaries" || true
  check_file_exists "$binaries_dir/veyyon_natives.linux-arm64.node.sha256" "Linux arm64 native addon checksum" || true
  check_file_exists "$native_dir/veyyon_natives.linux-x64-baseline.node" "Linux x64 baseline addon in native dir" || true
  check_file_exists "$native_dir/veyyon_natives.linux-x64-modern.node" "Linux x64 modern addon in native dir" || true
  check_file_exists "$native_dir/veyyon_natives.linux-arm64.node" "Linux arm64 addon in native dir" || true
fi

if (( missing_assets > 0 )); then
  echo "ERROR: Artifact check failed: $missing_assets required asset(s) missing or empty." >&2
  exit 1
fi

# 2. Binary PE / ELF signature proof validation
signature_failures=0

validate_pe_amd64() {
  local target="$1"
  local label="$2"
  echo "Validating PE AMD64 signature for $label: $target..."

  # Python 3 / Bun header inspector
  local inspect_status=0
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import sys, struct
path = sys.argv[1]
with open(path, 'rb') as f:
    dos = f.read(64)
    if len(dos) < 64 or dos[:2] != b'MZ':
        sys.exit(f'FAIL: {path} missing MZ DOS signature')
    e_lfanew = struct.unpack('<I', dos[60:64])[0]
    f.seek(e_lfanew)
    pe = f.read(4)
    if pe != b'PE\x00\x00':
        sys.exit(f'FAIL: {path} missing PE\\0\\0 signature at offset {e_lfanew}')
    coff = f.read(20)
    if len(coff) < 20:
        sys.exit(f'FAIL: {path} truncated COFF header')
    machine = struct.unpack('<H', coff[:2])[0]
    if machine != 0x8664:
        sys.exit(f'FAIL: {path} machine 0x{machine:04x} != 0x8664 (AMD64)')
print(f'OK: Valid PE32+ (AMD64 / x86-64) signature verified for {path}')
" "$target" || inspect_status=$?
  elif command -v bun >/dev/null 2>&1 || command -v node >/dev/null 2>&1; then
    local js_engine
    js_engine="$(command -v bun 2>/dev/null || command -v node 2>/dev/null)"
    "$js_engine" -e '
const fs = require("fs");
const path = process.argv[1];
const buf = fs.readFileSync(path);
if (buf.length < 64 || buf.toString("ascii", 0, 2) !== "MZ") {
  console.error(`FAIL: ${path} missing MZ DOS signature`);
  process.exit(1);
}
const e_lfanew = buf.readUInt32LE(60);
if (buf.toString("ascii", e_lfanew, e_lfanew + 4) !== "PE\0\0") {
  console.error(`FAIL: ${path} missing PE\\0\\0 signature at offset ${e_lfanew}`);
  process.exit(1);
}
const machine = buf.readUInt16LE(e_lfanew + 4);
if (machine !== 0x8664) {
  console.error(`FAIL: ${path} machine 0x${machine.toString(16)} != 0x8664 (AMD64)`);
  process.exit(1);
}
console.log(`OK: Valid PE32+ (AMD64 / x86-64) signature verified for ${path}`);
' "$target" || inspect_status=$?
  else
    echo "ERROR: Neither python3 nor bun/node available for binary validation." >&2
    inspect_status=1
  fi

  if (( inspect_status != 0 )); then
    signature_failures=$((signature_failures + 1))
  fi
}

validate_elf() {
  local target="$1"
  local arch="$2"
  local label="$3"
  echo "Validating ELF $arch signature for $label: $target..."

  local inspect_status=0
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import sys, struct
path, arch = sys.argv[1], sys.argv[2]
with open(path, 'rb') as f:
    ident = f.read(16)
    if len(ident) < 16 or ident[:4] != b'\x7fELF':
        sys.exit(f'FAIL: {path} missing \\x7fELF magic')
    if ident[4] != 2:
        sys.exit(f'FAIL: {path} not 64-bit ELF (class {ident[4]})')
    hdr = f.read(8)
    e_type, e_machine = struct.unpack('<HH', hdr[0:4])
    if arch == 'x64' and e_machine != 62:
        sys.exit(f'FAIL: {path} machine {e_machine} != 62 (x86-64)')
    elif arch == 'arm64' and e_machine != 183:
        sys.exit(f'FAIL: {path} machine {e_machine} != 183 (AArch64)')
print(f'OK: Valid ELF 64-bit {arch} signature verified for {path}')
" "$target" "$arch" || inspect_status=$?
  else
    echo "WARN: python3 unavailable for ELF inspection, checking magic via od"
    if ! od -An -N4 -tx1 "$target" | tr -d ' \n' | grep -q '7f454c46'; then
      echo "FAIL: $target is not an ELF binary" >&2
      inspect_status=1
    fi
  fi

  if (( inspect_status != 0 )); then
    signature_failures=$((signature_failures + 1))
  fi
}

validate_pe_amd64 "$binaries_dir/veyyon-windows-x64.exe" "Windows CLI binary"
validate_pe_amd64 "$binaries_dir/veyyon_natives.win32-x64-baseline.node" "Windows native addon in binaries"
validate_pe_amd64 "$native_dir/veyyon_natives.win32-x64-baseline.node" "Windows native addon in native dir"

if [[ "$mode" == "full" ]]; then
  validate_elf "$binaries_dir/veyyon-linux-x64" "x64" "Linux x64 binary"
  validate_elf "$binaries_dir/veyyon-linux-arm64" "arm64" "Linux arm64 binary"
  validate_elf "$binaries_dir/veyyon_natives.linux-x64-baseline.node" "x64" "Linux x64 baseline addon"
  validate_elf "$binaries_dir/veyyon_natives.linux-x64-modern.node" "x64" "Linux x64 modern addon"
  validate_elf "$binaries_dir/veyyon_natives.linux-arm64.node" "arm64" "Linux arm64 addon"
fi

if (( signature_failures > 0 )); then
  echo "ERROR: Signature validation failed with $signature_failures error(s)." >&2
  exit 1
fi

# 3. Checksum sidecars verification
checksum_failures=0
verify_sidecar() {
  local file="$1"
  local sidecar="$file.sha256"
  if [[ ! -f "$sidecar" ]]; then
    echo "FAIL: Missing sidecar: $sidecar" >&2
    checksum_failures=$((checksum_failures + 1))
    return 1
  fi

  local expected_hash actual_hash
  expected_hash="$(awk '{print $1}' "$sidecar" | tr -d '\r\n[:space:]')"
  if command -v sha256sum >/dev/null 2>&1; then
    actual_hash="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_hash="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    actual_hash="$(python3 -c "import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], 'rb').read()).hexdigest())" "$file")"
  fi

  if [[ "$expected_hash" != "$actual_hash" ]]; then
    echo "FAIL: Checksum mismatch for $file! Expected $expected_hash, computed $actual_hash" >&2
    checksum_failures=$((checksum_failures + 1))
    return 1
  fi
  echo "OK: Verified sidecar $sidecar ($actual_hash)"
}

verify_sidecar "$binaries_dir/veyyon-windows-x64.exe"
verify_sidecar "$binaries_dir/veyyon_natives.win32-x64-baseline.node"

if [[ "$mode" == "full" ]]; then
  verify_sidecar "$binaries_dir/veyyon-linux-x64"
  verify_sidecar "$binaries_dir/veyyon-linux-arm64"
  verify_sidecar "$binaries_dir/veyyon_natives.linux-x64-baseline.node"
  verify_sidecar "$binaries_dir/veyyon_natives.linux-x64-modern.node"
  verify_sidecar "$binaries_dir/veyyon_natives.linux-arm64.node"
fi

# Verify local-assets.sha256 manifest
if [[ -f "$binaries_dir/local-assets.sha256" ]]; then
  echo "Verifying $binaries_dir/local-assets.sha256 manifest..."
  (
    cd "$binaries_dir"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum -c "local-assets.sha256" || checksum_failures=$((checksum_failures + 1))
    elif command -v shasum >/dev/null 2>&1; then
      shasum -a 256 -c "local-assets.sha256" || checksum_failures=$((checksum_failures + 1))
    fi
  )
fi

if (( checksum_failures > 0 )); then
  echo "ERROR: Checksum validation failed with $checksum_failures mismatch(es)." >&2
  exit 1
fi

# 4. Runtime load verification (if Wine is available)
wine_load_status="unavailable"
wine_bin="$(command -v wine64 2>/dev/null || command -v wine 2>/dev/null || true)"
if [[ -n "$wine_bin" ]]; then
  echo "Checking Windows binary runtime execution with $wine_bin..."
  load_output=""
  if load_output="$(WINEDEBUG=-all "$wine_bin" "$binaries_dir/veyyon-windows-x64.exe" --version 2>&1)"; then
    echo "WIN32_RUNTIME_LOAD=passed"
    echo "Output: $load_output"
    wine_load_status="passed"
  else
    echo "FAIL: WIN32_RUNTIME_LOAD=failed (wine execution returned non-zero exit code)" >&2
    echo "Error output: $load_output" >&2
    exit 1
  fi
else
  echo "WIN32_RUNTIME_LOAD=unavailable (wine is not installed on host)"
  wine_load_status="unavailable"
fi

# 5. Produce receipt with SHA and file hashes
git_sha="$(git rev-parse HEAD 2>/dev/null || echo "unknown")"
timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
receipt_json_path="$repo_root/ci/cloudflare/release-receipt.json"
binaries_receipt_path="$binaries_dir/release-receipt.json"

cat <<EOF > "$receipt_json_path"
{
  "status": "PASS",
  "sha": "$git_sha",
  "mode": "$mode",
  "timestamp": "$timestamp",
  "wine_runtime_load": "$wine_load_status",
  "assets": [
EOF

first=1
for asset in "$binaries_dir"/veyyon-* "$binaries_dir"/veyyon_natives.*; do
  [[ -f "$asset" ]] || continue
  case "$asset" in *.sha256|*.json) continue ;; esac
  hash="$(sha256sum "$asset" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$asset" | awk '{print $1}')"
  size="$(wc -c < "$asset" | tr -d ' ')"
  fname="$(basename "$asset")"

  if (( first == 0 )); then
    echo "    ," >> "$receipt_json_path"
  fi
  first=0
  cat <<ENTRY >> "$receipt_json_path"
    {
      "name": "$fname",
      "path": "$asset",
      "size": $size,
      "sha256": "$hash"
    }
ENTRY
done

cat <<EOF >> "$receipt_json_path"
  ]
}
EOF

cp -f "$receipt_json_path" "$binaries_receipt_path"

echo ""
echo "============================================================"
echo "RECEIPT: PASS $git_sha"
echo "Mode: $mode"
echo "Timestamp: $timestamp"
echo "Wine Runtime Load: $wine_load_status"
echo "Artifact Hashes:"
while IFS= read -r line; do
  echo "  $line"
done < <(cat "$binaries_dir/local-assets.sha256" 2>/dev/null || true)
echo "Receipt written to $receipt_json_path"
echo "============================================================"
echo "CLOUDFLARE_PROOF_STATUS=passed"
