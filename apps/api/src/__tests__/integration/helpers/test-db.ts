/**
 * Phase 7.10.2 — ephemeral test database lifecycle via TEMPLATE clone.
 *
 * `createTestDatabase()` clones `guestpost_test_template` (pre-migrated; see
 * docs/integration-tests.md for the one-time setup) into a fresh DB named
 * `test_<pid>_<timestamp>` and returns the connection URL + teardown closure.
 *
 * Strategy decided by recon (Gate 0.5 confirmed): TEMPLATE clone is the only
 * viable isolation for this codebase. 51 $transaction callbacks across 28
 * services rule out transaction-rollback per-test (Prisma 7 forbids nested
 * $transaction). Per-test ephemeral DB via prisma migrate deploy is too slow
 * (~3-5s per test). TEMPLATE clone is ~150ms per DB.
 *
 * Why not use the `pg` package directly: not a direct apps/api dep. Shelling
 * out via `docker exec` keeps the harness installable on any dev workstation
 * that already runs the dev compose stack.
 */
import { execFileSync } from "child_process"

const PG_HOST = "localhost"
const PG_PORT = 5432
const PG_USER = "guestpost"
const PG_PASS = "guestpost"
const TEMPLATE_DB = "guestpost_test_template"
const ADMIN_DB = "postgres"

function psqlAdmin(sql: string): void {
  execFileSync(
    "docker",
    ["exec", "gp-postgres", "psql", "-U", PG_USER, "-d", ADMIN_DB, "-c", sql],
    { encoding: "utf-8" },
  )
}

export interface TestDatabase {
  dbName: string
  url: string
  teardown: () => Promise<void>
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const dbName = `test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1000)}`
  psqlAdmin(`CREATE DATABASE "${dbName}" TEMPLATE ${TEMPLATE_DB}`)
  const url = `postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${dbName}`

  return {
    dbName,
    url,
    teardown: async () => {
      try {
        // WITH (FORCE) terminates any lingering connections so the DROP doesn't
        // hang on stale Prisma sockets — required because PrismaClient pools
        // hold connections open even after $disconnect in some edge cases.
        psqlAdmin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
      } catch (e) {
        // Swallow — teardown failures shouldn't fail the spec. The DB leaks
        // until a manual cleanup; surfaced via per-test debug log.
        // eslint-disable-next-line no-console
        console.warn(`[test-db] teardown failed for ${dbName}:`, e)
      }
    },
  }
}
