import { MarketplaceService } from "../marketplace.service"

const listing = (website: any) => ({
  id: "listing-1",
  title: "Example publishing",
  status: "APPROVED",
  ownerType: "PUBLISHER",
  publisherId: "publisher-1",
  organizationId: "organization-1",
  publisher: { id: "publisher-1", name: "Example Publisher" },
  services: [],
  categories: [],
  website,
  metricsData: { source: "GSC", clicks: 12, impressions: 345 },
  trafficData: { source: "GA4", sessions: 67, users: 45, pageviews: 89 },
})

const metric = {
  key: "AHREFS_DOMAIN_RATING",
  value: "73.5",
  source: "AHREFS_FREE_API",
  status: "CURRENT",
  measuredAt: new Date("2026-07-20T00:00:00Z"),
  collectedAt: new Date("2026-07-20T01:00:00Z"),
  expiresAt: new Date("2026-08-20T00:00:00Z"),
  enteredByUserId: "must-not-leak",
  importBatchId: "must-not-leak",
}

describe("public marketplace metric visibility", () => {
  const service = new MarketplaceService({} as any, {} as any)
  const project = (value: any) => (service as any).toPublicListing(value)

  it("always projects safe source-aware domain metrics", () => {
    const result = project(
      listing({
        verificationStatus: "VERIFIED",
        metricsHistory: [metric],
        websiteIntegrations: [],
      }),
    )

    expect(result.domainMetrics.ahrefs.domainRating).toEqual(
      expect.objectContaining({
        value: 73.5,
        source: "AHREFS_FREE_API",
        status: "CURRENT",
      }),
    )
    expect(JSON.stringify(result)).not.toContain("must-not-leak")
  })

  it("projects only current, unexpired Ahrefs organic traffic", () => {
    const current = project(
      listing({
        verificationStatus: "VERIFIED",
        metricsHistory: [
          {
            key: "AHREFS_ORGANIC_TRAFFIC",
            provider: "AHREFS",
            source: "PUBLISHER_MANUAL",
            status: "CURRENT",
            value: "12345",
            measuredAt: new Date("2026-07-20T00:00:00Z"),
            collectedAt: new Date("2026-07-20T01:00:00Z"),
            expiresAt: new Date("2099-01-01T00:00:00Z"),
          },
        ],
        websiteIntegrations: [],
      }),
    )
    const expired = project(
      listing({
        verificationStatus: "VERIFIED",
        metricsHistory: [
          {
            key: "AHREFS_ORGANIC_TRAFFIC",
            provider: "AHREFS",
            source: "PUBLISHER_MANUAL",
            status: "CURRENT",
            value: "999999",
            measuredAt: new Date("1999-10-01T00:00:00Z"),
            collectedAt: new Date("1999-10-01T01:00:00Z"),
            expiresAt: new Date("2000-01-01T00:00:00Z"),
          },
        ],
        websiteIntegrations: [],
      }),
    )

    expect(current.traffic).toBe(12_345)
    expect(expired.traffic).toBeNull()
  })

  it("hides legacy Google values when there is no linked synced property", () => {
    const result = project(
      listing({
        verificationStatus: "VERIFIED",
        metricsHistory: [],
        websiteIntegrations: [],
      }),
    )
    expect(result.siteMetrics).toBeUndefined()
  })

  it("hides Google values even when a legacy link appears active and synced", () => {
    const result = project(
      listing({
        verificationStatus: "VERIFIED",
        metricsHistory: [],
        websiteIntegrations: [
          {
            status: "CONNECTED",
            syncedAt: new Date("2026-07-22T00:00:00Z"),
            integration: {
              provider: "GOOGLE_SEARCH_CONSOLE",
              status: "ACTIVE",
            },
          },
          {
            status: "CONNECTED",
            syncedAt: null,
            integration: {
              provider: "GOOGLE_ANALYTICS",
              status: "ACTIVE",
            },
          },
        ],
      }),
    )

    expect(result.siteMetrics).toBeUndefined()
  })

  it.each([
    "DISCONNECTED",
    "ERROR",
    "REAUTH_REQUIRED",
  ])("hides metrics when the parent integration is %s", (status) => {
    const result = project(
      listing({
        verificationStatus: "VERIFIED",
        metricsHistory: [],
        websiteIntegrations: [
          {
            status: "CONNECTED",
            syncedAt: new Date("2026-07-22T00:00:00Z"),
            integration: {
              provider: "GOOGLE_SEARCH_CONSOLE",
              status,
            },
          },
        ],
      }),
    )
    expect(result.siteMetrics).toBeUndefined()
  })
})

describe("Google metric quarantine across lightweight listing endpoints", () => {
  const unsafeListing = {
    id: "listing-unsafe",
    status: "APPROVED",
    fulfillmentType: "INTERNAL",
    featured: false,
    categories: [],
    images: [],
    tags: [],
    metricsData: { source: "GSC", clicks: 999 },
    trafficData: { source: "GA4", sessions: 888 },
    traffic: 777,
  }

  function expectQuarantined(value: any) {
    expect(value.metricsData).toBeUndefined()
    expect(value.trafficData).toBeUndefined()
    expect(value.siteMetrics).toBeUndefined()
    expect(value.traffic).toBeNull()
    expect(JSON.stringify(value)).not.toContain("999")
    expect(JSON.stringify(value)).not.toContain("888")
  }

  it("quarantines internal-service listing projections", async () => {
    const prisma = {
      marketplaceListing: {
        findMany: jest.fn().mockResolvedValue([unsafeListing]),
      },
    }
    const service = new MarketplaceService(prisma as any, {} as any)

    const result = await service.getServices()

    expectQuarantined(result[0])
  })

  it("quarantines saved-list listing projections", async () => {
    const prisma = {
      marketplaceSavedList: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "saved-1",
            items: [{ id: "item-1", listing: unsafeListing }],
          },
        ]),
      },
    }
    const service = new MarketplaceService(prisma as any, {} as any)

    const result = await service.getSavedLists("user-1")

    expectQuarantined(result[0].items[0].listing)
  })

  it("quarantines stored recommendation listing projections", async () => {
    const prisma = {
      marketplaceRecommendation: {
        findMany: jest.fn().mockResolvedValue([
          {
            listingId: unsafeListing.id,
            score: 0.9,
            reason: "similar",
          },
        ]),
      },
      marketplaceListing: {
        findMany: jest.fn().mockResolvedValue([unsafeListing]),
      },
    }
    const service = new MarketplaceService(prisma as any, {} as any)

    const result = await service.getRecommendations("user-1", {} as any)

    expectQuarantined(result[0])
  })
})
