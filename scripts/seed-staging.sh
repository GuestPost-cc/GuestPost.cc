#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -t 0 ]]; then
  printf 'Run this script from an interactive terminal so the database URL stays hidden.\n' >&2
  exit 1
fi

# Resolve the package manager before asking for a database credential. A Bash
# script launched from macOS Terminal may not inherit the interactive zsh PATH.
PNPM_BIN="$(command -v pnpm || true)"
COREPACK_BIN="$(command -v corepack || true)"
ZSH_BIN="$(command -v zsh || true)"
RUNNER=""

if [[ -n "$PNPM_BIN" ]] && "$PNPM_BIN" --version >/dev/null 2>&1; then
  RUNNER="pnpm"
elif [[ -n "$COREPACK_BIN" ]] && "$COREPACK_BIN" pnpm@11.5.1 --version >/dev/null 2>&1; then
  RUNNER="corepack"
elif [[ -n "$ZSH_BIN" ]] && "$ZSH_BIN" -ilc \
  'command -v pnpm >/dev/null 2>&1 || command -v corepack >/dev/null 2>&1' \
  >/dev/null 2>&1; then
  RUNNER="zsh"
else
  printf 'pnpm/Corepack is unavailable. Install Node.js and enable Corepack, then rerun this script.\n' >&2
  exit 127
fi

# Never reuse a URL inherited from the caller if hidden input is cancelled.
unset DATABASE_URL
if ! IFS= read -r -s -p 'Direct Neon neondb_owner URL for guestpost-staging (non-pooled): ' DATABASE_URL; then
  printf '\nStaging seed cancelled; no database write was started.\n' >&2
  exit 1
fi
printf '\n' >&2

if [[ -z "$DATABASE_URL" ]]; then
  printf 'Staging seed cancelled; no database URL was entered.\n' >&2
  exit 1
fi

export DATABASE_URL
export NODE_ENV=production
export SEED_MODE=staging
export SEED_API_URL=https://api.shohan.iam.bd
export SEED_STAGING_CONFIRMATION=guestpost-staging:br-empty-resonance-b5fnktnx

case "$RUNNER" in
  pnpm)
    exec "$PNPM_BIN" seed
    ;;
  corepack)
    exec "$COREPACK_BIN" pnpm@11.5.1 seed
    ;;
  zsh)
    exec "$ZSH_BIN" -ilc 'cd "$1" && if command -v pnpm >/dev/null 2>&1; then exec pnpm seed; else exec corepack pnpm@11.5.1 seed; fi' seed-staging "$ROOT_DIR"
    ;;
esac
