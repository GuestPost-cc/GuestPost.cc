import { Prisma } from "@guestpost/database"
import { MarketplaceService } from "../marketplace.service"

function listingRow(id: string, price: number, organicTraffic = 10_000) {
  return {
    id,
    title: `Listing ${id}`,
    slug: `listing-${id}`,
    description: "A marketplace listing",
    shortDescription: null,
    status: "APPROVED",
    fulfillmentType: "PUBLISHER",
    ownerType: "PUBLISHER",
    currency: "USD",
    priceType: "fixed",
    minPrice: null,
    maxPrice: null,
    domainRating: 50,
    domainAuthority: null,
    traffic: 10_000,
    referringDomains: null,
    spamScore: null,
    country: "US",
    language: "English",
    countries: [],
    languages: [],
    featured: false,
    verified: true,
    doFollowOnly: false,
    websiteUrl: null,
    sampleUrl: null,
    signupUrl: null,
    publishedAt: null,
    expiresAt: null,
    createdAt: new Date("2026-07-18T00:00:00Z"),
    updatedAt: new Date("2026-07-18T00:00:00Z"),
    publisherId: "publisher-1",
    websiteId: `website-${id}`,
    organizationId: null,
    metricsData: null,
    trafficData: null,
    semrushData: null,
    categories: [],
    tags: [],
    images: [],
    reviews: [],
    publisher: null,
    website: {
      verificationStatus: "VERIFIED",
      metricsHistory: [
        {
          key: "AHREFS_ORGANIC_TRAFFIC",
          provider: "AHREFS",
          source: "PUBLISHER_MANUAL",
          status: "CURRENT",
          value: new Prisma.Decimal(organicTraffic),
          measuredAt: new Date("2026-07-18T00:00:00Z"),
          collectedAt: new Date("2026-07-18T01:00:00Z"),
          expiresAt: new Date("2099-01-01T00:00:00Z"),
        },
      ],
      websiteIntegrations: [],
    },
    services: [
      {
        id: `service-${id}`,
        listingId: id,
        serviceType: "GUEST_POST",
        price: new Prisma.Decimal(price),
        currency: "USD",
        turnaroundDays: 7,
        revisionRounds: 2,
        warrantyDays: null,
        requirements: null,
        fulfillmentSettings: null,
        availability: "AVAILABLE",
        version: 0,
        createdAt: new Date("2026-07-18T00:00:00Z"),
        updatedAt: new Date("2026-07-18T00:00:00Z"),
      },
    ],
  }
}

describe("MarketplaceService search", () => {
  let prisma: any
  let service: MarketplaceService

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      marketplaceListing: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
    }
    service = new MarketplaceService(prisma, {} as any)
  })

  it("sorts by the matching available service price and preserves SQL order", async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: "a" }, { id: "b" }])
    prisma.marketplaceListing.count.mockResolvedValue(2)
    prisma.marketplaceListing.findMany.mockResolvedValue([
      listingRow("b", 200),
      listingRow("a", 100),
    ])

    const result = await service.searchListings({
      sortBy: "price_asc",
      type: "GUEST_POST",
      minPrice: 50,
      page: 1,
      limit: 20,
    })

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    expect(prisma.marketplaceListing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            expect.objectContaining({ status: "APPROVED" }),
            { id: { in: ["a", "b"] } },
          ],
        },
      }),
    )
    expect(result.listings.map((listing: any) => listing.id)).toEqual([
      "a",
      "b",
    ])
  })

  it("searches category and tag names and matches location case-insensitively", async () => {
    await service.searchListings({
      query: "technology",
      country: "us",
      language: "english",
      sortBy: "newest",
    })

    const where = prisma.marketplaceListing.findMany.mock.calls[0][0].where
    expect(where.country).toEqual({ equals: "us", mode: "insensitive" })
    expect(where.language).toEqual({
      in: ["english"],
      mode: "insensitive",
    })
    expect(where.OR).toEqual(
      expect.arrayContaining([
        {
          categories: {
            some: {
              category: {
                name: { contains: "technology", mode: "insensitive" },
              },
            },
          },
        },
        {
          tags: {
            some: {
              tag: { name: { contains: "technology", mode: "insensitive" } },
            },
          },
        },
      ]),
    )
  })

  it("combines multi-category, language, and placement-policy filters", async () => {
    await service.searchListings({
      categories: ["saas", "technology-and-gadgets"],
      languages: ["English", "French"],
      backlinkCounts: [1, 2],
      linkTypes: ["DOFOLLOW"],
      linkValidities: ["PERMANENT", "ONE_YEAR"],
      cryptoAllowed: true,
      googleNews: false,
      sortBy: "newest",
    })

    const where = prisma.marketplaceListing.findMany.mock.calls[0][0].where
    expect(where.categories).toEqual({
      some: {
        category: {
          slug: { in: ["saas", "technology-and-gadgets"] },
        },
      },
    })
    expect(where.language).toEqual({
      in: ["English", "French"],
      mode: "insensitive",
    })
    expect(where.backlinkCount).toEqual({ in: [1, 2] })
    expect(where.linkType).toEqual({ in: ["DOFOLLOW"] })
    expect(where.linkValidity).toEqual({ in: ["PERMANENT", "ONE_YEAR"] })
    expect(where.cryptoAllowed).toBe(true)
    expect(where.googleNews).toBe(false)
  })

  it("filters candidates through a current, unexpired Ahrefs WebsiteMetric", async () => {
    await service.searchListings({ minTraffic: 500, sortBy: "newest" })

    const where = prisma.marketplaceListing.findMany.mock.calls[0][0].where
    expect(where.traffic).toBeUndefined()
    expect(where.website).toEqual({
      metricsHistory: {
        some: expect.objectContaining({
          key: "AHREFS_ORGANIC_TRAFFIC",
          provider: "AHREFS",
          status: "CURRENT",
          value: { gte: 500, lte: 2_147_483_647 },
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
      },
    })
  })

  it("uses canonical traffic SQL for filtering and preserves traffic-rank order", async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: "b" }, { id: "a" }])
    prisma.marketplaceListing.count.mockResolvedValue(2)
    // Deliberately return the rows in the opposite order and give the legacy
    // listing field values that disagree with the canonical rank.
    prisma.marketplaceListing.findMany.mockResolvedValue([
      { ...listingRow("a", 100, 100), traffic: 999_999 },
      { ...listingRow("b", 100, 20_000), traffic: 1 },
    ])

    const result = await service.searchListings({
      minTraffic: 50,
      sortBy: "traffic",
    })

    expect(result.listings.map((listing: any) => listing.id)).toEqual([
      "b",
      "a",
    ])
    expect(result.listings.map((listing: any) => listing.traffic)).toEqual([
      20_000, 100,
    ])
    const query = prisma.$queryRaw.mock.calls[0][0] as any
    expect(query.sql).toContain('FROM "WebsiteMetric" metric')
    expect(query.sql).toContain(
      'metric."provider" = ?::"WebsiteMetricProvider"',
    )
    expect(query.sql).toContain('metric."expiresAt" > ?')
    expect(query.sql).toContain("DESC NULLS LAST")
    expect(query.sql).toContain('listing."id" ASC')
    expect(query.sql).not.toContain('listing."traffic"')
  })

  it("uses canonical traffic for default ranking with deterministic null ordering", async () => {
    prisma.$queryRaw.mockResolvedValue([])

    await service.searchListings({})

    const query = prisma.$queryRaw.mock.calls[0][0] as any
    expect(query.sql).toContain('listing."featured" DESC')
    expect(query.sql).toContain('FROM "WebsiteMetric" metric')
    expect(query.sql).toContain("DESC NULLS LAST")
    expect(query.sql).toContain('listing."createdAt" DESC')
    expect(query.sql).toContain('listing."id" ASC')
    expect(query.sql).not.toContain('listing."traffic"')
  })
})

describe("MarketplaceService traffic-ranked recommendations", () => {
  it("ranks with canonical Ahrefs metrics and preserves deterministic SQL order", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "b" }, { id: "a" }]),
      marketplaceRecommendation: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      marketplaceListing: {
        findUnique: jest.fn().mockResolvedValue({
          id: "source",
          publisherId: "publisher-1",
          categories: [{ categoryId: "category-1" }],
          services: [{ serviceType: "GUEST_POST" }],
        }),
        findMany: jest.fn().mockResolvedValue([
          { ...listingRow("a", 100), traffic: 999_999 },
          { ...listingRow("b", 100), traffic: 1 },
        ]),
      },
    }
    const service = new MarketplaceService(prisma, {} as any)

    const result = await service.getRecommendations("user-1", {
      listingId: "source",
      limit: 2,
    })

    expect(result.map((listing: any) => listing.id)).toEqual(["b", "a"])
    const query = prisma.$queryRaw.mock.calls[0][0] as any
    expect(query.sql).toContain('FROM "WebsiteMetric" metric')
    expect(query.sql).toContain('metric."websiteId" = candidate."websiteId"')
    expect(query.sql).toContain("DESC NULLS LAST")
    expect(query.sql).toContain('candidate."createdAt" DESC')
    expect(query.sql).toContain('candidate."id" ASC')
    expect(query.sql).not.toContain('candidate."traffic"')
  })
})
