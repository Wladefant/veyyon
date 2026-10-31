#!/usr/bin/env bash
# Run a step in a new session and reap its whole process group on every exit path.
set -uo pipefail

child_pid=
cleaning=0

make_owner() {
  local workspace="${GITHUB_WORKSPACE:-$PWD}"
  if [[ -n "${GITHUB_RUN_ID:-}" && -n "${GITHUB_RUN_ATTEMPT:-}" && -n "${GITHUB_JOB:-}" ]]; then
    printf '%s|%s|%s|%s|%s' "$workspace" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$GITHUB_JOB" "${OVH_MATRIX_INDEX:-}"
  else
    printf '%s|local|%s' "$workspace" "$$"
  fi
}

if [[ "${1:-}" == "--cleanup" ]]; then
  if [[ -z "${GITHUB_WORKSPACE:-}" || -z "${GITHUB_RUN_ID:-}" || -z "${GITHUB_RUN_ATTEMPT:-}" || -z "${GITHUB_JOB:-}" ]]; then
    echo '::error::Process cleanup requires GitHub workspace, run, attempt, and job identity' >&2
    exit 2
  fi
  owner="$(make_owner)"
  token="OVH_PROCESS_OWNER=$owner"
  own_pgid="$(ps -o pgid= -p "$$" | tr -d '[:space:]')"
  scan_matching_groups() {
    local proc pid pgid
    local -A seen=()
    MATCHING_GROUPS=()
    for proc in /proc/[0-9]*; do
      [[ -r "$proc/environ" ]] || continue
      grep -zFqx -- "$token" "$proc/environ" 2>/dev/null || continue
      pid="${proc##*/}"
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
      [[ "$pgid" =~ ^[0-9]+$ && "$pgid" -gt 1 && "$pgid" != "$own_pgid" ]] || continue
      [[ -n "${seen[$pgid]:-}" ]] && continue
      seen[$pgid]=1
      MATCHING_GROUPS+=("$pgid")
    done
  }
  scan_matching_groups
  for pgid in "${MATCHING_GROUPS[@]}"; do kill -TERM -- "-$pgid" 2>/dev/null || true; done
  sleep 1
  scan_matching_groups
  for pgid in "${MATCHING_GROUPS[@]}"; do kill -KILL -- "-$pgid" 2>/dev/null || true; done
  exit 0
fi

if (($# == 0)); then
  echo 'usage: ovh-process-group.sh COMMAND [ARG...] | --cleanup' >&2
  exit 2
fi

owner="$(make_owner)"
cleanup() {
  trap '' INT TERM
  local i
  (( cleaning )) && return
  cleaning=1
  if [[ -n "$child_pid" ]]; then
    for ((i = 0; i < 10; i++)); do
      kill -TERM "$child_pid" 2>/dev/null || true
      kill -TERM -- "-$child_pid" 2>/dev/null || true
      if ! kill -0 "$child_pid" 2>/dev/null && ! kill -0 -- "-$child_pid" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$child_pid" 2>/dev/null; then
      kill -KILL "$child_pid" 2>/dev/null || true
    fi
    if kill -0 -- "-$child_pid" 2>/dev/null; then
      kill -KILL -- "-$child_pid" 2>/dev/null || true
    fi
    wait "$child_pid" 2>/dev/null || true
  fi
}

on_signal() {
  trap '' INT TERM
  local signal="$1" status="$2"
  if [[ -z "$child_pid" && -n "${!:-}" ]]; then
    child_pid=$!
  fi
  if [[ -n "$child_pid" ]]; then
    kill -s "$signal" -- "-$child_pid" 2>/dev/null || true
    kill -s "$signal" "$child_pid" 2>/dev/null || true
  fi
  cleanup
  exit "$status"
}

trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap cleanup EXIT


# Traps exist before the asynchronous setsid launch.
setsid env "OVH_PROCESS_OWNER=$owner" timeout --kill-after=30s "${OVH_STEP_TIMEOUT:-12m}" "$@" &
child_pid=$!
wait "$child_pid"
status=$?
exit "$status"
