const LOOPBACK_SEED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
export const DEVELOPMENT_SEED_DATABASE_SENTINEL =
  "guestpost-local-development-v1"
export const STAGING_SEED_CONFIRMATION =
  "guestpost-staging:br-empty-resonance-b5fnktnx"
export const STAGING_NEON_DATABASE_HOST =
  "ep-damp-boat-b5j0h24a.c-7.us-east-2.aws.neon.tech"

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
 * The staging fixture is deliberately opt-in and tied to the approved Neon
 * database and API. The direct owner URL is for this one-off seed process only.
 */
export function assertStagingSeedSafety(
  nodeEnv: string | undefined,
  databaseUrl: string | undefined,
  apiUrl: string,
  confirmation: string | undefined,
): void {
  if (nodeEnv !== "production") {
    throw new Error("Staging seed requires NODE_ENV=production")
  }
  if (confirmation !== STAGING_SEED_CONFIRMATION) {
    throw new Error("Staging seed target confirmation does not match")
  }
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the staging seed")
  }

  let parsed: URL
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL")
  }
  const sslMode = parsed.searchParams.get("sslmode")
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.hostname !== STAGING_NEON_DATABASE_HOST ||
    (parsed.port !== "" && parsed.port !== "5432") ||
    parsed.pathname !== "/neondb" ||
    decodeURIComponent(parsed.username) !== "neondb_owner" ||
    parsed.password === "" ||
    sslMode !== "require" ||
    parsed.searchParams.has("host") ||
    parsed.searchParams.has("hostaddr") ||
    parsed.searchParams.has("options") ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "Staging seed requires the direct TLS neondb_owner URL for the approved Neon database",
    )
  }

  let parsedApi: URL
  try {
    parsedApi = new URL(apiUrl)
  } catch {
    throw new Error("SEED_API_URL must be the approved staging API origin")
  }
  if (
    parsedApi.protocol !== "https:" ||
    parsedApi.hostname !== "api.shohan.iam.bd" ||
    parsedApi.username !== "" ||
    parsedApi.password !== "" ||
    parsedApi.pathname !== "/" ||
    parsedApi.search !== "" ||
    parsedApi.hash !== ""
  ) {
    throw new Error("Staging seed refuses a non-staging API target")
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
