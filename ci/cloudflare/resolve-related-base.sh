#!/usr/bin/env bash
set -Eeuo pipefail

error='ERROR: cannot resolve the related-test base against origin/main'

try_merge_base() {
  local base
  if base="$(git merge-base HEAD origin/main 2>/dev/null)" && [[ "$base" =~ ^[0-9a-fA-F]{40}$ ]]; then
    printf '%s\n' "$base"
    return 0
  fi
  return 1
}

if ! git rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}' >/dev/null; then
  git fetch --no-tags --depth=20 origin '+refs/heads/main:refs/remotes/origin/main' >/dev/null
fi

if try_merge_base; then
  exit 0
fi

for depth in 100 500; do
  git fetch --no-tags "--depth=$depth" origin '+refs/heads/main:refs/remotes/origin/main' >/dev/null
  if try_merge_base; then
    exit 0
  fi
done

if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
  git fetch --no-tags --unshallow origin '+refs/heads/main:refs/remotes/origin/main' >/dev/null
  if try_merge_base; then
    exit 0
  fi
fi

printf '%s\n' "$error" >&2
exit 1
