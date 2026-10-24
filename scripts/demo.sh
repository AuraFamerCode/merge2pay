#!/usr/bin/env bash
# Runs the demo sequence from DEMO_SCRIPT.md with pauses, for screen recording.
# Usage: scripts/demo.sh   (press Enter to advance each step)
set -euo pipefail
cd "$(dirname "$0")/.."
export FORCE_COLOR=1
M2P="node dist/cli.js"

step() {
  printf '\n\033[36m❯\033[0m \033[1m%s\033[0m' "$*"
  read -r _
  eval "$*"
}

[ -f dist/cli.js ] || npm run build >/dev/null
rm -f /tmp/m2p-demo-ledger.json

step "$M2P doctor"
step "$M2P fund honojs/hono#5520 --amount 15 --ledger /tmp/m2p-demo-ledger.json"
step "$M2P verify https://github.com/honojs/hono/pull/5547 --issue honojs/hono#5345 --submitter usualoma"
step "$M2P settle --fixtures examples/demo/gibwork-fixtures.json --ledger examples/demo/ledger.json --report /tmp/settlement-report.md"
step "head -n 20 /tmp/settlement-report.md"
step "npm test --silent 2>&1 | tail -n 9"
printf '\n'
