#!/usr/bin/env bash
# Full gate before pushing: build, typecheck, unit tests, e2e. Usage: scripts/verify.sh [--no-e2e]
set -euo pipefail
cd "$(dirname "$0")/.."
export GHOST_DECISION_PROVIDER=heuristic GHOST_TEXT_PROVIDER=template
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
step build;     pnpm build
step typecheck; pnpm typecheck
step unit;      pnpm test
if [ "${1:-}" != "--no-e2e" ]; then step e2e; pnpm --filter @ghost/e2e e2e; fi
step "secrets scan"
if git grep -nE 'xai-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{30,}|vck_[A-Za-z0-9]{20,}' -- . ':!pnpm-lock.yaml' ; then echo "possible secret in tracked files"; exit 1; fi
echo "verify: all green"
