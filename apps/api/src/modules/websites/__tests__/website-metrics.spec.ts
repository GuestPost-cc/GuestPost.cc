import {
  WebsiteMetricKey,
  WebsiteMetricProvider,
  WebsiteMetricSource,
} from "@guestpost/database"
import { ForbiddenException } from "@nestjs/common"
import {
  assertManualMetricValues,
  assertMeasurementDate,
  manualMetricFreshAfter,
  serializeMarketplaceDomainMetrics,
  serializePublicMarketplaceDomainMetrics,
  upsertWebsiteMetric,
  WebsiteMetricsService,
} from "../website-metrics.service"

describe("marketplace metric serializers", () => {
  const measuredAt = new Date("2026-07-22T00:00:00Z")
  const collectedAt = new Date("2026-07-22T01:00:00Z")

  it("preserves manual provenance internally while hiding it from customers", () => {
    const manualMetric = {
      key: WebsiteMetricKey.AHREFS_ORGANIC_TRAFFIC,
      provider: WebsiteMetricProvider.AHREFS,
      source: WebsiteMetricSource.PUBLISHER_MANUAL,
      status: "CURRENT",
      value: 1200,
      measuredAt,
      collectedAt,
      expiresAt: null,
    }

    expect(
      serializeMarketplaceDomainMetrics([manualMetric])?.ahrefs.organicTraffic,
    ).toEqual(
      expect.objectContaining({ value: 1200, source: "PUBLISHER_MANUAL" }),
    )
    expect(
      serializePublicMarketplaceDomainMetrics([manualMetric]),
    ).toBeUndefined()
  })

  it("returns only display-safe fields for an authoritative provider metric", () => {
    const projected = serializePublicMarketplaceDomainMetrics([
      {
        key: WebsiteMetricKey.AHREFS_DOMAIN_RATING,
        provider: WebsiteMetricProvider.AHREFS,
        source: WebsiteMetricSource.AHREFS_FREE_API,
        status: "CURRENT",
        value: 73,
        measuredAt,
        collectedAt,
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        enteredByUserId: "internal-user",
        importBatchId: "internal-batch",
      },
    ])

    expect(projected?.ahrefs.domainRating).toEqual({
      value: 73,
      source: "AHREFS_FREE_API",
      status: "CURRENT",
      measuredAt: measuredAt.toISOString(),
      collectedAt: collectedAt.toISOString(),
    })
    expect(JSON.stringify(projected)).not.toMatch(
      /expiresAt|enteredByUserId|importBatchId|internal-/,
    )
  })

  it.each([
    ["out-of-range value", { value: 101 }],
    ["invalid expiration", { expiresAt: "not-a-date" }],
    ["invalid measurement date", { measuredAt: "not-a-date" }],
    [
      "expiration at the projection boundary",
      { expiresAt: new Date("2026-08-21T00:00:00Z") },
    ],
  ])("fails closed for an authoritative metric with %s", (_label, patch) => {
    const projected = serializePublicMarketplaceDomainMetrics(
      [
        {
          key: WebsiteMetricKey.AHREFS_DOMAIN_RATING,
          provider: WebsiteMetricProvider.AHREFS,
          source: WebsiteMetricSource.AHREFS_FREE_API,
          status: "CURRENT",
          value: 73,
          measuredAt,
          collectedAt,
          expiresAt: new Date("2099-01-01T00:00:00Z"),
          ...patch,
        },
      ],
      new Date("2026-08-21T00:00:00Z"),
    )

    expect(projected).toBeUndefined()
  })
})

describe("manual metric validation", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-22T12:00:00.000Z"))
  })

  afterEach(() => jest.useRealTimers())

  it("accepts real current dates and uses a calendar-day freshness boundary", () => {
    expect(
      assertMeasurementDate("2026-07-22", "measuredAt", {
        requireFresh: true,
      }).toISOString(),
    ).toBe("2026-07-22T00:00:00.000Z")
    expect(manualMetricFreshAfter().toISOString()).toBe(
      "2026-04-23T00:00:00.000Z",
    )
  })

  it.each([
    "2026-02-30",
    "2026-7-2",
    "not-a-date",
  ])("rejects invalid metric date %s", (value) => {
    expect(() => assertMeasurementDate(value, "measuredAt")).toThrow()
  })

  it("rejects future or stale dates when fresh input is required", () => {
    expect(() =>
      assertMeasurementDate("2026-07-23", "measuredAt", {
        requireFresh: true,
      }),
    ).toThrow()
    expect(() =>
      assertMeasurementDate("2026-04-22", "measuredAt", {
        requireFresh: true,
      }),
    ).toThrow()
  })

  it("rejects unsafe or out-of-range manual values defensively", () => {
    expect(() =>
      assertManualMetricValues({
        ahrefsOrganicTraffic: Number.NaN,
        mozDomainAuthority: 50,
      }),
    ).toThrow()
    expect(() =>
      assertManualMetricValues({
        ahrefsOrganicTraffic: 100,
        mozDomainAuthority: 101,
      }),
    ).toThrow()
  })
})

describe("upsertWebsiteMetric", () => {
  it("retains a forensic revision before replacing the current value", async () => {
    const current = {
      id: "metric-1",
      websiteId: "website-1",
      key: WebsiteMetricKey.AHREFS_ORGANIC_TRAFFIC,
      provider: WebsiteMetricProvider.AHREFS,
      source: WebsiteMetricSource.ADMIN_IMPORT,
      status: "CURRENT",
      value: 100,
      measuredAt: new Date("2026-07-01T00:00:00Z"),
      collectedAt: new Date("2026-07-01T01:00:00Z"),
      expiresAt: new Date("2026-09-29T00:00:00Z"),
      enteredByUserId: "admin-1",
      importBatchId: "batch-1",
    }
    const tx = {
      websiteMetric: {
        findUnique: jest.fn().mockResolvedValue(current),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn(),
      },
      websiteMetricRevision: { create: jest.fn().mockResolvedValue({}) },
    }

    await upsertWebsiteMetric(tx, {
      websiteId: "website-1",
      key: WebsiteMetricKey.AHREFS_ORGANIC_TRAFFIC,
      provider: WebsiteMetricProvider.AHREFS,
      source: WebsiteMetricSource.PUBLISHER_MANUAL,
      value: 250,
      measuredAt: new Date("2026-07-22T00:00:00Z"),
      enteredByUserId: "publisher-owner-1",
    })

    expect(tx.websiteMetricRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metricId: "metric-1",
        value: 100,
        source: WebsiteMetricSource.ADMIN_IMPORT,
        importBatchId: "batch-1",
      }),
    })
    expect(tx.websiteMetric.update).toHaveBeenCalledWith({
      where: { id: "metric-1" },
      data: expect.objectContaining({
        value: 250,
        source: WebsiteMetricSource.PUBLISHER_MANUAL,
        enteredByUserId: "publisher-owner-1",
      }),
    })
  })
})

describe("WebsiteMetricsService", () => {
  it("rejects a website from a different publisher organization", async () => {
    const prisma = {
      website: {
        findFirst: jest.fn().mockResolvedValue({
          id: "website-1",
          publisher: { organizationId: "other-org" },
        }),
      },
    }
    const service = new WebsiteMetricsService(prisma as any, {} as any)

    await expect(
      service.updatePublisherManualMetrics(
        "publisher-1",
        "active-org",
        "website-1",
        {
          ahrefsOrganicTraffic: 100,
          ahrefsTrafficAsOf: "2026-07-22",
          mozDomainAuthority: 50,
          mozDomainAuthorityAsOf: "2026-07-22",
        },
        { id: "user-1" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("writes both required metrics, compatibility values, and audit atomically", async () => {
    const tx = {
      websiteMetric: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      websiteMetricRevision: { create: jest.fn() },
      marketplaceListing: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const prisma = {
      website: {
        findFirst: jest.fn().mockResolvedValue({
          id: "website-1",
          publisher: { organizationId: "org-1" },
        }),
      },
      websiteMetric: {
        findMany: jest.fn().mockResolvedValue([
          {
            key: WebsiteMetricKey.AHREFS_ORGANIC_TRAFFIC,
            value: 1200,
            source: WebsiteMetricSource.PUBLISHER_MANUAL,
            status: "CURRENT",
            measuredAt: new Date("2026-07-22T00:00:00Z"),
            collectedAt: new Date("2026-07-22T01:00:00Z"),
            expiresAt: new Date("2026-10-20T00:00:00Z"),
          },
        ]),
      },
      $transaction: jest.fn(async (callback) => callback(tx)),
    }
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const service = new WebsiteMetricsService(prisma as any, audit as any)

    await service.updatePublisherManualMetrics(
      "publisher-1",
      "org-1",
      "website-1",
      {
        ahrefsOrganicTraffic: 1200,
        ahrefsTrafficAsOf: "2026-07-22",
        mozDomainAuthority: 54,
        mozDomainAuthorityAsOf: "2026-07-22",
      },
      { id: "user-1" },
    )

    expect(tx.websiteMetric.create).toHaveBeenCalledTimes(2)
    expect(tx.marketplaceListing.updateMany).toHaveBeenCalledWith({
      where: { websiteId: "website-1" },
      data: { domainAuthority: 54, traffic: 1200 },
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBSITE_MANUAL_METRICS_UPDATED",
        entityId: "website-1",
      }),
      tx,
    )
  })
})
