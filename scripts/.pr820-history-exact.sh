#!/bin/bash
set -euo pipefail
cd /mnt/c/Users/wkiri/development/veyyon-wt/pr820-fix
VEYYON_SANDBOX_NODE_MODULES=/home/veyyon-test/sync1031-deps-checkout/node_modules bash scripts/test-sandbox/run.sh --rung=bwrap bun test packages/coding-agent/src/internal-urls/__tests__/history-exact.test.ts --timeout 30000
