import { PrismaClient } from "./prisma/client"
import type { Prisma } from "./prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import type { PoolConfig } from "pg"

export interface CreatePrismaAdapterOptions extends Omit<PoolConfig, "connectionString"> {}

export interface CreatePrismaClientOptions {
  pool?: CreatePrismaAdapterOptions
  transactionOptions?: {
    maxWait?: number
    timeout?: number
    isolationLevel?: Prisma.TransactionIsolationLevel
  }
}

// Phase 7.13.x — central adapter constructor for the prisma@7.4+ pg adapter.
// Used directly by callers that build a PrismaClient through super(...) (e.g.
// NestJS's `PrismaService extends PrismaClient` in apps/api), where
// createPrismaClient() can't substitute. Reads process.env.DATABASE_URL at
// call time (not at module-load time) so test setups that mutate env after
// import behave predictably.
//
// Throws if DATABASE_URL is missing — converts what would otherwise be a
// confusing first-query failure into a clear startup-time error.
export function createPrismaAdapter(options: CreatePrismaAdapterOptions = {}): PrismaPg {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required")
  }
  return new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    ...options,
  })
}

// Phase 7.13.x — central PrismaClient constructor. Use this for plain
// `const prisma = createPrismaClient(...)` callsites (e.g. the global
// singleton in `packages/database/src/index.ts`). For NestJS's
// `PrismaService extends PrismaClient` where the constructor must call
// super(...), use createPrismaAdapter directly inside the super() call.
export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  return new PrismaClient({
    adapter: createPrismaAdapter(options.pool),
    ...(options.transactionOptions ? { transactionOptions: options.transactionOptions } : {}),
  })
}
