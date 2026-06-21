import { PrismaClient } from "./prisma/client"
import { createPrismaClient } from "./create-prisma-client"

export { PrismaClient }
export * from "./prisma/client"
export { createPrismaClient, createPrismaAdapter } from "./create-prisma-client"
export type { CreatePrismaClientOptions, CreatePrismaAdapterOptions } from "./create-prisma-client"

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
