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

# Detect psql command — prefer docker exec if the gp-postgres container is running
if docker inspect gp-postgres >/dev/null 2>&1; then
  PSQL="docker exec gp-postgres psql -U ${PG_USER} -d postgres -c"
  echo "==> Using docker exec gp-postgres"
else
  PSQL="psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d postgres -c"
  echo "==> Using direct psql to ${PG_HOST}:${PG_PORT}"
fi

echo "==> Creating template database: ${TEMPLATE_DB}"

# Drop if exists (for idempotency)
PGPASSWORD="${PG_PASS}" ${PSQL} "DROP DATABASE IF EXISTS \"${TEMPLATE_DB}\" WITH (FORCE)" 2>/dev/null || true

PGPASSWORD="${PG_PASS}" ${PSQL} "CREATE DATABASE \"${TEMPLATE_DB}\""

TEMPLATE_URL="postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${TEMPLATE_DB}"

echo "==> Running prisma migrate deploy on ${TEMPLATE_DB}"
cd packages/database
DATABASE_URL="${TEMPLATE_URL}" npx prisma migrate deploy

echo "==> Done. Integration test template '${TEMPLATE_DB}' is ready."