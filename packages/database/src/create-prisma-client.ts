import { PrismaPg } from "@prisma/adapter-pg"
import type { PoolConfig } from "pg"
import type { Prisma } from "./prisma/client"
import { PrismaClient } from "./prisma/client"

export interface CreatePrismaAdapterOptions
  extends Omit<PoolConfig, "connectionString"> {}

export interface CreatePrismaClientOptions {
  /**
   * Optional explicit connection string for a deliberately separate workload
   * identity (for example Better Auth). Ordinary app/worker clients continue
   * to read DATABASE_URL at call time.
   */
  databaseUrl?: string
  pool?: CreatePrismaAdapterOptions
  transactionOptions?: {
    maxWait?: number
    timeout?: number
    isolationLevel?: Prisma.TransactionIsolationLevel
  }
}

// Default and recommended bounds for connection pool max per process.
// The env var PRISMA_POOL_MAX overrides the default; callers can override
// further via CreatePrismaAdapterOptions.max.
// Precedence: options.max > PRISMA_POOL_MAX env > PRISMA_POOL_MAX_DEFAULT
export const PRISMA_POOL_MAX_DEFAULT = 10
export const PRISMA_POOL_MAX_RECOMMENDED = 25

// Parses and validates PRISMA_POOL_MAX from environment.
// Returns the default when env var is unset.
// Throws on non-integer, zero, or negative values.
export function parsePoolMax(raw: string | undefined): number {
  if (raw === undefined) return PRISMA_POOL_MAX_DEFAULT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `Invalid PRISMA_POOL_MAX: expected a positive integer, got "${raw}"`,
    )
  }
  return n
}

// Phase 7.13.x — central adapter constructor for the prisma@7.4+ pg adapter.
// Used directly by callers that build a PrismaClient through super(...) (e.g.
// NestJS's `PrismaService extends PrismaClient` in apps/api), where
// createPrismaClient() can't substitute. Reads process.env.DATABASE_URL at
// call time (not at module-load time) so test setups that mutate env after
// import behave predictably.
//
// Pool max resolution:
//   1. Use options.max if provided (caller override).
//   2. Otherwise read PRISMA_POOL_MAX env var via parsePoolMax().
//   3. Otherwise use PRISMA_POOL_MAX_DEFAULT (10).
// A warning fires when the resolved value exceeds PRISMA_POOL_MAX_RECOMMENDED.
//
// Throws if DATABASE_URL is missing — converts what would otherwise be a
// confusing first-query failure into a clear startup-time error.
export function createPrismaAdapter(
  options: CreatePrismaAdapterOptions = {},
  databaseUrl = process.env.DATABASE_URL,
): PrismaPg {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required")
  }

  const envMax =
    process.env.PRISMA_POOL_MAX !== undefined
      ? parsePoolMax(process.env.PRISMA_POOL_MAX)
      : undefined

  const resolvedMax = options.max ?? envMax ?? PRISMA_POOL_MAX_DEFAULT

  if (resolvedMax > PRISMA_POOL_MAX_RECOMMENDED) {
    console.warn(
      `[prisma] Pool max=${resolvedMax} exceeds the recommended maximum ` +
        `of ${PRISMA_POOL_MAX_RECOMMENDED}. ` +
        `Set PRISMA_POOL_MAX in your environment or see infrastructure.md ` +
        `for pool sizing guidance.`,
    )
  }

  return new PrismaPg({
    connectionString: databaseUrl,
    ...options,
    max: resolvedMax,
  })
}

// Phase 7.13.x — central PrismaClient constructor. Use this for plain
// `const prisma = createPrismaClient(...)` callsites (e.g. the global
// singleton in `packages/database/src/index.ts`). For NestJS's
// `PrismaService extends PrismaClient` where the constructor must call
// super(...), use createPrismaAdapter directly inside the super() call.
export function createPrismaClient(
  options: CreatePrismaClientOptions = {},
): PrismaClient {
  return new PrismaClient({
    adapter: createPrismaAdapter(options.pool, options.databaseUrl),
    ...(options.transactionOptions
      ? { transactionOptions: options.transactionOptions }
      : {}),
  })
}
