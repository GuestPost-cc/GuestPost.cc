/**
 * Phase 7.14 — #23 FulfillmentAssignment claim race.
 *
 * The audit (2026-06-15 §2 #23): "Claim race lets two Ops both succeed."
 * order-fulfillment-assignment.service.ts:claim() did a findFirst pre-check
 * OUTSIDE its tx, then called upsertAssignment which did
 * updateMany({CANCELLED}) → create({ASSIGNED}) inside a tx. Two concurrent
 * claims both passed the pre-check, both entered the tx, both cancelled each
 * other's row and both created fresh rows — final state had ONE row but
 * BOTH Ops got a successful Promise back. The "loser" thought they owned
 * work that the "winner" actually cancelled.
 *
 * Fix:
 *   - Partial unique index on FulfillmentAssignment(orderId) WHERE status IN
 *     ('ASSIGNED','IN_PROGRESS') — makes the race structurally impossible
 *     at the DB level. Second-to-commit hits P2002.
 *   - app-layer: remove findFirst pre-check from claim(); each of the 3
 *     upsertAssignment callers (claim, assign, reassign) wraps the call in
 *     try/catch and maps P2002 → ConflictException with a caller-appropriate
 *     message. Gate 0.25 enumeration found 3 callers and decided per-caller
 *     catches (mixed semantics — claim's "self-pickup" vs assign/reassign's
 *     "admin override changed concurrently").
 *
 * Static-source assertions + regression guards. The deep "5-caller real
 * Promise.allSettled race" integration belongs in the manual-smoke step or
 * the future Phase 7.10.2 Nest+supertest harness — not jest.
 */
import { readFileSync, readdirSync } from "fs"
import { join } from "path"

describe("Phase 7.14 #23 — FulfillmentAssignment claim race", () => {
  const servicePath = join(
    __dirname,
    "..",
    "modules",
    "orders",
    "services",
    "order-fulfillment-assignment.service.ts",
  )
  const serviceSource = readFileSync(servicePath, "utf-8")

  // ─── app-layer: Plan B per-caller P2002 catches ────────────────────────
  describe("app-layer: 3 upsertAssignment callers each have try/catch(P2002)", () => {
    it("claim() wraps upsertAssignment in try/catch and maps P2002 to 'Order is already assigned'", () => {
      const startIdx = serviceSource.indexOf("async claim(")
      const endIdx = serviceSource.indexOf("async assign(")
      expect(startIdx).toBeGreaterThan(-1)
      expect(endIdx).toBeGreaterThan(startIdx)
      const block = serviceSource.slice(startIdx, endIdx)
      expect(block).toMatch(/try\s*\{[\s\S]*?await\s+this\.upsertAssignment\(/)
      expect(block).toMatch(/catch\s*\([^)]+\)\s*\{[\s\S]*?P2002[\s\S]*?ConflictException\(["']Order is already assigned["']\)/)
    })

    it("claim() NO LONGER contains the pre-7.14 findFirst pre-check (regression guard)", () => {
      const startIdx = serviceSource.indexOf("async claim(")
      const endIdx = serviceSource.indexOf("async assign(")
      const block = serviceSource.slice(startIdx, endIdx)
      // The bug: a findFirst-on-fulfillmentAssignment outside the tx.
      // The fix removes it entirely; the constraint is now authoritative.
      expect(block).not.toMatch(/this\.prisma\.fulfillmentAssignment\.findFirst/)
    })

    it("assign() wraps upsertAssignment in try/catch and maps P2002 to the concurrent-change message", () => {
      const startIdx = serviceSource.indexOf("async assign(")
      const endIdx = serviceSource.indexOf("async reassign(")
      expect(startIdx).toBeGreaterThan(-1)
      expect(endIdx).toBeGreaterThan(startIdx)
      const block = serviceSource.slice(startIdx, endIdx)
      expect(block).toMatch(/try\s*\{[\s\S]*?await\s+this\.upsertAssignment\(/)
      expect(block).toMatch(/catch\s*\([^)]+\)\s*\{[\s\S]*?P2002[\s\S]*?ConflictException\(["']Order assignment changed concurrently[^"']*["']\)/)
    })

    it("reassign() wraps upsertAssignment in try/catch and maps P2002 to the concurrent-change message", () => {
      const startIdx = serviceSource.indexOf("async reassign(")
      expect(startIdx).toBeGreaterThan(-1)
      const block = serviceSource.slice(startIdx, startIdx + 800)
      expect(block).toMatch(/try\s*\{[\s\S]*?await\s+this\.upsertAssignment\(/)
      expect(block).toMatch(/catch\s*\([^)]+\)\s*\{[\s\S]*?P2002[\s\S]*?ConflictException\(["']Order assignment changed concurrently[^"']*["']\)/)
    })
  })

  // ─── migration: partial unique exists with correct shape ───────────────
  describe("migration: partial unique on (orderId) WHERE status IN active", () => {
    it("Phase 7.14 migration file exists with CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS + WHERE clause", () => {
      const migrationsDir = join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "packages",
        "database",
        "prisma",
        "migrations",
      )
      const phase714Dirs = readdirSync(migrationsDir).filter((d: string) =>
        d.includes("phase714_fulfillment_assignment_active_orderid_unique"),
      )
      expect(phase714Dirs.length).toBe(1)
      const migSql = readFileSync(join(migrationsDir, phase714Dirs[0], "migration.sql"), "utf-8")
      // Single-statement migration (prisma@7.8.0 wraps multi-statement files in tx — would break CONCURRENTLY)
      expect(migSql).toMatch(
        /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "FulfillmentAssignment_orderId_active_unique"[\s\S]*ON "FulfillmentAssignment"\("orderId"\)[\s\S]*WHERE status IN \('ASSIGNED', 'IN_PROGRESS'\)/,
      )
    })
  })

  // ─── schema.prisma documents the raw-SQL partial unique ─────────────────
  describe("schema.prisma documents the new partial unique", () => {
    it("FulfillmentAssignment model NOTE references Phase 7.14 + partial unique + #23", () => {
      const schemaPath = join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "packages",
        "database",
        "prisma",
        "schema.prisma",
      )
      const schema = readFileSync(schemaPath, "utf-8")
      const modelIdx = schema.indexOf("model FulfillmentAssignment {")
      expect(modelIdx).toBeGreaterThan(-1)
      const modelBlock = schema.slice(modelIdx, modelIdx + 2000)
      expect(modelBlock).toMatch(/Phase 7\.14/)
      expect(modelBlock).toMatch(/FulfillmentAssignment_orderId_active_unique/)
      expect(modelBlock).toMatch(/#23/)
    })
  })
})
