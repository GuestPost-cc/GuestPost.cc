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

  it("shows only the Google provider with an active successful link", () => {
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

    expect(result.siteMetrics).toEqual({
      periodDays: 30,
      gsc: { clicks: 12, impressions: 345 },
      ga4: undefined,
    })
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
