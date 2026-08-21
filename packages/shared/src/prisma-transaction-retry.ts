/**
 * Extract only trusted, structured Prisma/PostgreSQL error codes.
 *
 * Prisma 7 driver adapters can expose a PostgreSQL SQLSTATE either directly
 * on a `DriverAdapterError.cause.originalCode` (raw-query/transaction paths)
 * or under `meta.driverAdapterError.cause.originalCode` while exposing P2010
 * at the top level. Never inspect free-form messages: doing so can
 * accidentally retry validation, authorization, or constraint failures.
 */
export function trustedPrismaErrorCodes(error: unknown): ReadonlySet<string> {
  const codes = new Set<string>()
  if (!isRecord(error)) return codes

  if (typeof error.code === "string") codes.add(error.code)

  // This is the same structural discriminator used by Prisma's
  // `isDriverAdapterError`. Avoid broad recursive `cause` traversal: only the
  // adapter's named wrapper is trusted to carry a database SQLSTATE here.
  if (error.name === "DriverAdapterError" && isRecord(error.cause)) {
    const originalCode = error.cause.originalCode
    if (typeof originalCode === "string") codes.add(originalCode)
  }

  if (!isRecord(error.meta)) return codes

  if (typeof error.meta.code === "string") codes.add(error.meta.code)
  const driverAdapterError = error.meta.driverAdapterError
  if (isRecord(driverAdapterError) && isRecord(driverAdapterError.cause)) {
    const originalCode = driverAdapterError.cause.originalCode
    if (typeof originalCode === "string") codes.add(originalCode)
  }
  return codes
}

export function isRetryablePrismaTransactionError(error: unknown): boolean {
  const codes = trustedPrismaErrorCodes(error)
  return codes.has("P2034") || codes.has("40001") || codes.has("40P01")
}

export function isPrismaUniqueConstraintError(error: unknown): boolean {
  const codes = trustedPrismaErrorCodes(error)
  return codes.has("P2002") || codes.has("23505")
}

export function prismaTransactionRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
  baseMs = 20,
  capMs = 500,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  const ceilingMs = Math.min(capMs, baseMs * 2 ** (safeAttempt - 1))
  const floorMs = Math.ceil(ceilingMs / 2)
  const sample = Math.min(Math.max(random(), 0), 0.999999999999)
  return floorMs + Math.floor(sample * (ceilingMs - floorMs + 1))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
