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
  domainRating: 91,
  domainAuthority: 92,
  referringDomains: 93,
  spamScore: 94,
})

const metric = {
  key: "AHREFS_DOMAIN_RATING",
  value: "73.5",
  source: "AHREFS_FREE_API",
  status: "CURRENT",
  measuredAt: new Date("2026-07-20T00:00:00Z"),
  collectedAt: new Date("2026-07-20T01:00:00Z"),
  expiresAt: new Date("2099-08-20T00:00:00Z"),
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
    expect(result.domainRating).toBeUndefined()
    expect(result.domainAuthority).toBeUndefined()
    expect(result.referringDomains).toBeUndefined()
    expect(result.spamScore).toBeUndefined()
  })

  it("keeps publisher-reported Moz DA source-visible without a legacy scalar", () => {
    const result = project(
      listing({
        verificationStatus: "VERIFIED",
        metricsHistory: [
          {
            key: "MOZ_DOMAIN_AUTHORITY",
            provider: "MOZ",
            source: "PUBLISHER_MANUAL",
            status: "CURRENT",
            value: "64",
            measuredAt: new Date("2026-07-20T00:00:00Z"),
            collectedAt: new Date("2026-07-20T01:00:00Z"),
            expiresAt: null,
          },
        ],
        websiteIntegrations: [],
      }),
    )

    expect(result.domainAuthority).toBeUndefined()
    expect(result.domainMetrics.moz.domainAuthority).toEqual(
      expect.objectContaining({ value: 64, source: "PUBLISHER_MANUAL" }),
    )
  })

  it("projects only current, unexpired, provider-sourced Ahrefs traffic", () => {
    const publisherReported = project(
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
    const current = project(
      listing({
        verificationStatus: "VERIFIED",
        metricsHistory: [
          {
            key: "AHREFS_ORGANIC_TRAFFIC",
            provider: "AHREFS",
            source: "AHREFS_PAID_API",
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
            source: "AHREFS_PAID_API",
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
    const futureUnreviewed = project(
      listing({
        verificationStatus: "VERIFIED",
        metricsHistory: [
          {
            key: "AHREFS_ORGANIC_TRAFFIC",
            provider: "AHREFS",
            source: "FUTURE_UNREVIEWED_SOURCE",
            status: "CURRENT",
            value: "54321",
            measuredAt: new Date("2026-07-20T00:00:00Z"),
            collectedAt: new Date("2026-07-20T01:00:00Z"),
            expiresAt: new Date("2099-01-01T00:00:00Z"),
          },
        ],
        websiteIntegrations: [],
      }),
    )

    expect(publisherReported.traffic).toBeNull()
    expect(publisherReported.domainMetrics.ahrefs.organicTraffic).toEqual(
      expect.objectContaining({
        value: 12_345,
        source: "PUBLISHER_MANUAL",
      }),
    )
    expect(current.traffic).toBe(12_345)
    expect(expired.traffic).toBeNull()
    expect(futureUnreviewed.traffic).toBeNull()
    expect(futureUnreviewed.domainMetrics.ahrefs.organicTraffic).toEqual(
      expect.objectContaining({
        value: 54_321,
        source: "FUTURE_UNREVIEWED_SOURCE",
      }),
    )
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
    domainRating: 91,
    domainAuthority: 92,
    referringDomains: 93,
    spamScore: 94,
  }

  function expectQuarantined(value: any) {
    expect(value.metricsData).toBeUndefined()
    expect(value.trafficData).toBeUndefined()
    expect(value.siteMetrics).toBeUndefined()
    expect(value.traffic).toBeNull()
    expect(value.domainRating).toBeUndefined()
    expect(value.domainAuthority).toBeUndefined()
    expect(value.referringDomains).toBeUndefined()
    expect(value.spamScore).toBeUndefined()
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

  it("ignores opaque stored recommendation scores and uses auditable trending facts", async () => {
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
      marketplaceListingView: {
        groupBy: jest.fn().mockResolvedValue([{ listingId: unsafeListing.id }]),
      },
      marketplaceListing: {
        findMany: jest.fn().mockResolvedValue([unsafeListing]),
      },
    }
    const service = new MarketplaceService(prisma as any, {} as any)

    const result = await service.getRecommendations("user-1", {} as any)

    expectQuarantined(result[0])
    expect(prisma.marketplaceRecommendation.findMany).not.toHaveBeenCalled()
  })
})
