// Phase 7.7 A1 — Promote AuditLog.requestId from metadata JSON to indexed
// top-level column.
//
// Two-layer coverage per the plan:
//   1. Migration SQL regression guards (grep-style) — catches future edits
//      that break idempotency, remove IF NOT EXISTS, drop the partial-
//      index WHERE predicate, or change column ordering
//   2. AuditService.log unit test — confirms the dual-write contract:
//      requestId lands in BOTH the indexed column AND the metadata JSON,
//      and the metadata mirror is preserved indefinitely (not transitional)
//
// Real-DB confirmation lives in operator verification (apply migration on
// staging/prod, EXPLAIN ANALYZE to prove planner picks AuditLog_requestId_idx,
// paste counts + plan into the §11 Remediation Log entry).

import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const MIGRATION_PATH = path.join(
  repoRoot,
  "packages/database/prisma/migrations/20260616130000_phase77_audit_request_id_column/migration.sql",
)
const SCHEMA_PATH = path.join(repoRoot, "packages/database/prisma/schema.prisma")

describe("Phase 7.7 A1 — migration regression guards", () => {
  it("migration file exists at the expected path", () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true)
  })

  describe("migration SQL", () => {
    let sql: string
    beforeAll(() => {
      sql = fs.readFileSync(MIGRATION_PATH, "utf8")
    })

    it("adds requestId column as VARCHAR(128) with IF NOT EXISTS (idempotent re-apply)", () => {
      expect(sql).toMatch(
        /ALTER TABLE\s+"AuditLog"\s+ADD COLUMN IF NOT EXISTS\s+"requestId"\s+VARCHAR\(128\)/i,
      )
    })

    it("backfills from metadata->>'requestId' guarded by IS NULL (idempotent)", () => {
      expect(sql).toMatch(/UPDATE\s+"AuditLog"/i)
      expect(sql).toMatch(/SET\s+"requestId"\s*=\s*metadata->>'requestId'/i)
      expect(sql).toMatch(/WHERE\s+"requestId"\s+IS NULL/i)
      expect(sql).toMatch(/AND\s+metadata->>'requestId'\s+IS NOT NULL/i)
    })

    it("creates partial btree index with IF NOT EXISTS + WHERE requestId IS NOT NULL", () => {
      expect(sql).toMatch(
        /CREATE INDEX IF NOT EXISTS\s+"AuditLog_requestId_idx"\s+ON\s+"AuditLog"\s+\("requestId"\)/i,
      )
      expect(sql).toMatch(/WHERE\s+"requestId"\s+IS NOT NULL/i)
    })

    it("does NOT use CREATE INDEX CONCURRENTLY (Prisma 6 wraps migrations in a tx; would fail)", () => {
      // Documented limitation — Prisma 7.4+ fixes this. Until upgrade, the
      // plain CREATE INDEX takes a brief ACCESS EXCLUSIVE lock; acceptable
      // because AuditLog isn't on the order-fulfillment hot path.
      expect(sql).not.toMatch(/CREATE INDEX CONCURRENTLY/i)
    })

    it("comment header references Phase 7.7 + audit context (forensic clarity)", () => {
      expect(sql).toMatch(/Phase 7\.7/)
      expect(sql).toMatch(/requestId/)
    })
  })
})

describe("Phase 7.7 A1 — schema.prisma reflects DB state", () => {
  let schema: string
  beforeAll(() => {
    schema = fs.readFileSync(SCHEMA_PATH, "utf8")
  })

  it("AuditLog model declares requestId String? @db.VarChar(128)", () => {
    const auditLogBlock = schema.match(/model AuditLog \{[\s\S]+?\n\}/)
    expect(auditLogBlock).not.toBeNull()
    expect(auditLogBlock![0]).toMatch(/requestId\s+String\?\s+@db\.VarChar\(128\)/)
  })

  it("AuditLog model declares @@index([requestId], map: \"AuditLog_requestId_idx\")", () => {
    const auditLogBlock = schema.match(/model AuditLog \{[\s\S]+?\n\}/)
    expect(auditLogBlock).not.toBeNull()
    expect(auditLogBlock![0]).toMatch(
      /@@index\(\[requestId\],\s*map:\s*"AuditLog_requestId_idx"\)/,
    )
  })
})

describe("Phase 7.7 A1 — AuditService.log dual-write contract", () => {
  // Test the dual-write behavior: requestId must land in the indexed column
  // AND continue to spread into metadata JSON. The metadata mirror is kept
  // indefinitely (storage trivial; downstream readers — Sentry exports,
  // ad-hoc scripts — may still parse the JSON).

  // Import AuditService lazily after we mock request-context.
  // The actual logic: read getRequestId() → write to both `data.requestId`
  // (column) and `data.metadata.requestId` (JSON mirror).

  const FAKE_REQUEST_ID = "abc12345-test-test-test-test-1234567890ab"

  it("writes requestId to the indexed column when a requestId is present in ALS", async () => {
    jest.resetModules()
    jest.doMock("@guestpost/shared/dist/observability/request-context", () => ({
      getRequestId: () => FAKE_REQUEST_ID,
    }))

    const { AuditService } = await import("../modules/audit/audit.service")
    const captured: any[] = []
    const fakePrisma: any = {
      auditLog: { create: async (args: any) => captured.push(args) },
    }
    const service = new AuditService(fakePrisma)

    await service.log({ action: "TEST_ACTION", entityType: "Test", entityId: "abc" })

    expect(captured).toHaveLength(1)
    expect(captured[0].data.requestId).toBe(FAKE_REQUEST_ID)
    expect(captured[0].data.metadata?.requestId).toBe(FAKE_REQUEST_ID)
  })

  it("falls back to null requestId column when ALS has no frame", async () => {
    jest.resetModules()
    jest.doMock("@guestpost/shared/dist/observability/request-context", () => ({
      getRequestId: () => null,
    }))

    const { AuditService } = await import("../modules/audit/audit.service")
    const captured: any[] = []
    const fakePrisma: any = {
      auditLog: { create: async (args: any) => captured.push(args) },
    }
    const service = new AuditService(fakePrisma)

    await service.log({ action: "TEST_ACTION", entityType: "Test" })

    expect(captured).toHaveLength(1)
    expect(captured[0].data.requestId).toBeNull()
    // metadata stays undefined when neither requestId nor params.metadata is present
    expect(captured[0].data.metadata).toBeUndefined()
  })

  it("preserves caller-supplied metadata keys alongside the requestId mirror", async () => {
    jest.resetModules()
    jest.doMock("@guestpost/shared/dist/observability/request-context", () => ({
      getRequestId: () => FAKE_REQUEST_ID,
    }))

    const { AuditService } = await import("../modules/audit/audit.service")
    const captured: any[] = []
    const fakePrisma: any = {
      auditLog: { create: async (args: any) => captured.push(args) },
    }
    const service = new AuditService(fakePrisma)

    await service.log({
      action: "TEST_ACTION",
      entityType: "Test",
      metadata: { customKey: "customValue", anotherKey: 42 },
    })

    expect(captured).toHaveLength(1)
    expect(captured[0].data.requestId).toBe(FAKE_REQUEST_ID)
    expect(captured[0].data.metadata).toEqual({
      customKey: "customValue",
      anotherKey: 42,
      requestId: FAKE_REQUEST_ID,
    })
  })

  it("routes through the provided tx when one is passed (atomic with financial mutation)", async () => {
    jest.resetModules()
    jest.doMock("@guestpost/shared/dist/observability/request-context", () => ({
      getRequestId: () => FAKE_REQUEST_ID,
    }))

    const { AuditService } = await import("../modules/audit/audit.service")
    const prismaCaptured: any[] = []
    const txCaptured: any[] = []
    const fakePrisma: any = {
      auditLog: { create: async (args: any) => prismaCaptured.push(args) },
    }
    const fakeTx: any = {
      auditLog: { create: async (args: any) => txCaptured.push(args) },
    }
    const service = new AuditService(fakePrisma)

    await service.log({ action: "FINANCIAL_ACTION", entityType: "Settlement" }, fakeTx)

    expect(prismaCaptured).toHaveLength(0)
    expect(txCaptured).toHaveLength(1)
    expect(txCaptured[0].data.requestId).toBe(FAKE_REQUEST_ID)
  })
})
