#!/usr/bin/env bash
# Starts a broker holding two Codex logins, then runs `veyyon usage` against it
# the way a user with a configured broker does, and holds the output on screen.
port=18431
token=proof-token
bun /repo/proof/docker/codex-usage-seed/broker.ts "${port}" "${token}" "${TMPDIR:-/tmp}/codex-usage-broker.db" &
for _ in $(seq 1 50); do
	curl -fsS "http://127.0.0.1:${port}/v1/healthz" >/dev/null 2>&1 && break
	sleep 0.2
done
clear
VEYYON_AUTH_BROKER_URL="http://127.0.0.1:${port}" VEYYON_AUTH_BROKER_TOKEN="${token}" \
	bun /repo/packages/coding-agent/src/cli.ts usage --provider openai-codex || echo "usage exited $?" >&2
exec sleep 600
