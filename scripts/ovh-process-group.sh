#!/usr/bin/env bash
# Run a step in a new session and reap its whole process group on every exit path.
set -uo pipefail

child_pid=
cleaning=0

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

if (($# == 0)); then
  echo 'usage: ovh-process-group.sh COMMAND [ARG...]' >&2
  exit 2
fi

# Traps exist before the asynchronous setsid launch.
setsid -- "$@" &
child_pid=$!
wait "$child_pid"
status=$?
exit "$status"
