// Phase 7.1 — RevenueService unit tests.
//
// Mocked Prisma. Covers all 4 groupings, NULL-snapshot tolerance, soft-deleted
// Listing fallback, currency-mismatch detection (queries Order, not
// PlatformRevenue — Phase 0 finding), previous-period math, zero-denominator
// handling, Decimal precision.

import { Decimal } from "@prisma/client/runtime/client"
import { RevenueService } from "../finance/revenue.service"

type AnyMock = jest.Mock

interface PrismaMocks {
  platformRevenue: {
    groupBy: AnyMock
    aggregate: AnyMock
    count: AnyMock
  }
  listingService: { findMany: AnyMock }
  order: { findMany: AnyMock; count: AnyMock }
  $queryRawUnsafe: AnyMock
}

function makePrismaMock(): PrismaMocks {
  return {
    platformRevenue: {
      groupBy: jest.fn(),
      aggregate: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    listingService: { findMany: jest.fn().mockResolvedValue([]) },
    order: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  }
}

function svc(prismaMock: PrismaMocks): RevenueService {
  return new RevenueService(prismaMock as any)
}

// Aggregate response stubs ─────────────────────────────────────────────────
const zeroAggregate = {
  _sum: { amount: null, platformFee: null, netRevenue: null },
  _count: { _all: 0 },
}

function aggregate(
  sum: { amount: number; fee: number; net: number },
  count: number,
) {
  return {
    _sum: {
      amount: new Decimal(sum.amount),
      platformFee: new Decimal(sum.fee),
      netRevenue: new Decimal(sum.net),
    },
    _count: { _all: count },
  }
}

describe("Phase 7.1 — RevenueService", () => {
  describe("empty result", () => {
    it("returns zeroed totals and an empty buckets array", async () => {
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy.mockResolvedValue([])
      prisma.platformRevenue.aggregate.mockResolvedValue(zeroAggregate)

      const r = await svc(prisma).getRevenue({ groupBy: "channel" })

      expect(r.buckets).toEqual([])
      expect(r.totals.current).toEqual({
        grossAmount: "0.00",
        platformFee: "0.00",
        netRevenue: "0.00",
        rowCount: 0,
        reversedCount: 0,
        currency: "USD",
      })
      expect(r.totals.previous).toBeNull()
      expect(r.totals.deltaPct).toBeNull()
      expect(r.meta.currencyMismatch).toBeNull()
      expect(r.meta.timezone).toBe("UTC")
      expect(r.meta.groupBy).toBe("channel")
    })
  })

  describe("groupBy=channel", () => {
    it("returns PLATFORM + PUBLISHER buckets with correct sums and sorted ASC", async () => {
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy
        // Non-reversed sums
        .mockResolvedValueOnce([
          {
            fulfillmentChannel: "PLATFORM",
            ...aggregate({ amount: 200, fee: 20, net: 180 }, 2),
          },
          {
            fulfillmentChannel: "PUBLISHER",
            ...aggregate({ amount: 300, fee: 30, net: 270 }, 3),
          },
        ])
        // Reversed counts
        .mockResolvedValueOnce([])
      prisma.platformRevenue.aggregate.mockResolvedValue(zeroAggregate)

      const r = await svc(prisma).getRevenue({ groupBy: "channel" })

      expect(r.buckets).toHaveLength(2)
      expect(r.buckets[0]?.bucketKey).toBe("PLATFORM")
      expect(r.buckets[0]?.grossAmount).toBe("200.00")
      expect(r.buckets[0]?.platformFee).toBe("20.00")
      expect(r.buckets[0]?.netRevenue).toBe("180.00")
      expect(r.buckets[0]?.rowCount).toBe(2)
      expect(r.buckets[0]?.reversedCount).toBe(0)
      expect(r.buckets[1]?.bucketKey).toBe("PUBLISHER")
      expect(r.buckets[1]?.grossAmount).toBe("300.00")
    })
  })

  describe("groupBy=serviceType — NULL snapshot bucket", () => {
    it("collapses NULL serviceType into '(unknown)' bucket without crashing", async () => {
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy
        .mockResolvedValueOnce([
          {
            serviceType: "GUEST_POST",
            ...aggregate({ amount: 100, fee: 10, net: 90 }, 1),
          },
          {
            serviceType: null,
            ...aggregate({ amount: 50, fee: 5, net: 45 }, 1),
          },
        ])
        .mockResolvedValueOnce([])
      prisma.platformRevenue.aggregate.mockResolvedValue(zeroAggregate)

      const r = await svc(prisma).getRevenue({ groupBy: "serviceType" })

      expect(r.buckets.map((b) => b.bucketKey).sort()).toEqual([
        "(unknown)",
        "GUEST_POST",
      ])
      const unknownBucket = r.buckets.find((b) => b.bucketKey === "(unknown)")!
      expect(unknownBucket.grossAmount).toBe("50.00")
    })
  })

  describe("groupBy=month", () => {
    it("returns chronologically-ordered month buckets from raw SQL", async () => {
      const prisma = makePrismaMock()
      prisma.$queryRawUnsafe.mockResolvedValue([
        {
          month: new Date("2026-01-01T00:00:00Z"),
          gross: new Decimal(100),
          fee: new Decimal(10),
          net: new Decimal(90),
          row_count: BigInt(1),
          reversed_count: BigInt(0),
        },
        {
          month: new Date("2026-02-01T00:00:00Z"),
          gross: new Decimal(200),
          fee: new Decimal(20),
          net: new Decimal(180),
          row_count: BigInt(2),
          reversed_count: BigInt(0),
        },
      ])
      prisma.platformRevenue.aggregate.mockResolvedValue(zeroAggregate)

      const r = await svc(prisma).getRevenue({ groupBy: "month" })

      expect(r.buckets).toHaveLength(2)
      expect(r.buckets[0]?.bucket).toBe("2026-01")
      expect(r.buckets[0]?.bucketKey).toBe("2026-01-01")
      expect(r.buckets[1]?.bucket).toBe("2026-02")
      expect(r.buckets[1]?.netRevenue).toBe("180.00")
    })
  })

  describe("groupBy=listing — joined human title + sorted by netRevenue DESC", () => {
    it("joins ListingService → MarketplaceListing and populates structured fields", async () => {
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy
        .mockResolvedValueOnce([
          {
            listingServiceId: "lst-A",
            ...aggregate({ amount: 100, fee: 10, net: 90 }, 1),
          },
          {
            listingServiceId: "lst-B",
            ...aggregate({ amount: 500, fee: 50, net: 450 }, 3),
          },
          {
            listingServiceId: "lst-C",
            ...aggregate({ amount: 200, fee: 20, net: 180 }, 2),
          },
        ])
        .mockResolvedValueOnce([])
      prisma.listingService.findMany.mockResolvedValue([
        { id: "lst-A", listingId: "lis-A", listing: { title: "Acme Daily" } },
        { id: "lst-B", listingId: "lis-B", listing: { title: "Big Site" } },
        { id: "lst-C", listingId: "lis-C", listing: { title: "Cool Site" } },
      ])
      prisma.platformRevenue.aggregate.mockResolvedValue(zeroAggregate)

      const r = await svc(prisma).getRevenue({ groupBy: "listing" })

      // Sorted by netRevenue DESC
      expect(r.buckets.map((b) => b.bucketKey)).toEqual([
        "lst-B",
        "lst-C",
        "lst-A",
      ])
      const topEarner = r.buckets[0]!
      expect(topEarner.bucket).toBe("Big Site")
      expect(topEarner.listingServiceId).toBe("lst-B")
      expect(topEarner.listingId).toBe("lis-B")
      expect(topEarner.listingTitle).toBe("Big Site")
    })

    it("preserves bucket when ListingService→Listing join misses (soft-deleted)", async () => {
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy
        .mockResolvedValueOnce([
          {
            listingServiceId: "lst-ghost",
            ...aggregate({ amount: 100, fee: 10, net: 90 }, 1),
          },
        ])
        .mockResolvedValueOnce([])
      // findMany returns empty array — listing soft-deleted
      prisma.listingService.findMany.mockResolvedValue([])
      prisma.platformRevenue.aggregate.mockResolvedValue(zeroAggregate)

      const r = await svc(prisma).getRevenue({ groupBy: "listing" })

      expect(r.buckets).toHaveLength(1)
      expect(r.buckets[0]?.bucketKey).toBe("lst-ghost")
      expect(r.buckets[0]?.bucket).toBe("(listing not found)")
      expect(r.buckets[0]?.listingServiceId).toBe("lst-ghost")
      expect(r.buckets[0]?.listingId).toBeNull()
      expect(r.buckets[0]?.listingTitle).toBeNull()
      // Row is NOT dropped
      expect(r.buckets[0]?.netRevenue).toBe("90.00")
    })

    it("listing grouping with NULL listingServiceId → '(unknown)' with null structured fields", async () => {
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy
        .mockResolvedValueOnce([
          {
            listingServiceId: null,
            ...aggregate({ amount: 100, fee: 10, net: 90 }, 1),
          },
        ])
        .mockResolvedValueOnce([])
      prisma.platformRevenue.aggregate.mockResolvedValue(zeroAggregate)

      const r = await svc(prisma).getRevenue({ groupBy: "listing" })

      expect(r.buckets).toHaveLength(1)
      expect(r.buckets[0]?.bucketKey).toBe("(unknown)")
      expect(r.buckets[0]?.bucket).toBe("(unknown)")
      expect(r.buckets[0]?.listingServiceId).toBeNull()
      expect(r.buckets[0]?.listingId).toBeNull()
      expect(r.buckets[0]?.listingTitle).toBeNull()
    })
  })

  describe("reversed row handling", () => {
    it("excludes reversed rows from sums; surfaces reversedCount separately", async () => {
      const prisma = makePrismaMock()
      // 3 non-reversed PLATFORM rows summing to 300/30/270
      prisma.platformRevenue.groupBy
        .mockResolvedValueOnce([
          {
            fulfillmentChannel: "PLATFORM",
            ...aggregate({ amount: 300, fee: 30, net: 270 }, 3),
          },
        ])
        // 2 reversed rows for the same bucket
        .mockResolvedValueOnce([
          { fulfillmentChannel: "PLATFORM", _count: { _all: 2 } },
        ])
      prisma.platformRevenue.aggregate.mockResolvedValue(zeroAggregate)

      const r = await svc(prisma).getRevenue({ groupBy: "channel" })

      expect(r.buckets[0]?.rowCount).toBe(3)
      expect(r.buckets[0]?.reversedCount).toBe(2)
      expect(r.buckets[0]?.grossAmount).toBe("300.00")
    })

    it("preserves a reversed-only bucket (no non-reversed rows) so it isn't lost", async () => {
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { fulfillmentChannel: "PLATFORM", _count: { _all: 5 } },
        ])
      prisma.platformRevenue.aggregate.mockResolvedValue(zeroAggregate)

      const r = await svc(prisma).getRevenue({ groupBy: "channel" })

      expect(r.buckets).toHaveLength(1)
      expect(r.buckets[0]?.bucketKey).toBe("PLATFORM")
      expect(r.buckets[0]?.reversedCount).toBe(5)
      expect(r.buckets[0]?.grossAmount).toBe("0.00")
      expect(r.buckets[0]?.rowCount).toBe(0)
    })
  })

  describe("Decimal precision", () => {
    it("0.10 fee on a 1000.00 gross serializes as '100.00'", async () => {
      // The service trusts the writer's splitPlatformFee math; the test
      // confirms Decimal → string serialization doesn't add float drift.
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy
        .mockResolvedValueOnce([
          {
            fulfillmentChannel: "PLATFORM",
            ...aggregate({ amount: 1000, fee: 100, net: 900 }, 1),
          },
        ])
        .mockResolvedValueOnce([])
      prisma.platformRevenue.aggregate.mockResolvedValue(zeroAggregate)

      const r = await svc(prisma).getRevenue({ groupBy: "channel" })

      expect(r.buckets[0]?.platformFee).toBe("100.00")
      expect(r.buckets[0]?.grossAmount).toBe("1000.00")
      expect(r.buckets[0]?.netRevenue).toBe("900.00")
    })
  })

  describe("previous-period comparison", () => {
    it("computes a same-duration previous window when both from + to are set", async () => {
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy
        .mockResolvedValueOnce([
          {
            fulfillmentChannel: "PLATFORM",
            ...aggregate({ amount: 1200, fee: 120, net: 1080 }, 1),
          },
        ])
        .mockResolvedValueOnce([])
      prisma.platformRevenue.aggregate
        // Current totals
        .mockResolvedValueOnce(
          aggregate({ amount: 1200, fee: 120, net: 1080 }, 1),
        )
        // Previous totals
        .mockResolvedValueOnce(
          aggregate({ amount: 1000, fee: 100, net: 900 }, 1),
        )

      const r = await svc(prisma).getRevenue({
        from: "2026-05-01T00:00:00Z",
        to: "2026-05-31T23:59:59Z",
        groupBy: "channel",
      })

      expect(r.totals.previous).not.toBeNull()
      expect(r.totals.previous?.grossAmount).toBe("1000.00")
      expect(r.totals.deltaPct).not.toBeNull()
      expect(r.totals.deltaPct?.grossAmount).toBeCloseTo(20, 1) // +20%
      expect(r.totals.deltaPct?.platformFee).toBeCloseTo(20, 1)
      expect(r.totals.deltaPct?.netRevenue).toBeCloseTo(20, 1)
    })

    it("returns deltaPct null when previous gross is 0 (avoids Infinity / NaN)", async () => {
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
      prisma.platformRevenue.aggregate
        .mockResolvedValueOnce(
          aggregate({ amount: 1000, fee: 100, net: 900 }, 1),
        )
        .mockResolvedValueOnce(zeroAggregate)

      const r = await svc(prisma).getRevenue({
        from: "2026-05-01T00:00:00Z",
        to: "2026-05-31T23:59:59Z",
        groupBy: "channel",
      })

      expect(r.totals.previous).not.toBeNull()
      expect(r.totals.previous?.grossAmount).toBe("0.00")
      expect(r.totals.deltaPct).toBeNull()
    })

    it("returns previous: null when from + to are both unset (no prior window)", async () => {
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
      prisma.platformRevenue.aggregate.mockResolvedValueOnce(zeroAggregate)

      const r = await svc(prisma).getRevenue({ groupBy: "channel" })

      expect(r.totals.previous).toBeNull()
      expect(r.totals.deltaPct).toBeNull()
      // Only ONE aggregate call (no previous-window query)
      expect(prisma.platformRevenue.aggregate).toHaveBeenCalledTimes(1)
    })
  })

  describe("currency mismatch — queries Order, not PlatformRevenue", () => {
    it("populates meta.currencyMismatch when non-USD Orders exist in range", async () => {
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
      prisma.platformRevenue.aggregate.mockResolvedValue(zeroAggregate)
      prisma.order.findMany.mockResolvedValue([
        { currency: "EUR" },
        { currency: "GBP" },
      ])
      prisma.order.count.mockResolvedValue(3)

      const r = await svc(prisma).getRevenue({ groupBy: "channel" })

      expect(r.meta.currencyMismatch).not.toBeNull()
      expect(r.meta.currencyMismatch?.rowCount).toBe(3)
      // Sorted alphabetically
      expect(r.meta.currencyMismatch?.distinctCurrencies).toEqual([
        "EUR",
        "GBP",
      ])
    })

    it("returns currencyMismatch: null for a currency-clean range (USD only)", async () => {
      const prisma = makePrismaMock()
      prisma.platformRevenue.groupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
      prisma.platformRevenue.aggregate.mockResolvedValue(zeroAggregate)
      // No non-USD orders
      prisma.order.findMany.mockResolvedValue([])

      const r = await svc(prisma).getRevenue({ groupBy: "channel" })

      expect(r.meta.currencyMismatch).toBeNull()
    })
  })

  describe("input validation", () => {
    it("throws when `to` is before `from`", async () => {
      const prisma = makePrismaMock()
      await expect(
        svc(prisma).getRevenue({
          from: "2026-05-31T00:00:00Z",
          to: "2026-05-01T00:00:00Z",
          groupBy: "channel",
        }),
      ).rejects.toThrow(/must be on or after/)
    })

    it("throws on a malformed date string", async () => {
      const prisma = makePrismaMock()
      await expect(
        svc(prisma).getRevenue({
          from: "not-a-date",
          groupBy: "channel",
        }),
      ).rejects.toThrow(/Invalid date/)
    })
  })
})
