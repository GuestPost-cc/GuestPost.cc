/**
 * Phase 7.10.2 — Nest+supertest integration test app harness.
 *
 * Wires up:
 *   1. Fresh ephemeral DB (TEMPLATE clone of guestpost_test_template)
 *   2. process.env.DATABASE_URL pointed at the ephemeral DB BEFORE AppModule
 *      is imported (Gate 0.75 confirmed env mutation reaches PrismaService
 *      at construction time)
 *   3. Test.createTestingModule({ imports: [AppModule] }).compile() (Gate 0.25
 *      confirmed AppModule boots cleanly under TestingModule in ~2s)
 *   4. cleanup() closure that closes the app + disconnects Prisma + drops the
 *      ephemeral DB
 *
 * NO AuthGuard override in this commit — Spec 1 (claim race) calls services
 * directly via app.get(Service), bypassing the HTTP layer entirely. Spec 2
 * (queue GET) + TestAuthGuard + supertest api-client land in Phase 7.10.2.1
 * as a fast-follow PR.
 */

import { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createTestDatabase, type TestDatabase } from "./test-db"

export interface TestAppContext {
  app: INestApplication
  prisma: any // PrismaService — typed as any to avoid eager-import side effects
  dbName: string
  cleanup: () => Promise<void>
}

export async function createTestApp(): Promise<TestAppContext> {
  // 1. Clone ephemeral DB BEFORE the AppModule import (DATABASE_URL must be set
  //    at PrismaService construction time — Gate 0.75 verified call-time read).
  const db: TestDatabase = await createTestDatabase()
  const previousDatabaseUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = db.url
  const previousJwtSecret = process.env.JWT_SECRET
  if (!process.env.JWT_SECRET && !process.env.QUEUE_SIGNING_SECRET) {
    process.env.JWT_SECRET = "test-jwt-secret-integration"
  }

  // 2. Defer the AppModule + PrismaService imports until env is set. Module
  //    caching means subsequent imports reuse the same instances — that's why
  //    the env mutation MUST happen before the very first import in this
  //    worker process. (Workers are separate processes in jest, so each spec
  //    file effectively gets a fresh module graph.)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { AppModule } = require("../../../app.module")
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaService } = require("../../../common/prisma.service")

  // 3. Boot the testing module + get a real PrismaService bound to the
  //    ephemeral DB. .compile() runs all module providers' OnModuleInit hooks
  //    (e.g. PrismaService.$connect()).
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile()
  const app = moduleRef.createNestApplication()
  await app.init() // triggers OnModuleInit / lifecycle hooks
  const prisma = app.get(PrismaService)

  const cleanup = async () => {
    try {
      await app.close()
    } catch (_) {
      /* ignore */
    }
    try {
      await prisma.$disconnect()
    } catch (_) {
      /* ignore */
    }
    await db.teardown()
    if (previousDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = previousDatabaseUrl
    } else {
      delete process.env.DATABASE_URL
    }
    if (previousJwtSecret !== undefined) {
      process.env.JWT_SECRET = previousJwtSecret
    } else {
      delete process.env.JWT_SECRET
    }
  }

  return { app, prisma, dbName: db.dbName, cleanup }
}
