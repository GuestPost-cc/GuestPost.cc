import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const migrationSql = fs.readFileSync(
  path.join(
    repoRoot,
    "packages/database/prisma/migrations/20260811133000_delivery_url_claim_fence/migration.sql",
  ),
  "utf8",
)

describe("delivery URL claim fence migration contract", () => {
  it("uses the same advisory namespace as the application lock", () => {
    expect(migrationSql).toContain("hashtextextended(claim_url, 6182047)")
    expect(migrationSql).toMatch(/pg_advisory_xact_lock\(claim_lock_key\)/)
    expect(migrationSql).toMatch(
      /CREATE FUNCTION "acquire_delivery_url_claim_fence"\(claim_url TEXT\)\s+RETURNS BOOLEAN/,
    )
    expect(migrationSql).toMatch(/RETURN TRUE;/)
  })

  it("fences every mutation and preserves the existing Order-to-URL lock order", () => {
    const orderTriggerName = "OrderDeliveryVersion_settlement_order_lock"
    const urlTriggerName = "OrderDeliveryVersion_url_claim_lock"

    expect(orderTriggerName.localeCompare(urlTriggerName)).toBeLessThan(0)
    expect(migrationSql).toMatch(
      /CREATE TRIGGER "OrderDeliveryVersion_url_claim_lock"\s+BEFORE INSERT OR UPDATE OR DELETE ON "OrderDeliveryVersion"/,
    )
    expect(migrationSql).toContain(
      "OrderDeliveryVersion_settlement_order_lock trigger sorts first",
    )
    expect(migrationSql).toMatch(
      /LOCK TABLE "OrderDeliveryVersion" IN SHARE ROW EXCLUSIVE MODE/,
    )
    expect(migrationSql).toMatch(/empty normalized URL exists/)
    expect(migrationSql).toMatch(
      /EXECUTE FUNCTION "fence_delivery_url_claim_mutation"\(\)/,
    )
  })

  it("backfills and advances an MVCC row fence in deterministic lock order", () => {
    expect(migrationSql).toMatch(/CREATE TABLE "DeliveryUrlClaimFence"/)
    expect(migrationSql).toMatch(
      /SELECT DISTINCT "normalizedUrl", 0\s+FROM "OrderDeliveryVersion"/,
    )
    expect(migrationSql).toMatch(
      /FROM "DeliveryUrlClaimFence"[\s\S]*FOR UPDATE/,
    )
    expect(migrationSql).toMatch(
      /UPDATE "DeliveryUrlClaimFence"[\s\S]*SET "version" = "version" \+ 1/,
    )
    expect(migrationSql).toMatch(/ELSIF old_lock_key < new_lock_key THEN/)
    expect(migrationSql).toMatch(
      /ELSIF old_lock_key = new_lock_key THEN[\s\S]*ELSIF old_lock_key < new_lock_key THEN/,
    )
  })
})
