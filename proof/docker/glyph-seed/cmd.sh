#!/usr/bin/env bash
# Seeds one resumed session holding a file search over C# sources, then starts the CLI on it.
set -e
dest="${HOME}/.veyyon/profiles/${VEYYON_PROFILE:-default}/agent/sessions/-demo"
mkdir -p "${dest}"
cp /repo/proof/docker/glyph-seed/*.jsonl "${dest}/"
exec bun /repo/packages/coding-agent/src/cli.ts --continue --model local/qwen2.5-1.5b
