#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NEON_MIGRATION_REF="${NEON_MIGRATION_REF:-}"
PSQL_BIN="${PSQL_BIN:-$(command -v psql || true)}"
PRISMA_BIN="${PRISMA_BIN:-$ROOT/packages/database/node_modules/.bin/prisma}"
if [[ -z "$PSQL_BIN" ]]; then
  for candidate in /opt/homebrew/opt/libpq/bin/psql /usr/local/opt/libpq/bin/psql; do
    [[ ! -x "$candidate" ]] || { PSQL_BIN="$candidate"; break; }
  done
fi
TMP_BASE="${TMPDIR:-/tmp}"
PASSFILE="$(mktemp "$TMP_BASE/guestpost-neon-pgpass.XXXXXX")"
TEMP_SQL=""
RLS_SNAPSHOT_FILE=""
NEON_ADMIN_URL=""
MIGRATOR_PASSWORD=""
MIGRATOR_URL=""
trap '[[ -z "$TEMP_SQL" ]] || rm -f "$TEMP_SQL"; [[ -z "$RLS_SNAPSHOT_FILE" ]] || rm -f "$RLS_SNAPSHOT_FILE"; rm -f "$PASSFILE"; unset NEON_ADMIN_URL MIGRATOR_PASSWORD MIGRATOR_URL' EXIT

if [[ -z "$PSQL_BIN" || ! -x "$PSQL_BIN" ]]; then
  printf 'psql is unavailable; install PostgreSQL client tools or set PSQL_BIN.\n' >&2
  exit 1
fi
PSQL_VERSION_OUTPUT=$("$PSQL_BIN" --version)
PSQL_MAJOR=$(sed -E 's/.*\) ([0-9]+)(\..*)?$/\1/' <<< "$PSQL_VERSION_OUTPUT")
if ! [[ "$PSQL_MAJOR" =~ ^[0-9]+$ ]]; then
  printf 'Could not determine the psql client version from: %s\n' "$PSQL_VERSION_OUTPUT" >&2
  exit 1
fi
if [[ "${PGSSLROOTCERT:-system}" == 'system' ]] && (( PSQL_MAJOR < 16 )); then
  printf 'PGSSLROOTCERT=system requires PostgreSQL client 16 or newer; upgrade psql or set PGSSLROOTCERT to a trusted CA bundle path.\n' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  printf 'node is unavailable; add Node.js to PATH before running this script.\n' >&2
  exit 1
fi
if [[ ! -x "$PRISMA_BIN" ]]; then
  printf 'Prisma CLI is unavailable at %s; install workspace dependencies or set PRISMA_BIN.\n' "$PRISMA_BIN" >&2
  exit 1
fi

if [[ -z "$NEON_MIGRATION_REF" ]]; then
  printf 'Set NEON_MIGRATION_REF to the exact commit configured for the target deployment.\n' >&2
  exit 1
fi
MIGRATION_COMMIT=$(git -C "$ROOT" rev-parse --verify "$NEON_MIGRATION_REF^{commit}" 2>/dev/null) || {
  printf 'NEON_MIGRATION_REF is not available locally; fetch the target commit first.\n' >&2
  exit 1
}
if ! git -C "$ROOT" merge-base --is-ancestor "$MIGRATION_COMMIT" origin/main; then
  printf 'NEON_MIGRATION_REF is not reachable from origin/main; no SQL was run.\n' >&2
  exit 1
fi
if ! git -C "$ROOT" diff --quiet "$MIGRATION_COMMIT" -- package.json packages/database/package.json packages/database/prisma.config.ts packages/database/prisma/schema.prisma packages/database/prisma/migrations scripts/provision-financial-repair-guard-role.sql scripts/provision-neon-migration-login.sql scripts/cleanup-neon-migration-login.sql scripts/provision-rls-roles.sql; then
  printf 'The local Prisma or role-provisioning files differ from NEON_MIGRATION_REF; run from a matching checkout. No SQL was run.\n' >&2
  exit 1
fi
UNTRACKED_DATABASE_FILES=$(git -C "$ROOT" ls-files --others --exclude-standard -- packages/database/prisma/migrations packages/database/prisma/schema.prisma packages/database/prisma.config.ts scripts/provision-financial-repair-guard-role.sql scripts/provision-neon-migration-login.sql scripts/cleanup-neon-migration-login.sql scripts/provision-rls-roles.sql)
if [[ -n "$UNTRACKED_DATABASE_FILES" ]]; then
  printf 'Untracked Prisma or role-provisioning files exist; review them before proceeding. No SQL was run.\n' >&2
  exit 1
fi
printf 'Verified Prisma migration source commit %s.\n' "$MIGRATION_COMMIT"

chmod 600 "$PASSFILE"
read -r -s -p 'Paste the direct Neon neondb_owner URL for database neondb (input hidden): ' NEON_ADMIN_URL
printf '\n'

CONNECTION_INFO=$(NEON_ADMIN_URL="$NEON_ADMIN_URL" PASSFILE="$PASSFILE" node -e '
const fs = require("node:fs");
const expectedHost = "ep-damp-boat-b5j0h24a.c-7.us-east-2.aws.neon.tech";
try {
  const u = new URL(process.env.NEON_ADMIN_URL);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const username = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  if (!["postgres:", "postgresql:"].includes(u.protocol) || u.hostname !== expectedHost || u.hostname.includes("-pooler") || database !== "neondb" || username !== "neondb_owner" || !password || /[\r\n\t]/.test(password)) process.exit(2);
  const escape = value => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
  fs.writeFileSync(process.env.PASSFILE, `${escape(u.hostname)}:${u.port || "5432"}:${escape(database)}:${escape(username)}:${escape(password)}\n`, { mode: 0o600 });
  process.stdout.write(`${u.hostname}\t${u.port || "5432"}`);
} catch {
  process.exit(2);
}') || {
  printf 'Use the direct neondb_owner URL for the pinned guestpost-staging branch and database neondb. Other branches and pooled endpoints are rejected; no SQL was run.\n' >&2
  exit 1
}
IFS=$'\t' read -r PGHOST PGPORT <<< "$CONNECTION_INFO"

psql_admin() {
  env PGPASSFILE="$PASSFILE" PGHOST="$PGHOST" PGPORT="$PGPORT" PGUSER=neondb_owner PGDATABASE=neondb PGSSLMODE=verify-full PGSSLROOTCERT="${PGSSLROOTCERT:-system}" PGCONNECT_TIMEOUT=10 "$PSQL_BIN" -X "$@"
}

psql_migrator() {
  env PGPASSFILE="$PASSFILE" PGHOST="$PGHOST" PGPORT="$PGPORT" PGUSER=guestpost_migrator_login PGDATABASE=neondb PGSSLMODE=verify-full PGSSLROOTCERT="${PGSSLROOTCERT:-system}" PGCONNECT_TIMEOUT=10 PGOPTIONS='-c role=guestpost_schema_owner' "$PSQL_BIN" -X "$@"
}

ADMIN_IDENTITY=$(psql_admin -Atc "SELECT current_user || '|' || current_database()")
if [[ "$ADMIN_IDENTITY" != 'neondb_owner|neondb' ]]; then
  printf 'Connected identity/database was not neondb_owner|neondb. No provisioning was run.\n' >&2
  exit 1
fi
printf 'Verified direct Neon target and owner identity.\n'

psql_admin -v ON_ERROR_STOP=1 -f "$ROOT/scripts/provision-financial-repair-guard-role.sql"

EXISTING_MIGRATOR_STATE=$(psql_admin -Atc "SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_migrator_login') THEN 'absent' WHEN EXISTS (SELECT 1 FROM pg_roles migrator JOIN pg_roles owner ON owner.rolname = 'guestpost_schema_owner' JOIN pg_auth_members membership ON membership.roleid = owner.oid AND membership.member = migrator.oid WHERE migrator.rolname = 'guestpost_migrator_login' AND migrator.rolcanlogin AND NOT migrator.rolsuper AND NOT migrator.rolcreatedb AND NOT migrator.rolcreaterole AND NOT migrator.rolreplication AND NOT migrator.rolbypassrls AND NOT migrator.rolinherit) THEN 'managed' ELSE 'unexpected' END")
case "$EXISTING_MIGRATOR_STATE" in
  absent) ;;
  managed)
    printf 'Removing the restricted one-use migration login left by a prior attempt.\n'
    psql_admin -v ON_ERROR_STOP=1 -v database_name=neondb -f "$ROOT/scripts/cleanup-neon-migration-login.sql"
    ;;
  *)
    printf 'An unexpected guestpost_migrator_login role exists; stopping for review. No migration was run.\n' >&2
    exit 1
    ;;
esac

MIGRATOR_PASSWORD=$(openssl rand -hex 32)
printf '%s:%s:neondb:guestpost_migrator_login:%s\n' "$PGHOST" "$PGPORT" "$MIGRATOR_PASSWORD" >> "$PASSFILE"
TEMP_SQL=$(mktemp "$TMP_BASE/guestpost-neon-migrator.XXXXXX.sql")
chmod 600 "$TEMP_SQL"
cat > "$TEMP_SQL" <<SQL
\\set database_name 'neondb'
\\set migrator_password '$MIGRATOR_PASSWORD'
\\i '$ROOT/scripts/provision-neon-migration-login.sql'
SQL
psql_admin -v ON_ERROR_STOP=1 -f "$TEMP_SQL"
rm -f "$TEMP_SQL"
TEMP_SQL=""

MIGRATOR_URL=$(NEON_ADMIN_URL="$NEON_ADMIN_URL" MIGRATOR_PASSWORD="$MIGRATOR_PASSWORD" node -e 'const u=new URL(process.env.NEON_ADMIN_URL); u.username="guestpost_migrator_login"; u.password=process.env.MIGRATOR_PASSWORD; u.searchParams.set("sslmode","verify-full"); u.searchParams.set("options","-c role=guestpost_schema_owner"); process.stdout.write(u.toString());')
MIGRATOR_IDENTITY=$(psql_migrator -Atc "SELECT session_user || '|' || current_user || '|' || current_database()")
if [[ "$MIGRATOR_IDENTITY" != 'guestpost_migrator_login|guestpost_schema_owner|neondb' ]]; then
  printf 'Migration identity did not match the reviewed schema owner; migrations were not run.\n' >&2
  exit 1
fi
printf 'Verified one-use migration identity: %s.\n' "$MIGRATOR_IDENTITY"

RLS_SNAPSHOT_FILE=$(mktemp "$TMP_BASE/guestpost-neon-rls-before.XXXXXX")
psql_admin -AtF '|' -c "SELECT relation.oid, relation.relrowsecurity::text, relation.relforcerowsecurity::text FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p') AND (relation.relrowsecurity OR relation.relforcerowsecurity) ORDER BY relation.oid" > "$RLS_SNAPSHOT_FILE"

# Run the workspace-installed Prisma CLI from its package directory. This
# avoids depending on pnpm being present in a non-interactive shell's PATH.
# Prisma status exits nonzero when unapplied migrations exist, so deploy first.
(
  cd "$ROOT/packages/database"
  DIRECT_DATABASE_URL="$MIGRATOR_URL" "$PRISMA_BIN" migrate deploy
  DIRECT_DATABASE_URL="$MIGRATOR_URL" "$PRISMA_BIN" migrate status
)

while IFS='|' read -r relation_oid rls_before force_before; do
  [[ -z "$relation_oid" ]] && continue
  rls_after=$(psql_admin -Atc "SELECT relrowsecurity::text || '|' || relforcerowsecurity::text FROM pg_class WHERE oid = $relation_oid")
  if [[ "$rls_after" != "$rls_before|$force_before" ]]; then
    printf 'RLS state changed for pre-existing relation OID %s (%s|%s -> %s); stopping before role cleanup.\n' "$relation_oid" "$rls_before" "$force_before" "$rls_after" >&2
    exit 1
  fi
done < "$RLS_SNAPSHOT_FILE"

RLS_TABLE_COUNT=$(psql_admin -Atc "SELECT count(*) FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p') AND relation.relname IN ('ApiKey', 'Order', 'ReconciliationCase', 'ReconciliationScan', 'ReconciliationCaseSnapshot', 'ReconciliationRepairProposal', 'ReconciliationRepairApproval', 'ReconciliationRepairExecution')")
API_KEY_RLS_STATE=$(psql_admin -Atc "SELECT relrowsecurity::text || '|' || relforcerowsecurity::text FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relname = 'ApiKey' AND relation.relkind IN ('r', 'p')")
ORDER_RLS_STATE=$(psql_admin -Atc "SELECT relrowsecurity::text || '|' || relforcerowsecurity::text FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relname = 'Order' AND relation.relkind IN ('r', 'p')")
if [[ "$RLS_TABLE_COUNT" != '8' || "$API_KEY_RLS_STATE" != 'true|true' ]]; then
  printf 'Expected the eight staged RLS tables and forced ApiKey RLS; table count=%s, ApiKey=%s.\n' "$RLS_TABLE_COUNT" "$API_KEY_RLS_STATE" >&2
  exit 1
fi
case "$ORDER_RLS_STATE" in
  true\|true)
    RLS_GUARD_COUNT=$(psql_admin -Atc "SELECT count(*) FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p') AND relation.relname IN ('ApiKey', 'ReconciliationCase', 'ReconciliationScan', 'ReconciliationCaseSnapshot', 'ReconciliationRepairProposal', 'ReconciliationRepairApproval', 'ReconciliationRepairExecution') AND relation.relrowsecurity AND relation.relforcerowsecurity")
    if [[ "$RLS_GUARD_COUNT" != '7' ]]; then
      printf 'Order has forced RLS, so all 7 dependent tables must also have it; found %s.\n' "$RLS_GUARD_COUNT" >&2
      exit 1
    fi
    printf 'Verified forced RLS on ApiKey and all 6 reconciliation tables gated by Order.\n'
    ;;
  false\|false)
    RECONCILIATION_RLS_COUNT=$(psql_admin -Atc "SELECT count(*) FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p') AND relation.relname IN ('ReconciliationCase', 'ReconciliationScan', 'ReconciliationCaseSnapshot', 'ReconciliationRepairProposal', 'ReconciliationRepairApproval', 'ReconciliationRepairExecution') AND (relation.relrowsecurity OR relation.relforcerowsecurity)")
    if [[ "$RECONCILIATION_RLS_COUNT" != '0' ]]; then
      printf 'Order RLS is not activated, but %s reconciliation tables have partial RLS state.\n' "$RECONCILIATION_RLS_COUNT" >&2
      exit 1
    fi
    printf 'Verified forced ApiKey RLS; the six reconciliation tables remain inert behind the Order RLS canary gate.\n'
    ;;
  *)
    printf 'Order RLS state is partial or missing (%s); stopping for review.\n' "$ORDER_RLS_STATE" >&2
    exit 1
    ;;
esac
printf 'Existing RLS flags are preserved. Full application RLS activation remains a separate canary-gated operation.\n'

BAD_TABLE_OWNERS=$(psql_migrator -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND c.relname <> '_prisma_migrations' AND pg_get_userbyid(c.relowner) <> 'guestpost_schema_owner'")
BAD_SEQUENCE_OWNERS=$(psql_migrator -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' AND pg_get_userbyid(c.relowner) <> 'guestpost_schema_owner'")
if [[ "$BAD_TABLE_OWNERS" != '0' || "$BAD_SEQUENCE_OWNERS" != '0' ]]; then
  printf 'Ownership verification failed: non-owner tables=%s, sequences=%s. Migration login retained for inspection.\n' "$BAD_TABLE_OWNERS" "$BAD_SEQUENCE_OWNERS" >&2
  exit 1
fi
printf 'Verified all application tables and sequences are owned by guestpost_schema_owner.\n'

psql_admin -v ON_ERROR_STOP=1 -v database_name=neondb -f "$ROOT/scripts/cleanup-neon-migration-login.sql"
psql_admin -v ON_ERROR_STOP=1 -v database_name=neondb -f "$ROOT/scripts/provision-rls-roles.sql"

ROLE_AUDIT=$(psql_admin -Atc "SELECT count(*) FROM pg_roles WHERE rolname IN ('guestpost_schema_owner','guestpost_migrator','guestpost_api_group','guestpost_auth_group','guestpost_worker_group','guestpost_reporting_group','guestpost_api_runtime','guestpost_auth_runtime','guestpost_worker_runtime','guestpost_reporting_runtime','guestpost_rls_authorizer','guestpost_financial_repair_guard','guestpost_financial_repair_staging') AND NOT rolcanlogin")
if [[ "$ROLE_AUDIT" != '13' ]]; then
  printf 'Expected 13 disabled managed roles; found %s.\n' "$ROLE_AUDIT" >&2
  exit 1
fi
printf 'Neon migrations and 13-role disabled ACL topology completed. Runtime logins and RLS activation remain separate gates.\n'
