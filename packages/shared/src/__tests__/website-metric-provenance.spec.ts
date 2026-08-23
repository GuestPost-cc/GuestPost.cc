import {
  isMarketplaceAlgorithmicMetricSource,
  isMarketplaceAuthoritativeMetric,
  isMarketplaceAuthoritativeMetricSource,
  isMarketplacePublicMetric,
  MARKETPLACE_ALGORITHMIC_METRIC_SOURCES,
  MARKETPLACE_AUTHORITATIVE_METRIC_SOURCES,
  marketplaceAuthoritativeMetricSourcesFor,
  websiteMetricSourceDisclosure,
} from "../website-metric-provenance"

describe("websiteMetricSourceDisclosure", () => {
  it.each([
    ["AHREFS_FREE_API", "Ahrefs API"],
    ["AHREFS_PAID_API", "Ahrefs API"],
    ["MOZ_PAID_API", "Moz API"],
    ["OPEN_PAGE_RANK_API", "Open PageRank API"],
  ])("classifies %s as provider-collected", (source, shortLabel) => {
    expect(websiteMetricSourceDisclosure(source)).toEqual(
      expect.objectContaining({
        independentlyVerified: true,
        shortLabel,
      }),
    )
  })

  it.each([
    ["PUBLISHER_MANUAL", "Publisher Reported"],
    ["STAFF_MANUAL", "Staff-entered"],
    ["ADMIN_IMPORT", "Imported"],
  ])("labels %s as not independently verified", (source, shortLabel) => {
    const disclosure = websiteMetricSourceDisclosure(source)
    expect(disclosure).toEqual(
      expect.objectContaining({ independentlyVerified: false, shortLabel }),
    )
    expect(disclosure.label).toContain("not independently verified")
  })

  it.each([
    undefined,
    null,
    "FUTURE_UNREVIEWED_SOURCE",
  ])("fails closed for an unavailable or unknown source", (source) => {
    expect(websiteMetricSourceDisclosure(source)).toEqual(
      expect.objectContaining({
        independentlyVerified: false,
        shortLabel: "Source unavailable",
      }),
    )
  })
})

describe("marketplace algorithmic metric source policy", () => {
  it.each(
    MARKETPLACE_ALGORITHMIC_METRIC_SOURCES,
  )("allows the explicitly reviewed %s source", (source) => {
    expect(isMarketplaceAlgorithmicMetricSource(source)).toBe(true)
  })

  it.each([
    "PUBLISHER_MANUAL",
    "STAFF_MANUAL",
    "ADMIN_IMPORT",
    "FUTURE_UNREVIEWED_SOURCE",
    null,
    undefined,
  ])("fails closed for %s", (source) => {
    expect(isMarketplaceAlgorithmicMetricSource(source)).toBe(false)
  })
})

describe("marketplace metric source policies", () => {
  it.each(
    MARKETPLACE_AUTHORITATIVE_METRIC_SOURCES,
  )("recognizes direct provider source %s", (source) => {
    expect(isMarketplaceAuthoritativeMetricSource(source)).toBe(true)
  })

  it.each([
    {
      key: "AHREFS_DOMAIN_RATING",
      provider: "AHREFS",
      source: "AHREFS_FREE_API",
    },
    {
      key: "AHREFS_DOMAIN_RATING",
      provider: "AHREFS",
      source: "AHREFS_PAID_API",
    },
    {
      key: "AHREFS_ORGANIC_TRAFFIC",
      provider: "AHREFS",
      source: "AHREFS_PAID_API",
    },
    {
      key: "MOZ_DOMAIN_AUTHORITY",
      provider: "MOZ",
      source: "MOZ_PAID_API",
    },
    {
      key: "OPEN_PAGE_RANK_REFERRING_DOMAINS",
      provider: "OPEN_PAGE_RANK",
      source: "OPEN_PAGE_RANK_API",
    },
  ])("accepts reviewed identity $key/$provider/$source", (metric) => {
    expect(isMarketplaceAuthoritativeMetric(metric)).toBe(true)
  })

  it.each([
    {
      key: "AHREFS_ORGANIC_TRAFFIC",
      provider: "AHREFS",
      source: "AHREFS_FREE_API",
    },
    {
      key: "AHREFS_DOMAIN_RATING",
      provider: "MOZ",
      source: "AHREFS_FREE_API",
    },
    {
      key: "MOZ_DOMAIN_AUTHORITY",
      provider: "MOZ",
      source: "PUBLISHER_MANUAL",
    },
    {
      key: "FUTURE_METRIC",
      provider: "AHREFS",
      source: "AHREFS_PAID_API",
    },
  ])("rejects unreviewed identity $key/$provider/$source", (metric) => {
    expect(isMarketplaceAuthoritativeMetric(metric)).toBe(false)
  })

  it("returns no sources for a mismatched provider", () => {
    expect(
      marketplaceAuthoritativeMetricSourcesFor(
        "MOZ_DOMAIN_AUTHORITY",
        "AHREFS",
      ),
    ).toEqual([])
  })

  it.each([
    {
      key: "AHREFS_ORGANIC_TRAFFIC",
      provider: "AHREFS",
      source: "PUBLISHER_MANUAL",
    },
    {
      key: "MOZ_DOMAIN_AUTHORITY",
      provider: "MOZ",
      source: "STAFF_MANUAL",
    },
  ])("allows known manual values for public display without making them authoritative", (metric) => {
    expect(isMarketplacePublicMetric(metric)).toBe(true)
    expect(isMarketplaceAuthoritativeMetric(metric)).toBe(false)
  })

  it("rejects imported values from the public display policy", () => {
    expect(
      isMarketplacePublicMetric({
        key: "AHREFS_ORGANIC_TRAFFIC",
        provider: "AHREFS",
        source: "ADMIN_IMPORT",
      }),
    ).toBe(false)
  })
})
