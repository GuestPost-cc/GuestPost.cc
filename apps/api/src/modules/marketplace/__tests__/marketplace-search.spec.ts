import {
  Prisma,
  WebsiteMetricKey,
  WebsiteMetricProvider,
} from "@guestpost/database"
import { marketplaceAuthoritativeMetricSourcesFor } from "@guestpost/shared"
import { MarketplaceService } from "../marketplace.service"

const AUTHORITATIVE_TRAFFIC_SOURCES = marketplaceAuthoritativeMetricSourcesFor(
  WebsiteMetricKey.AHREFS_ORGANIC_TRAFFIC,
  WebsiteMetricProvider.AHREFS,
)
const AUTHORITATIVE_DR_SOURCES = marketplaceAuthoritativeMetricSourcesFor(
  WebsiteMetricKey.AHREFS_DOMAIN_RATING,
  WebsiteMetricProvider.AHREFS,
)

function listingRow(
  id: string,
  price: number,
  organicTraffic = 10_000,
  trafficSource = "AHREFS_PAID_API",
) {
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
      isActive: true,
      verificationStatus: "VERIFIED",
      metricsHistory: [
        {
          key: "AHREFS_ORGANIC_TRAFFIC",
          provider: "AHREFS",
          source: trafficSource,
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

function expectExplicitMetricSourceAllowlist(
  query: {
    sql: string
    values: unknown[]
  },
  expectedSources: readonly string[],
) {
  expect(query.sql).toContain('metric."source" IN (')
  for (const source of expectedSources) {
    expect(query.values).toContain(source)
  }
  for (const source of [
    "AHREFS_FREE_API",
    "AHREFS_PAID_API",
    "MOZ_PAID_API",
    "OPEN_PAGE_RANK_API",
    "PUBLISHER_MANUAL",
    "STAFF_MANUAL",
    "ADMIN_IMPORT",
    "FUTURE_UNREVIEWED_SOURCE",
  ]) {
    if (!expectedSources.includes(source)) {
      expect(query.values).not.toContain(source)
    }
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
      isActive: true,
      verificationStatus: "VERIFIED",
      AND: [
        {
          metricsHistory: {
            some: expect.objectContaining({
              key: "AHREFS_ORGANIC_TRAFFIC",
              provider: "AHREFS",
              source: { in: [...AUTHORITATIVE_TRAFFIC_SOURCES] },
              status: "CURRENT",
              value: { gte: 500, lte: 2_147_483_647 },
              OR: [
                { expiresAt: null },
                { expiresAt: { gt: expect.any(Date) } },
              ],
            }),
          },
        },
      ],
    })
  })

  it("filters DR through current source-aware Ahrefs metrics", async () => {
    await service.searchListings({ minDR: 30, maxDR: 70, sortBy: "newest" })

    const where = prisma.marketplaceListing.findMany.mock.calls[0][0].where
    expect(where.domainRating).toBeUndefined()
    expect(where.website.AND).toEqual([
      {
        metricsHistory: {
          some: expect.objectContaining({
            key: "AHREFS_DOMAIN_RATING",
            provider: "AHREFS",
            source: { in: [...AUTHORITATIVE_DR_SOURCES] },
            status: "CURRENT",
            value: { gte: 30, lte: 70 },
          }),
        },
      },
    ])
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
    expect(query.sql).toContain('availability_website."isActive" = TRUE')
    expect(query.sql).toContain(
      "availability_website.\"verificationStatus\" = 'VERIFIED'",
    )
    expect(query.sql).toContain('FROM "WebsiteMetric" metric')
    expect(query.sql).toContain(
      'metric."provider" = ?::"WebsiteMetricProvider"',
    )
    expectExplicitMetricSourceAllowlist(query, AUTHORITATIVE_TRAFFIC_SOURCES)
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
    expectExplicitMetricSourceAllowlist(query, AUTHORITATIVE_TRAFFIC_SOURCES)
    expect(query.sql).toContain("DESC NULLS LAST")
    expect(query.sql).toContain('listing."createdAt" DESC')
    expect(query.sql).toContain('listing."id" ASC')
    expect(query.sql).not.toContain('listing."traffic"')
  })

  it("uses source-aware Ahrefs DR for filtering and DR sorting", async () => {
    prisma.$queryRaw.mockResolvedValue([])

    await service.searchListings({ minDR: 25, maxDR: 80, sortBy: "dr" })

    const query = prisma.$queryRaw.mock.calls[0][0] as any
    expect(query.values).toContain("AHREFS_DOMAIN_RATING")
    expectExplicitMetricSourceAllowlist(query, AUTHORITATIVE_DR_SOURCES)
    expect(query.sql).toContain('metric."status" = ?::"WebsiteMetricStatus"')
    expect(query.sql).toContain("DESC NULLS LAST")
    expect(query.sql).not.toContain('listing."domainRating"')
  })

  it.each([
    "PUBLISHER_MANUAL",
    "STAFF_MANUAL",
  ])("displays current supplied organic traffic from source %s without making it authoritative", async (source) => {
    prisma.marketplaceListing.findMany.mockResolvedValue([
      listingRow("supplied", 100, 75_000, source),
    ])

    const result = await service.searchListings({ sortBy: "newest" })

    expect(result.listings[0].domainMetrics?.ahrefs.organicTraffic).toEqual(
      expect.objectContaining({
        value: 75_000,
        status: "CURRENT",
      }),
    )
    expect(
      result.listings[0].domainMetrics?.ahrefs.organicTraffic,
    ).not.toHaveProperty("source")
    expect(result.listings[0].traffic).toBeNull()
  })

  it.each([
    "ADMIN_IMPORT",
    "AHREFS_FREE_API",
  ])("hides unreviewed organic traffic from source %s", async (source) => {
    prisma.marketplaceListing.findMany.mockResolvedValue([
      listingRow("non-authoritative", 100, 75_000, source),
    ])

    const result = await service.searchListings({ sortBy: "newest" })

    expect(result.listings[0].domainMetrics).toBeUndefined()
    expect(result.listings[0].traffic).toBeNull()
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
        findFirst: jest.fn().mockResolvedValue({
          id: "source",
          status: "APPROVED",
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
    expectExplicitMetricSourceAllowlist(query, AUTHORITATIVE_TRAFFIC_SOURCES)
    expect(query.sql).toContain("DESC NULLS LAST")
    expect(query.sql).toContain('candidate."createdAt" DESC')
    expect(query.sql).toContain('candidate."id" ASC')
    expect(query.sql).not.toContain('candidate."traffic"')
  })
})
