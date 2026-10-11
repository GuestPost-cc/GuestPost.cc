#!/usr/bin/env bash
set -euo pipefail

# Creates the guestpost_test_template database used by integration tests.
# Handles both docker (local dev) and direct psql (CI/GitHub Actions).
#
# Usage:
#   pnpm run setup:integration-test-db
#   # or
#   bash scripts/setup-integration-test-db.sh

cd "$(dirname "$0")/.."

PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-guestpost}"
PG_PASS="${PG_PASS:-guestpost}"
TEMPLATE_DB="guestpost_test_template"

if docker inspect gp-postgres >/dev/null 2>&1; then
  echo "==> Using docker exec gp-postgres"
  psql_db() {
    local database="$1"
    shift
    docker exec -e "PGPASSWORD=${PG_PASS}" gp-postgres \
      psql -X -U "${PG_USER}" -d "${database}" "$@"
  }
else
  echo "==> Using direct psql to ${PG_HOST}:${PG_PORT}"
  psql_db() {
    local database="$1"
    shift
    PGPASSWORD="${PG_PASS}" psql -X -h "${PG_HOST}" -p "${PG_PORT}" \
      -U "${PG_USER}" -d "${database}" "$@"
  }
fi

echo "==> Provisioning migration-owned financial repair roles"
psql_db postgres -v ON_ERROR_STOP=1 \
  -f scripts/provision-financial-repair-guard-role.sql

echo "==> Creating template database: ${TEMPLATE_DB}"

# Drop if exists (for idempotency)
psql_db postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"${TEMPLATE_DB}\" WITH (FORCE)" 2>/dev/null || true

psql_db postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"${TEMPLATE_DB}\""

TEMPLATE_URL="postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${TEMPLATE_DB}"

echo "==> Running prisma migrate deploy on ${TEMPLATE_DB}"
cd packages/database
DATABASE_URL="${TEMPLATE_URL}" npx prisma migrate deploy

echo "==> Done. Integration test template '${TEMPLATE_DB}' is ready."
