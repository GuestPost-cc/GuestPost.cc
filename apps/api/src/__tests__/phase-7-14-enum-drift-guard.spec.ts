/**
 * Phase 7.14 — Static-source guard for partial-unique WHERE clause
 * enum-drift (#11).
 *
 * Both Settlement and FulfillmentAssignment have partial unique indexes
 * created via raw SQL (Prisma @@unique cannot express partial predicates).
 * These indexes hardcode enum values in their WHERE clauses. If a new enum
 * value is added without updating the partial unique, the race-condition
 * guarantee silently regresses.
 *
 * This spec reads the Prisma schema and migration SQL files to assert
 * consistency — no DB connection needed.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const SCHEMA_PATH = join(
  REPO_ROOT,
  "packages",
  "database",
  "prisma",
  "schema.prisma",
)
const FULFILLMENT_MIGRATION_PATH = join(
  REPO_ROOT,
  "packages",
  "database",
  "prisma",
  "migrations",
  "20260621030403_phase714_fulfillment_assignment_active_orderid_unique",
  "migration.sql",
)

function extractEnumValues(schema: string, enumName: string): string[] {
  const re = new RegExp(`enum ${enumName} \\{([^}]+)\\}`, "m")
  const match = schema.match(re)
  if (!match) {
    throw new Error(`${enumName} not found in schema.prisma`)
  }
  return match[1]
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function assertNoUnexpectedEnumValues(
  values: string[],
  known: string[],
  enumName: string,
  indexName: string,
  guidance: string,
): void {
  const knownSet = new Set(known)
  expect(values.length).toBeGreaterThanOrEqual(known.length)
  expect(values).toEqual(expect.arrayContaining(known))

  const unknown = values.filter((s) => !knownSet.has(s))
  if (unknown.length > 0) {
    throw new Error(
      [
        `${enumName} has new value(s): ${unknown.join(", ")}`,
        "",
        `Review the "${indexName}" partial unique index.`,
        guidance,
        "",
        "Once reviewed, add the new value(s) to the known set in this test.",
      ].join("\n\n"),
    )
  }
}

describe("Phase 7.14 — partial-unique WHERE clause enum-drift guard", () => {
  describe("FulfillmentAssignment_orderId_active_unique", () => {
    const KNOWN_STATUSES = [
      "ASSIGNED",
      "IN_PROGRESS",
      "DELIVERED",
      "CANCELLED",
    ] as const
    const ACTIVE_STATUSES = ["ASSIGNED", "IN_PROGRESS"] as const
    const TERMINAL_STATUSES = ["DELIVERED", "CANCELLED"] as const

    it("migration SQL has the expected index name and WHERE predicate", () => {
      const sql = readFileSync(FULFILLMENT_MIGRATION_PATH, "utf-8")
      expect(sql).toContain("FulfillmentAssignment_orderId_active_unique")
      expect(sql).toMatch(
        /WHERE\s+status\s+IN\s*\(\s*'ASSIGNED'\s*,\s*'IN_PROGRESS'\s*\)/,
      )
    })

    it("enum values and migration predicate remain consistent", () => {
      const sql = readFileSync(FULFILLMENT_MIGRATION_PATH, "utf-8")
      const schema = readFileSync(SCHEMA_PATH, "utf-8")
      const statuses = extractEnumValues(schema, "FulfillmentAssignmentStatus")

      assertNoUnexpectedEnumValues(
        statuses,
        [...KNOWN_STATUSES],
        "FulfillmentAssignmentStatus",
        "FulfillmentAssignment_orderId_active_unique",
        [
          "If the new status is an active claim state (like ASSIGNED / IN_PROGRESS),",
          "add it to the migration SQL's WHERE IN (...) predicate.",
          "If it is terminal (like DELIVERED / CANCELLED), no SQL change is needed.",
        ].join("\n"),
      )

      for (const active of ACTIVE_STATUSES) {
        expect(sql).toContain(active)
      }
      for (const terminal of TERMINAL_STATUSES) {
        expect(sql).not.toContain(`'${terminal}'`)
      }
    })
  })

  describe("Settlement_orderId_active_key (out-of-band)", () => {
    const KNOWN_STATUSES = [
      "PENDING",
      "UNDER_REVIEW",
      "CUSTOMER_APPROVED",
      "ADMIN_APPROVED",
      "RELEASED",
      "CANCELLED",
    ] as const

    it("SettlementStatus still has CANCELLED (the excluded value)", () => {
      const schema = readFileSync(SCHEMA_PATH, "utf-8")
      const statuses = extractEnumValues(schema, "SettlementStatus")

      assertNoUnexpectedEnumValues(
        statuses,
        [...KNOWN_STATUSES],
        "SettlementStatus",
        "Settlement_orderId_active_key (out-of-band, no migration file)",
        [
          "The current predicate is WHERE status != 'CANCELLED'.",
          "If the new status should be excluded from the partial unique (like CANCELLED),",
          "add it to the out-of-band index SQL.",
          "Otherwise it is automatically included — no SQL change needed.",
        ].join("\n"),
      )

      expect(statuses).toContain("CANCELLED")
    })
  })
})
