import { MarketplaceService } from "../marketplace.service"

const listing = (website: any, ownerType = "PUBLISHER") => ({
  id: "listing-1",
  title: "Example publishing",
  status: "APPROVED",
  ownerType,
  publisherId: "publisher-1",
  organizationId: "organization-1",
  publisher: {
    id: "publisher-1",
    name: "Example Publisher",
    email: "internal-publisher@example.com",
    tier: "VERIFIED",
    organizationId: "internal-publisher-organization",
    profile: {
      rating: 4.8,
      totalReviews: 12,
      responseTime: 6,
      completionRate: 99.5,
      trustScore: 97,
    },
  },
  services: [],
  categories: [],
  website,
  semrushData: { secretSemrush: 123 },
  metricsData: { source: "GSC", clicks: 12, impressions: 345 },
  trafficData: { source: "GA4", sessions: 67, users: 45, pageviews: 89 },
  domainRating: 91,
  domainAuthority: 92,
  referringDomains: 93,
  spamScore: 94,
  activeModerationAction: "PAUSE",
  activeModerationAuthority: "OPERATIONS",
  activeModerationReasonCode: "POLICY_VIOLATION",
  activeModerationMessage: "customer-must-not-see",
  activeModerationPreviousStatus: "APPROVED",
  moderationResubmissionAllowed: false,
  moderationVersion: 7,
  moderationEvents: [{ internal: true }],
  reviews: [
    {
      id: "review-1",
      listingId: "listing-1",
      userId: "internal-review-user",
      rating: 5,
      title: "Great",
      content: "A useful placement.",
      status: "APPROVED",
      createdAt: new Date("2026-07-20T00:00:00Z"),
      user: {
        id: "internal-review-user",
        email: "reviewer@example.com",
        name: "Reviewer",
        image: null,
      },
    },
  ],
})

const metric = {
  key: "AHREFS_DOMAIN_RATING",
  provider: "AHREFS",
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

  it.each([
    "PUBLISHER",
    "PLATFORM",
  ])("projects a current, unexpired direct-provider metric for %s-owned listings", (ownerType) => {
    const result = project(
      listing(
        {
          verificationStatus: "VERIFIED",
          metricsHistory: [metric],
          websiteIntegrations: [],
        },
        ownerType,
      ),
    )

    expect(result.domainMetrics.ahrefs.domainRating).toEqual(
      expect.objectContaining({
        value: 73.5,
        status: "CURRENT",
      }),
    )
    expect(result.domainMetrics.ahrefs.domainRating).not.toHaveProperty(
      "source",
    )
    expect(JSON.stringify(result)).not.toContain("must-not-leak")
    expect(result.domainRating).toBeUndefined()
    expect(result.semrushData).toBeUndefined()
    expect(result.domainAuthority).toBeUndefined()
    expect(result.referringDomains).toBeUndefined()
    expect(result.spamScore).toBeUndefined()
    expect(result.activeModerationAction).toBeUndefined()
    expect(result.activeModerationAuthority).toBeUndefined()
    expect(result.activeModerationReasonCode).toBeUndefined()
    expect(result.activeModerationMessage).toBeUndefined()
    expect(result.activeModerationPreviousStatus).toBeUndefined()
    expect(result.moderationResubmissionAllowed).toBeUndefined()
    expect(result.moderationVersion).toBeUndefined()
    expect(result.moderationEvents).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain("customer-must-not-see")
    expect(JSON.stringify(result)).not.toMatch(
      /internal-publisher@example\.com|internal-publisher-organization|internal-review-user|reviewer@example\.com/,
    )
    expect(result.publisher).toEqual(
      ownerType === "PLATFORM"
        ? null
        : {
            id: "publisher-1",
            name: "Example Publisher",
            profile: { rating: 4.8, totalReviews: 12, responseTime: 6 },
          },
    )
    expect(result.reviews[0]).toEqual({
      id: "review-1",
      rating: 5,
      title: "Great",
      content: "A useful placement.",
      createdAt: new Date("2026-07-20T00:00:00Z"),
      user: { name: "Reviewer", image: null },
    })
  })

  it.each([
    "PUBLISHER",
    "PLATFORM",
  ])("projects publisher/staff metrics without provenance for %s-owned listings", (ownerType) => {
    const result = project(
      listing(
        {
          verificationStatus: "VERIFIED",
          metricsHistory: [
            ...[
              {
                key: "MOZ_DOMAIN_AUTHORITY",
                provider: "MOZ",
                source: "PUBLISHER_MANUAL",
              },
              {
                key: "AHREFS_DOMAIN_RATING",
                provider: "AHREFS",
                source: "STAFF_MANUAL",
              },
              {
                key: "OPEN_PAGE_RANK",
                provider: "OPEN_PAGE_RANK",
                source: "ADMIN_IMPORT",
              },
            ].map((identity, index) => ({
              ...identity,
              status: "CURRENT",
              value: String(64 + index),
              measuredAt: new Date("2026-07-20T00:00:00Z"),
              collectedAt: new Date("2026-07-20T01:00:00Z"),
              expiresAt: null,
            })),
          ],
          websiteIntegrations: [],
        },
        ownerType,
      ),
    )

    expect(result.domainMetrics).toEqual(
      expect.objectContaining({
        ahrefs: expect.objectContaining({
          domainRating: expect.objectContaining({ value: 65 }),
        }),
      }),
    )
    expect(result.domainMetrics.moz.domainAuthority).toEqual(
      expect.objectContaining({ value: 64 }),
    )
    expect(result.domainMetrics.openPageRank.pageRank).toBeUndefined()
    expect(result.domainMetrics.ahrefs.domainRating).not.toHaveProperty(
      "source",
    )
    expect(result.domainMetrics.moz.domainAuthority).not.toHaveProperty(
      "source",
    )
    expect(JSON.stringify(result)).not.toMatch(/PUBLISHER_MANUAL|STAFF_MANUAL/)
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
    expect(publisherReported.domainMetrics?.ahrefs.organicTraffic).toEqual(
      expect.objectContaining({ value: 12_345 }),
    )
    expect(
      publisherReported.domainMetrics?.ahrefs.organicTraffic,
    ).not.toHaveProperty("source")
    expect(current.traffic).toBe(12_345)
    expect(current.domainMetrics.ahrefs.organicTraffic).toEqual(
      expect.objectContaining({
        value: 12_345,
        status: "CURRENT",
      }),
    )
    expect(expired.traffic).toBeNull()
    expect(expired.domainMetrics).toBeUndefined()
    expect(futureUnreviewed.traffic).toBeNull()
    expect(futureUnreviewed.domainMetrics).toBeUndefined()
  })

  it.each([
    {
      label: "stale",
      key: "AHREFS_DOMAIN_RATING",
      provider: "AHREFS",
      source: "AHREFS_FREE_API",
      status: "STALE",
      expiresAt: null,
    },
    {
      label: "unavailable",
      key: "MOZ_DOMAIN_AUTHORITY",
      provider: "MOZ",
      source: "MOZ_PAID_API",
      status: "UNAVAILABLE",
      expiresAt: null,
    },
    {
      label: "expired",
      key: "OPEN_PAGE_RANK",
      provider: "OPEN_PAGE_RANK",
      source: "OPEN_PAGE_RANK_API",
      status: "CURRENT",
      expiresAt: new Date("2000-01-01T00:00:00Z"),
    },
    {
      label: "wrong provider",
      key: "MOZ_DOMAIN_AUTHORITY",
      provider: "AHREFS",
      source: "MOZ_PAID_API",
      status: "CURRENT",
      expiresAt: null,
    },
    {
      label: "unreviewed source/key pair",
      key: "AHREFS_ORGANIC_TRAFFIC",
      provider: "AHREFS",
      source: "AHREFS_FREE_API",
      status: "CURRENT",
      expiresAt: null,
    },
  ])("fails closed for a $label metric", (candidate) => {
    const result = project(
      listing({
        verificationStatus: "VERIFIED",
        metricsHistory: [
          {
            ...candidate,
            value: "5",
            measuredAt: new Date("2026-07-20T00:00:00Z"),
            collectedAt: new Date("2026-07-20T01:00:00Z"),
          },
        ],
        websiteIntegrations: [],
      }),
    )

    expect(result.domainMetrics).toBeUndefined()
    expect(result.traffic).toBeNull()
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
    tags: [
      {
        tag: {
          id: "tag-1",
          name: "Safe tag",
          slug: "safe-tag",
          createdAt: new Date("2026-08-01T00:00:00Z"),
          internalLabel: "customer-must-not-see-tag-field",
        },
      },
    ],
    semrushData: { authorityScore: 97 },
    metricsData: { source: "GSC", clicks: 999 },
    trafficData: { source: "GA4", sessions: 888 },
    traffic: 777,
    domainRating: 91,
    domainAuthority: 92,
    referringDomains: 93,
    spamScore: 94,
    activeModerationAction: "SUSPEND",
    activeModerationAuthority: "ADMIN",
    activeModerationReasonCode: "POLICY_VIOLATION",
    activeModerationMessage: "customer-must-not-see",
    activeModerationPreviousStatus: "APPROVED",
    moderationResubmissionAllowed: false,
    moderationVersion: 7,
    moderationEvents: [{ internal: true }],
    websiteUrl: "https://secret.example",
    sampleUrl: "https://secret.example/sample",
    signupUrl: "https://secret.example/signup",
    organizationId: "organization-secret",
    publisherId: "publisher-secret",
    services: [
      {
        id: "service-1",
        listingId: "listing-unsafe",
        serviceType: "GUEST_POST",
        price: 100,
        currency: "USD",
        turnaroundDays: 7,
        revisionRounds: 2,
        warrantyDays: 30,
        requirements: null,
        fulfillmentSettings: { internalSlaHours: 2, autoAccept: true },
        availability: "AVAILABLE",
        version: 3,
      },
    ],
  }

  function expectQuarantined(value: any) {
    expect(value.metricsData).toBeUndefined()
    expect(value.trafficData).toBeUndefined()
    expect(value.semrushData).toBeUndefined()
    expect(value.siteMetrics).toBeUndefined()
    expect(value.traffic).toBeNull()
    expect(value.domainRating).toBeUndefined()
    expect(value.domainAuthority).toBeUndefined()
    expect(value.referringDomains).toBeUndefined()
    expect(value.spamScore).toBeUndefined()
    expect(value.activeModerationAction).toBeUndefined()
    expect(value.activeModerationAuthority).toBeUndefined()
    expect(value.activeModerationReasonCode).toBeUndefined()
    expect(value.activeModerationMessage).toBeUndefined()
    expect(value.activeModerationPreviousStatus).toBeUndefined()
    expect(value.moderationResubmissionAllowed).toBeUndefined()
    expect(value.moderationVersion).toBeUndefined()
    expect(value.moderationEvents).toBeUndefined()
    expect(value.websiteUrl).toBeNull()
    expect(value.sampleUrl).toBeNull()
    expect(value.signupUrl).toBeNull()
    expect(value.organizationId).toBeUndefined()
    expect(value.publisherId).toBeUndefined()
    expect(value.services[0].fulfillmentSettings).toBeUndefined()
    expect(value.services[0].listingId).toBeUndefined()
    expect(value.tags).toEqual([
      { id: "tag-1", name: "Safe tag", slug: "safe-tag" },
    ])
    expect(value.tags[0].createdAt).toBeUndefined()
    expect(value.tags[0].internalLabel).toBeUndefined()
    expect(JSON.stringify(value)).not.toContain("999")
    expect(JSON.stringify(value)).not.toContain("888")
    expect(JSON.stringify(value)).not.toContain("customer-must-not-see")
    expect(JSON.stringify(value)).not.toContain("internalSlaHours")
    expect(JSON.stringify(value)).not.toContain("secret.example")
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
