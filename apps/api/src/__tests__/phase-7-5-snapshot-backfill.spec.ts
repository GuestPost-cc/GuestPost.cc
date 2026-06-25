// Phase 7.5 — Phase 6 snapshot backfill (audit #21).
//
// Two-layer coverage per the plan:
//   1. Migration SQL regression guards (grep-style) — catches future edits
//      that break idempotency or remove the COALESCE / WHERE shape
//   2. Algorithmic-correctness via JS reimplementation against in-memory
//      fixtures — proves the COALESCE logic for the 4 scenarios without
//      requiring a real Postgres in the test runner
//
// Real-DB confirmation lives in the Phase 7.5 manual smoke step (apply
// migration to dev, record before/after counts in the §11 entry).

import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const MIGRATION_PATH = path.join(
  repoRoot,
  "packages/database/prisma/migrations/20260616110000_phase75_phase6_snapshot_backfill/migration.sql",
)

describe("Phase 7.5 — migration regression guards", () => {
  it("migration file exists at the expected path", () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true)
  })

  describe("Settlement backfill SQL", () => {
    let sql: string
    beforeAll(() => {
      sql = fs.readFileSync(MIGRATION_PATH, "utf8")
    })

    it("targets Settlement table", () => {
      expect(sql).toMatch(/UPDATE "Settlement"\s+s/)
    })

    it("uses COALESCE for every backfilled column (preserves partially-populated rows)", () => {
      for (const col of [
        "listingServiceId",
        "serviceType",
        "unitPrice",
        "fulfillmentChannel",
        "ownerType",
      ]) {
        expect(sql).toMatch(
          new RegExp(`"${col}"\\s*=\\s*COALESCE\\(s\\."${col}"`),
        )
      }
    })

    it("joins Order, ListingService, and Website with LEFT JOIN on the optional tables", () => {
      expect(sql).toMatch(/FROM "Order" o/)
      expect(sql).toMatch(/LEFT JOIN "ListingService" ls/)
      expect(sql).toMatch(/LEFT JOIN "Website" w/)
    })

    it("WHERE clause includes IS NULL on every backfilled column (idempotency)", () => {
      // The full WHERE has an OR-joined set of IS NULL checks — every column
      // appears at least once. Re-running with all rows already populated
      // matches nothing and updates 0 rows.
      const settlementBlock = sql.split("-- ── PlatformRevenue")[0]!
      for (const col of [
        "listingServiceId",
        "serviceType",
        "unitPrice",
        "fulfillmentChannel",
        "ownerType",
      ]) {
        expect(settlementBlock).toMatch(new RegExp(`s\\."${col}"\\s+IS NULL`))
      }
    })
  })

  describe("PlatformRevenue backfill SQL", () => {
    let sql: string
    beforeAll(() => {
      sql = fs.readFileSync(MIGRATION_PATH, "utf8")
    })

    it("targets PlatformRevenue table with same shape", () => {
      expect(sql).toMatch(/UPDATE "PlatformRevenue"\s+pr/)
    })

    it("uses COALESCE for every backfilled column", () => {
      const prBlock = sql.split("-- ── PlatformRevenue")[1] ?? ""
      for (const col of [
        "listingServiceId",
        "serviceType",
        "unitPrice",
        "fulfillmentChannel",
        "ownerType",
      ]) {
        expect(prBlock).toMatch(
          new RegExp(`"${col}"\\s*=\\s*COALESCE\\(pr\\."${col}"`),
        )
      }
    })

    it("WHERE clause includes IS NULL on every backfilled column", () => {
      const prBlock = sql.split("-- ── PlatformRevenue")[1] ?? ""
      for (const col of [
        "listingServiceId",
        "serviceType",
        "unitPrice",
        "fulfillmentChannel",
        "ownerType",
      ]) {
        expect(prBlock).toMatch(new RegExp(`pr\\."${col}"\\s+IS NULL`))
      }
    })
  })

  it("migration is bracketed by Phase 7.5 comment header for forensic clarity", () => {
    const sql = fs.readFileSync(MIGRATION_PATH, "utf8")
    expect(sql).toMatch(/Phase 7\.5/)
    expect(sql).toMatch(/audit #21/)
    // Idempotency rationale documented inline
    expect(sql).toMatch(/[Ii]dempotent/)
  })
})

// ── Algorithmic-correctness: JS reimplementation of the COALESCE + WHERE logic
// against in-memory fixtures. Mirrors what the SQL does row-by-row so we can
// prove the 4 backfill scenarios behave as intended without a real Postgres.
describe("Phase 7.5 — backfill algorithmic correctness (4 scenarios)", () => {
  interface Fixture {
    settlement: {
      orderId: string
      listingServiceId: string | null
      serviceType: string | null
      unitPrice: string | null
      fulfillmentChannel: string | null
      ownerType: string | null
    }
    order: {
      id: string
      listingServiceId: string | null
      fulfillmentChannel: string | null
      websiteId: string | null
    }
    listingService?: { id: string; serviceType: string; price: string }
    website?: { id: string; ownershipType: string }
  }

  /**
   * Mirrors the migration's WHERE filter: row qualifies if ANY backfilled
   * column is NULL.
   */
  function qualifiesForBackfill(s: Fixture["settlement"]): boolean {
    return (
      s.listingServiceId === null ||
      s.serviceType === null ||
      s.unitPrice === null ||
      s.fulfillmentChannel === null ||
      s.ownerType === null
    )
  }

  /**
   * Mirrors the migration's COALESCE(existing, computed) for each column.
   * `existing` (the current Settlement value) wins when non-NULL — only
   * NULL columns get filled from the joined source.
   */
  function applyBackfill(f: Fixture): Fixture["settlement"] {
    if (!qualifiesForBackfill(f.settlement)) return f.settlement
    const ls = f.listingService
    const w = f.website
    return {
      orderId: f.settlement.orderId,
      listingServiceId:
        f.settlement.listingServiceId ?? f.order.listingServiceId,
      serviceType: f.settlement.serviceType ?? ls?.serviceType ?? null,
      unitPrice: f.settlement.unitPrice ?? ls?.price ?? null,
      fulfillmentChannel:
        f.settlement.fulfillmentChannel ?? f.order.fulfillmentChannel,
      ownerType: f.settlement.ownerType ?? w?.ownershipType ?? null,
    }
  }

  it("scenario 1: all 5 fields NULL + full join chain available → all 5 populated", () => {
    const result = applyBackfill({
      settlement: {
        orderId: "ord-1",
        listingServiceId: null,
        serviceType: null,
        unitPrice: null,
        fulfillmentChannel: null,
        ownerType: null,
      },
      order: {
        id: "ord-1",
        listingServiceId: "lst-1",
        fulfillmentChannel: "PUBLISHER",
        websiteId: "web-1",
      },
      listingService: {
        id: "lst-1",
        serviceType: "GUEST_POST",
        price: "150.00",
      },
      website: { id: "web-1", ownershipType: "PUBLISHER" },
    })
    expect(result).toEqual({
      orderId: "ord-1",
      listingServiceId: "lst-1",
      serviceType: "GUEST_POST",
      unitPrice: "150.00",
      fulfillmentChannel: "PUBLISHER",
      ownerType: "PUBLISHER",
    })
  })

  it("scenario 2: partially-populated row → only NULL fields touched (COALESCE preserves)", () => {
    // Existing serviceType + fulfillmentChannel are different from what the
    // join would compute — the migration MUST preserve them. This is the
    // key test for the COALESCE(existing, computed) ordering.
    const result = applyBackfill({
      settlement: {
        orderId: "ord-2",
        listingServiceId: null,
        serviceType: "NICHE_EDIT", // already set — must be preserved
        unitPrice: null,
        fulfillmentChannel: "PLATFORM", // already set — must be preserved
        ownerType: null,
      },
      order: {
        id: "ord-2",
        listingServiceId: "lst-2",
        fulfillmentChannel: "PUBLISHER", // would overwrite if migration was blind
        websiteId: "web-2",
      },
      listingService: {
        id: "lst-2",
        serviceType: "GUEST_POST",
        price: "100.00",
      },
      website: { id: "web-2", ownershipType: "PUBLISHER" },
    })
    // Populated fields preserved; NULL fields filled
    expect(result.serviceType).toBe("NICHE_EDIT")
    expect(result.fulfillmentChannel).toBe("PLATFORM")
    expect(result.listingServiceId).toBe("lst-2")
    expect(result.unitPrice).toBe("100.00")
    expect(result.ownerType).toBe("PUBLISHER")
  })

  it("scenario 3: all 5 fields populated → row doesn't qualify; no-op (idempotency)", () => {
    const settlement = {
      orderId: "ord-3",
      listingServiceId: "lst-3",
      serviceType: "GUEST_POST",
      unitPrice: "200.00",
      fulfillmentChannel: "PUBLISHER",
      ownerType: "PUBLISHER",
    }
    expect(qualifiesForBackfill(settlement)).toBe(false)
    const result = applyBackfill({
      settlement,
      order: {
        id: "ord-3",
        listingServiceId: "different",
        fulfillmentChannel: "PLATFORM",
        websiteId: "web-x",
      },
      listingService: {
        id: "different",
        serviceType: "OUTREACH_LINK",
        price: "999.99",
      },
      website: { id: "web-x", ownershipType: "PLATFORM" },
    })
    // Identical to input — migration skips this row entirely
    expect(result).toEqual(settlement)
  })

  it("scenario 4: pre-Phase-4 order (Order.listingServiceId NULL) → all 5 fields stay NULL", () => {
    // Data was never captured at order creation; ListingService can't be
    // joined, so serviceType + unitPrice + ownerType (via Website) stay NULL.
    // Acceptable per audit: "row stays NULL." Phase 7.1 dashboard shows
    // these in the "(unknown)" bucket. NO error, NO crash.
    const result = applyBackfill({
      settlement: {
        orderId: "ord-4",
        listingServiceId: null,
        serviceType: null,
        unitPrice: null,
        fulfillmentChannel: null,
        ownerType: null,
      },
      order: {
        id: "ord-4",
        listingServiceId: null, // pre-Phase-4 order
        fulfillmentChannel: null, // also pre-Phase-6
        websiteId: null, // ancient order without website link
      },
      // No listingService, no website join match
    })
    expect(result).toEqual({
      orderId: "ord-4",
      listingServiceId: null,
      serviceType: null,
      unitPrice: null,
      fulfillmentChannel: null,
      ownerType: null,
    })
  })

  it("bonus: ownerType falls back to Website.ownershipType when fulfillmentChannel is NULL", () => {
    // Mirrors the snapshot-first / ownership-fallback pattern from Phase 7.1.
    const result = applyBackfill({
      settlement: {
        orderId: "ord-5",
        listingServiceId: "lst-5",
        serviceType: "GUEST_POST",
        unitPrice: "50.00",
        fulfillmentChannel: null,
        ownerType: null, // will be filled from Website
      },
      order: {
        id: "ord-5",
        listingServiceId: "lst-5",
        fulfillmentChannel: null, // Order didn't capture channel either
        websiteId: "web-5",
      },
      listingService: {
        id: "lst-5",
        serviceType: "GUEST_POST",
        price: "50.00",
      },
      website: { id: "web-5", ownershipType: "PLATFORM" },
    })
    expect(result.ownerType).toBe("PLATFORM")
    expect(result.fulfillmentChannel).toBeNull() // Order had no channel; stays NULL
  })
})
