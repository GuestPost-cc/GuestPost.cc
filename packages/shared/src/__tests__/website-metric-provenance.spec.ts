import {
  isMarketplaceAlgorithmicMetricSource,
  MARKETPLACE_ALGORITHMIC_METRIC_SOURCES,
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
    "FUTURE_UNREVIEWED_SOURCE",
    null,
    undefined,
  ])("fails closed for %s", (source) => {
    expect(isMarketplaceAlgorithmicMetricSource(source)).toBe(false)
  })
})
