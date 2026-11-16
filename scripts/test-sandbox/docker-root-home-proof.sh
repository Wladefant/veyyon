#!/usr/bin/env bash
# docker-root-home-proof.sh
# Focused standalone shell regression proof for the docker sandbox rung when run as
# host root (HOST_HOME=/root), as occurs under WSL root invocations.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && /bin/pwd -P)"

if [ "$(id -u)" -ne 0 ]; then
	echo "docker-root-home-proof requires host uid 0 (root). Current uid: $(id -u)" >&2
	exit 1
fi

export HOST_HOME="/root"
export REPO_ROOT
export GUEST_REPO="${REPO_ROOT}"
BUN_VERSION="${BUN_VERSION:-1.4.3}"
export GUEST_IMAGE="${VEYYON_SANDBOX_GUEST_IMAGE:-veyyon-test-guest:${BUN_VERSION}}"
export SANDBOX_GITDIR=""
export VEYYON_SANDBOX_REPO_RO=1

log() { printf '[proof] %s\n' "$*"; }
die() { printf '[proof:fatal] %s\n' "$*" >&2; exit 1; }
skip() { printf '[proof:skip] %s: %s\n' "$1" "$2" >&2; }

# Set up shim directory for negative control argument filtering
SHIM_DIR="$(mktemp -d /tmp/docker-shim-bin.XXXXXX)"
REAL_DOCKER="$(command -v docker 2>/dev/null || echo "/usr/local/bin/docker")"

cat > "${SHIM_DIR}/docker" << 'SHIM_EOF'
#!/usr/bin/env bash
real_docker="${REAL_DOCKER_BIN:-/usr/local/bin/docker}"
if [ "${UNMASK_ROOT:-0}" = "1" ]; then
	filtered=()
	while [ $# -gt 0 ]; do
		case "$1" in
			--tmpfs)
				if [ "${2%%:*}" = "/root" ]; then
					shift 2
					continue
				fi
				filtered+=("$1" "$2")
				shift 2
				;;
			*)
				filtered+=("$1")
				shift
				;;
		esac
	done
	exec "$real_docker" "${filtered[@]}"
fi
exec "$real_docker" "$@"
SHIM_EOF
chmod +x "${SHIM_DIR}/docker"

export REAL_DOCKER_BIN="${REAL_DOCKER}"
export PATH="${SHIM_DIR}:${PATH}"

. "${SCRIPT_DIR}/rungs/docker.sh"

assertions_run=0
assertions_passed=0
assertions_failed=0

assert() {
	local desc="$1"
	shift
	assertions_run=$((assertions_run + 1))
	if "$@"; then
		assertions_passed=$((assertions_passed + 1))
		printf '  ok %d - %s\n' "$assertions_run" "$desc"
	else
		assertions_failed=$((assertions_failed + 1))
		printf '  not ok %d - %s\n' "$assertions_run" "$desc" >&2
	fi
}

SENTINEL_NAME="veyyon-proof-sentinel-$(date +%s%N)-$$-$RANDOM"
SENTINEL_PATH="/root/${SENTINEL_NAME}"
SENTINEL_SECRET="secret-payload-${RANDOM}-${RANDOM}"
HOSTILE_WRITE_FILE="hostile-probe-write-$(date +%s%N)-$$-$RANDOM"
GUEST_CAPTURE_FILE="$(mktemp /tmp/docker-guest-capture.XXXXXX)"

cleanup() {
	rm -f "${SENTINEL_PATH}" "${GUEST_CAPTURE_FILE}" "/root/${HOSTILE_WRITE_FILE}" 2>/dev/null || true
	rm -rf "${SHIM_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

printf '%s\n' "${SENTINEL_SECRET}" > "${SENTINEL_PATH}"
chmod 0600 "${SENTINEL_PATH}"

assert "host sentinel created in /root" test -f "${SENTINEL_PATH}"

probe_ok=0
probe_docker >/dev/null 2>&1 && probe_ok=1 || probe_ok=0
assert "docker rung probe succeeds" [ "$probe_ok" -eq 1 ]

guest_status=0
run_docker /bin/sh -c '
set +e
guest_uid="$(id -u)"
guest_home="${HOME:-}"

read_before_status=0
ls -la /root >/dev/null 2>&1 || read_before_status=$?

sentinel_read_status=0
cat "/root/'"${SENTINEL_NAME}"'" >/dev/null 2>&1 || sentinel_read_status=$?

write_status=0
touch "/root/'"${HOSTILE_WRITE_FILE}"'" >/dev/null 2>&1 || write_status=$?

overwrite_sentinel_status=0
printf "overwritten\n" > "/root/'"${SENTINEL_NAME}"'" 2>/dev/null || overwrite_sentinel_status=$?

chmod_status=0
chmod 0777 /root >/dev/null 2>&1 || chmod_status=$?

read_after_chmod_status=0
ls -la /root >/dev/null 2>&1 || read_after_chmod_status=$?

sentinel_after_chmod_status=0
cat "/root/'"${SENTINEL_NAME}"'" >/dev/null 2>&1 || sentinel_after_chmod_status=$?

printf "GUEST_UID=%s\n" "$guest_uid"
printf "GUEST_HOME=%s\n" "$guest_home"
printf "READ_BEFORE=%d\n" "$read_before_status"
printf "SENTINEL_READ=%d\n" "$sentinel_read_status"
printf "WRITE=%d\n" "$write_status"
printf "OVERWRITE_SENTINEL=%d\n" "$overwrite_sentinel_status"
printf "CHMOD=%d\n" "$chmod_status"
printf "READ_AFTER_CHMOD=%d\n" "$read_after_chmod_status"
printf "SENTINEL_AFTER_CHMOD=%d\n" "$sentinel_after_chmod_status"
' > "${GUEST_CAPTURE_FILE}" 2>&1 || guest_status=$?

assert "hostile guest command ran without runner error" [ "$guest_status" -eq 0 ]

get_metric() {
	local key="$1"
	local val
	val="$(grep "^${key}=" "${GUEST_CAPTURE_FILE}" 2>/dev/null | head -n 1 | cut -d= -f2-)"
	if [ -z "${val}" ]; then
		echo "MISSING"
	else
		echo "${val}"
	fi
}

guest_uid_val="$(get_metric GUEST_UID)"
guest_home_val="$(get_metric GUEST_HOME)"
read_before_val="$(get_metric READ_BEFORE)"
sentinel_read_val="$(get_metric SENTINEL_READ)"
write_val="$(get_metric WRITE)"
overwrite_sentinel_val="$(get_metric OVERWRITE_SENTINEL)"
chmod_val="$(get_metric CHMOD)"
read_after_chmod_val="$(get_metric READ_AFTER_CHMOD)"
sentinel_after_chmod_val="$(get_metric SENTINEL_AFTER_CHMOD)"

assert "guest uid is 0" [ "${guest_uid_val}" = "0" ]
assert "guest HOME is /sandbox/home" [ "${guest_home_val}" = "/sandbox/home" ]
assert "guest cannot read /root before chmod" [ "${read_before_val}" != "MISSING" ] && [ "${read_before_val}" -ne 0 ]
assert "guest cannot read host sentinel" [ "${sentinel_read_val}" != "MISSING" ] && [ "${sentinel_read_val}" -ne 0 ]
assert "guest cannot write new file to /root" [ "${write_val}" != "MISSING" ] && [ "${write_val}" -ne 0 ]
assert "guest cannot overwrite host sentinel in /root" [ "${overwrite_sentinel_val}" != "MISSING" ] && [ "${overwrite_sentinel_val}" -ne 0 ]
assert "guest chmod on /root explicitly fails" [ "${chmod_val}" != "MISSING" ] && [ "${chmod_val}" -ne 0 ]
assert "guest cannot read /root even after chmod attempt" [ "${read_after_chmod_val}" != "MISSING" ] && [ "${read_after_chmod_val}" -ne 0 ]
assert "guest cannot read host sentinel after chmod attempt" [ "${sentinel_after_chmod_val}" != "MISSING" ] && [ "${sentinel_after_chmod_val}" -ne 0 ]

host_sentinel_content="$(cat "${SENTINEL_PATH}" 2>/dev/null || true)"
assert "host sentinel was not modified or removed" [ "${host_sentinel_content}" = "${SENTINEL_SECRET}" ]
assert "no hostile file created in host /root" test ! -e "/root/${HOSTILE_WRITE_FILE}"

gate_test_status=0
gate_test_out="$(run_docker bun test packages/utils/test/abortable.test.ts 2>&1)" || gate_test_status=$?

if [ "$gate_test_status" -eq 0 ]; then
	assert "real sandbox gate passes with masked /root" [ "$gate_test_status" -eq 0 ]
else
	assert "baseline gate refusal verified: clause [C] refuses unmasked /root" grep -q "\[C\] /root" <<< "${gate_test_out}"
fi

# Negative control: remove only the /root mask using the docker argument shim
negative_status=0
negative_out="$(UNMASK_ROOT=1 run_docker bun test packages/utils/test/abortable.test.ts 2>&1)" || negative_status=$?

assert "negative control (unmasked /root) exits nonzero" [ "$negative_status" -ne 0 ]
assert "negative control refusal cites operator home reach" grep -q "REFUSED: this test process cannot prove the operator's home is out of reach" <<< "${negative_out}"
assert "negative control refusal cites clause [C] for /root" grep -q "\[C\] /root" <<< "${negative_out}"

printf '\n=== docker-root-home-proof summary: %d passed, %d failed (total %d) ===\n' \
	"$assertions_passed" "$assertions_failed" "$assertions_run"

if [ "$assertions_failed" -gt 0 ]; then
	exit 1
fi
exit 0
