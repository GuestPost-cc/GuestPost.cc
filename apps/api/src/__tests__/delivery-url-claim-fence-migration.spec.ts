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
const financeRehearsalScript = fs.readFileSync(
  path.join(repoRoot, "scripts/verify-financial-migration-upgrade.sh"),
  "utf8",
)

describe("delivery URL claim fence migration contract", () => {
  it("uses the same advisory namespace as the application lock", () => {
    expect(migrationSql).toContain("hashtextextended(claim_url, 6182047)")
    expect(migrationSql).toMatch(/pg_advisory_xact_lock\(claim_lock_key\)/)
    expect(migrationSql).toMatch(
      /CREATE FUNCTION public\."acquire_delivery_url_claim_fence"\(claim_url TEXT\)\s+RETURNS BOOLEAN/,
    )
    expect(migrationSql).toMatch(/RETURN TRUE;/)
  })

  it("fences every mutation and preserves the existing Order-to-URL lock order", () => {
    const orderTriggerName = "OrderDeliveryVersion_settlement_order_lock"
    const urlTriggerName = "OrderDeliveryVersion_url_claim_lock"

    expect(orderTriggerName.localeCompare(urlTriggerName)).toBeLessThan(0)
    expect(migrationSql).toMatch(
      /CREATE TRIGGER "OrderDeliveryVersion_url_claim_lock"\s+BEFORE INSERT OR UPDATE OR DELETE ON public\."OrderDeliveryVersion"/,
    )
    expect(migrationSql).toContain(
      "OrderDeliveryVersion_settlement_order_lock trigger sorts first",
    )
    expect(migrationSql).toMatch(
      /LOCK TABLE public\."OrderDeliveryVersion" IN SHARE ROW EXCLUSIVE MODE/,
    )
    expect(migrationSql).toMatch(/empty normalized URL exists/)
    expect(migrationSql).toMatch(/LENGTH\(BTRIM\("normalizedUrl"\)\) = 0/)
    expect(migrationSql).toMatch(
      /EXECUTE FUNCTION public\."fence_delivery_url_claim_mutation"\(\)/,
    )
  })

  it("backfills and advances an MVCC row fence in deterministic lock order", () => {
    expect(migrationSql).toMatch(/CREATE TABLE public\."DeliveryUrlClaimFence"/)
    expect(migrationSql).toMatch(
      /SELECT DISTINCT "normalizedUrl", 0\s+FROM public\."OrderDeliveryVersion"/,
    )
    expect(migrationSql).toMatch(
      /FROM public\."DeliveryUrlClaimFence"[\s\S]*FOR UPDATE/,
    )
    expect(migrationSql).toMatch(
      /UPDATE public\."DeliveryUrlClaimFence"[\s\S]*SET "version" = "version" \+ 1/,
    )
    expect(migrationSql).toMatch(/ELSIF old_lock_key < new_lock_key THEN/)
    expect(migrationSql).toMatch(
      /ELSIF old_lock_key = new_lock_key THEN[\s\S]*ELSIF old_lock_key < new_lock_key THEN/,
    )
  })

  it("cannot be redirected through a caller-controlled temporary schema", () => {
    expect(
      migrationSql.match(/SECURITY INVOKER\s+SET search_path = pg_catalog/g),
    ).toHaveLength(2)
    expect(migrationSql).not.toMatch(
      /SECURITY INVOKER\s+SET search_path = pg_catalog, public/,
    )
    expect(migrationSql).toMatch(/INSERT INTO public\."DeliveryUrlClaimFence"/)
    expect(migrationSql).toMatch(
      /PERFORM public\."acquire_delivery_url_claim_fence"/,
    )
    expect(migrationSql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\."acquire_delivery_url_claim_fence"\(text\)[\s\S]*FROM PUBLIC/,
    )
    expect(migrationSql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\."fence_delivery_url_claim_mutation"\(\)[\s\S]*FROM PUBLIC/,
    )
    expect(migrationSql).toMatch(
      /REVOKE ALL ON TABLE public\."DeliveryUrlClaimFence" FROM PUBLIC/,
    )
    expect(migrationSql).toMatch(
      /ALTER FUNCTION public\."lock_settlement_blocker_order"\(\)[\s\S]*SET search_path = pg_catalog, public, pg_temp/,
    )
  })

  it("rehearses the runtime role and a stale SERIALIZABLE reader on PostgreSQL", () => {
    expect(financeRehearsalScript).toContain(
      "scripts/fixtures/post-delivery-url-fence-runtime-assertions.sql",
    )
    expect(financeRehearsalScript).toContain(
      "scripts/fixtures/delivery-url-fence-serializable-reader.sql",
    )
    expect(financeRehearsalScript).toContain(
      "scripts/fixtures/delivery-url-fence-concurrent-writer.sql",
    )
    expect(financeRehearsalScript).toContain("ERROR:  40001:")
  })
})
