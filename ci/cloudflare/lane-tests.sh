#!/usr/bin/env bash
set -Eeuo pipefail

# Temporary proof branch: invoke windows-proof directly
exec bash ci/cloudflare/release-linux.sh windows-proof
