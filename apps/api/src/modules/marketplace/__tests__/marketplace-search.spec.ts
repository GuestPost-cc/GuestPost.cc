import { Prisma } from "@guestpost/database"
import { MarketplaceService } from "../marketplace.service"

function listingRow(id: string, price: number) {
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
    categoryId: null,
    metricsData: null,
    trafficData: null,
    semrushData: null,
    category: null,
    tags: [],
    images: [],
    reviews: [],
    publisher: null,
    website: { verificationStatus: "VERIFIED" },
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
      $queryRaw: jest.fn(),
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
      expect.objectContaining({ where: { id: { in: ["a", "b"] } } }),
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
    })

    const where = prisma.marketplaceListing.findMany.mock.calls[0][0].where
    expect(where.country).toEqual({ equals: "us", mode: "insensitive" })
    expect(where.language).toEqual({
      equals: "english",
      mode: "insensitive",
    })
    expect(where.OR).toEqual(
      expect.arrayContaining([
        {
          category: {
            name: { contains: "technology", mode: "insensitive" },
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
})
