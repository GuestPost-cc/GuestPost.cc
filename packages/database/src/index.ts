import { createPrismaClient } from "./create-prisma-client"
import { PrismaClient } from "./prisma/client"

export type {
  CreatePrismaAdapterOptions,
  CreatePrismaClientOptions,
} from "./create-prisma-client"
export {
  createPrismaAdapter,
  createPrismaClient,
  PRISMA_POOL_MAX_DEFAULT,
  PRISMA_POOL_MAX_RECOMMENDED,
  parsePoolMax,
} from "./create-prisma-client"
export * from "./prisma/client"
export { PrismaClient }

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
