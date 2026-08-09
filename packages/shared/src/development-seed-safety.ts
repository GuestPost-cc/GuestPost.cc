const LOOPBACK_SEED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
export const DEVELOPMENT_SEED_DATABASE_SENTINEL =
  "guestpost-local-development-v1"

export type DevelopmentSeedDatabaseIdentity = {
  databaseName: string
  databaseOid: string
  systemIdentifier: string
}

export function isDevelopmentSeedApiRequestAllowed(
  nodeEnv: string | undefined,
  remoteAddress: string | undefined,
): boolean {
  return (
    (nodeEnv === "development" || nodeEnv === "test") &&
    (remoteAddress === "127.0.0.1" ||
      remoteAddress === "::1" ||
      remoteAddress === "::ffff:127.0.0.1")
  )
}

/**
 * Prevents the known-password development fixture from reaching a remote or
 * production database. This must run before the seed performs API or DB work.
 */
export function assertDevelopmentSeedSafety(
  nodeEnv: string | undefined,
  databaseUrl: string | undefined,
  apiUrl: string,
): void {
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error(
      "Seed is restricted to an explicit development or test environment",
    )
  }
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the development seed")
  }

  let parsed: URL
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL")
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol")
  }
  if (
    !LOOPBACK_SEED_HOSTS.has(parsed.hostname.toLowerCase()) ||
    parsed.port !== "5432" ||
    parsed.pathname === "" ||
    parsed.pathname === "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "Development seed refuses non-local databases; DATABASE_URL must be a direct loopback PostgreSQL database on port 5432 without query parameters",
    )
  }

  let parsedApi: URL
  try {
    parsedApi = new URL(apiUrl)
  } catch {
    throw new Error("SEED_API_URL must be a valid local API URL")
  }
  if (
    parsedApi.protocol !== "http:" ||
    !LOOPBACK_SEED_HOSTS.has(parsedApi.hostname.toLowerCase()) ||
    parsedApi.port !== "4000" ||
    parsedApi.username !== "" ||
    parsedApi.password !== "" ||
    (parsedApi.pathname !== "" && parsedApi.pathname !== "/") ||
    parsedApi.search !== "" ||
    parsedApi.hash !== ""
  ) {
    throw new Error(
      "Development seed refuses non-local APIs; SEED_API_URL must be plain HTTP on local port 4000",
    )
  }
}

/**
 * Proves this is the local Compose database before the privileged fixture can
 * create known-password identities or synthetic money. The sentinel is
 * installed only by the fixed local services bootstrap.
 */
export async function assertDevelopmentSeedDatabaseSentinel(
  prisma: any,
): Promise<DevelopmentSeedDatabaseIdentity> {
  const rows = (await prisma.$queryRaw`
    SELECT
      current_database() AS "databaseName",
      database.oid::text AS "databaseOid",
      (pg_control_system()).system_identifier::text AS "systemIdentifier",
      shobj_description(database.oid, 'pg_database') AS "sentinel"
    FROM pg_database database
    WHERE database.datname = current_database()
  `) as Array<DevelopmentSeedDatabaseIdentity & { sentinel: string | null }>

  if (
    rows.length !== 1 ||
    rows[0].sentinel !== DEVELOPMENT_SEED_DATABASE_SENTINEL ||
    !rows[0].databaseName ||
    !/^\d+$/.test(rows[0].databaseOid) ||
    !/^\d+$/.test(rows[0].systemIdentifier)
  ) {
    throw new Error(
      "Development seed database sentinel is missing; run pnpm services:up against the local Compose database",
    )
  }

  return {
    databaseName: rows[0].databaseName,
    databaseOid: rows[0].databaseOid,
    systemIdentifier: rows[0].systemIdentifier,
  }
}
