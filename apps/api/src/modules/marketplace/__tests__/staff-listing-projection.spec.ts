import { MarketplaceService } from "../marketplace.service"

function listing(ownerType: "PUBLISHER" | "PLATFORM") {
  const now = new Date("2026-07-23T00:00:00.000Z")
  return {
    id: "listing-1",
    title: "Example listing",
    slug: "example-listing",
    description: "A complete marketplace listing description.",
    shortDescription: null,
    status: "APPROVED",
    ownerType,
    fulfillmentType: ownerType === "PLATFORM" ? "INTERNAL" : "PUBLISHER",
    currency: "USD",
    featured: false,
    verified: true,
    country: "US",
    language: "English",
    websiteUrl: "https://example.com",
    sampleUrl: null,
    sportsGamingAllowed: false,
    pharmacyAllowed: false,
    cryptoAllowed: false,
    backlinkCount: 1,
    linkType: "DOFOLLOW",
    linkValidity: "PERMANENT",
    googleNews: false,
    markedSponsored: false,
    foreignLanguageAllowed: false,
    categories: [
      { category: { id: "cat-1", name: "Technology", slug: "technology" } },
    ],
    tags: [],
    images: [],
    organization: { id: "org-1", name: "Publisher org" },
    publisher:
      ownerType === "PUBLISHER"
        ? {
            id: "publisher-1",
            name: "Example publisher",
            email: "private@example.com",
            tier: "TRUSTED",
            profile: {
              rating: 4.7,
              totalReviews: 12,
              responseTime: 8,
              completionRate: 98,
              trustScore: 91,
            },
          }
        : null,
    website: {
      id: "website-1",
      url: "https://example.com",
      domain: "example.com",
      ownershipType: ownerType,
      managedByUserId: ownerType === "PLATFORM" ? "ops-1" : null,
      managedBy:
        ownerType === "PLATFORM"
          ? { id: "ops-1", name: "Operator", email: "ops@example.com" }
          : null,
      verificationStatus: "VERIFIED",
      verifiedAt: now,
      websiteIntegrations: [],
      metricsHistory: [
        {
          key: "AHREFS_DOMAIN_RATING",
          value: 61,
          source: "AHREFS_FREE_API",
          status: "CURRENT",
          measuredAt: now,
          collectedAt: now,
          expiresAt: null,
        },
        {
          key: "MOZ_DOMAIN_AUTHORITY",
          value: 48,
          source:
            ownerType === "PLATFORM" ? "STAFF_MANUAL" : "PUBLISHER_MANUAL",
          status: "CURRENT",
          measuredAt: now,
          collectedAt: now,
          expiresAt: null,
        },
      ],
    },
    services: [
      {
        id: "service-1",
        serviceType: "GUEST_POST",
        price: 125,
        currency: "USD",
        turnaroundDays: 7,
        revisionRounds: 2,
        warrantyDays: 30,
        availability: "AVAILABLE",
        version: 1,
        fulfillmentSettings: { secret: true },
      },
    ],
    reviews: [],
    createdAt: now,
    updatedAt: now,
  }
}

describe("staff marketplace listing projection", () => {
  it("gives Finance read-only publisher context without contact data", async () => {
    const prisma = {
      marketplaceListing: {
        findUnique: jest.fn().mockResolvedValue(listing("PUBLISHER")),
      },
    }
    const service = new MarketplaceService(prisma as any, {} as any)

    const result = await service.getListingForStaff("example-listing", {
      id: "finance-1",
      staffRole: "FINANCE",
    })

    expect(result.access).toEqual({
      role: "FINANCE",
      canModerate: false,
      canManageGlobalFlags: false,
      canManageServices: false,
    })
    expect(result.publisher).toEqual(
      expect.objectContaining({ id: "publisher-1", name: "Example publisher" }),
    )
    expect(result.publisher).not.toHaveProperty("email")
    expect(result.services[0]).not.toHaveProperty("fulfillmentSettings")
  })

  it("uses the same source-aware metrics for platform inventory", async () => {
    const prisma = {
      marketplaceListing: {
        findUnique: jest.fn().mockResolvedValue(listing("PLATFORM")),
      },
    }
    const service = new MarketplaceService(prisma as any, {} as any)

    const result = await service.getListingForStaff("example-listing", {
      id: "ops-1",
      staffRole: "OPERATIONS",
    })

    expect(result.domainMetrics).toEqual(
      expect.objectContaining({
        ahrefs: expect.objectContaining({
          domainRating: expect.objectContaining({ value: 61 }),
        }),
        moz: {
          domainAuthority: expect.objectContaining({
            value: 48,
            source: "STAFF_MANUAL",
          }),
        },
      }),
    )
    expect(result.publisher).toBeNull()
    expect(result.access.canManageServices).toBe(true)
  })
})
