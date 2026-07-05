/**
 * Phase 7.10.2 — ephemeral test database lifecycle via TEMPLATE clone.
 *
 * `createTestDatabase()` clones `guestpost_test_template` (auto-created if
 * missing) into a fresh DB named `test_<pid>_<timestamp>` and returns the
 * connection URL + teardown closure.
 *
 * Auto-creation: if the template doesn't exist, the harness creates it from
 * `postgres`, then runs `prisma migrate deploy` to set up the schema. This
 * works in any environment (CI, fresh workstation, etc.) without a manual
 * one-time setup step. Once created, subsequent clones use the fast TEMPLATE
 * path (~150ms per DB).
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
import { execFileSync } from "node:child_process"
import path from "node:path"

const PG_HOST = "localhost"
const PG_PORT = 5432
const PG_USER = "guestpost"
const PG_PASS = "guestpost"
const TEMPLATE_DB = "guestpost_test_template"
const ADMIN_DB = "postgres"

function detectPsqlCmd(): string[] {
  // GitHub Actions — no docker socket in service containers, use psql via TCP
  if (process.env.GITHUB_ACTIONS === "true") {
    return ["psql", "-h", "localhost", "-U", PG_USER, "-d", ADMIN_DB, "-c"]
  }
  // Local dev — prefer docker exec (no pg client dep needed)
  try {
    execFileSync("docker", ["inspect", "gp-postgres"], {
      encoding: "utf-8",
      stdio: "ignore",
    })
    return [
      "docker",
      "exec",
      "gp-postgres",
      "psql",
      "-U",
      PG_USER,
      "-d",
      ADMIN_DB,
      "-c",
    ]
  } catch {
    // No docker container — fallback to direct psql via TCP
    return ["psql", "-h", "localhost", "-U", PG_USER, "-d", ADMIN_DB, "-c"]
  }
}

const psqlCmd = detectPsqlCmd()

function psqlAdmin(sql: string): string {
  return execFileSync(psqlCmd[0], [...psqlCmd.slice(1), sql], {
    encoding: "utf-8",
    env: { ...process.env, PGPASSWORD: PG_PASS },
  })
}

function templateExists(): boolean {
  const result = psqlAdmin(
    `SELECT 1 FROM pg_database WHERE datname = '${TEMPLATE_DB}'`,
  )
  return result.includes("1 row")
}

function ensureTemplate(): void {
  if (templateExists()) return

  // Detect the database package root relative to this file
  const dbPackageRoot = path.resolve(
    __dirname, // src/__tests__/integration/helpers/
    "..", // src/__tests__/integration/
    "..", // src/__tests__/
    "..", // src/
    "..", // apps/api/
    "..", // project root
    "packages",
    "database",
  )
  const templateUrl = `postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${TEMPLATE_DB}`

  // eslint-disable-next-line no-console
  console.log(`[test-db] Template "${TEMPLATE_DB}" not found — creating now`)

  // Create the template database
  psqlAdmin(`CREATE DATABASE "${TEMPLATE_DB}"`)

  // Run prisma migrate deploy to set up the schema on the template
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        DATABASE_URL: templateUrl,
        PGPASSWORD: PG_PASS,
      },
      cwd: dbPackageRoot,
      stdio: "pipe",
    })
  } catch (e: any) {
    // If migrate deploy fails (e.g., no existing migrations), fall back to
    // prisma db push
    execFileSync("npx", ["prisma", "db", "push", "--accept-data-loss"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        DATABASE_URL: templateUrl,
        PGPASSWORD: PG_PASS,
      },
      cwd: dbPackageRoot,
      stdio: "pipe",
    })
  }

  // Template must allow connections for TEMPLATE cloning
  psqlAdmin(
    `UPDATE pg_database SET datallowconn = true WHERE datname = '${TEMPLATE_DB}'`,
  )
}

export interface TestDatabase {
  dbName: string
  url: string
  teardown: () => Promise<void>
}

export async function createTestDatabase(): Promise<TestDatabase> {
  ensureTemplate()
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
