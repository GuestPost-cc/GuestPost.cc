export type WebsiteMetricSourceDisclosure = {
  label: string
  shortLabel: string
  detail: string
  independentlyVerified: boolean
}

const UNVERIFIED_SUFFIX = "not independently verified"

/**
 * Sources whose values were collected directly from the named provider and
 * may be used for marketplace filters, sorting, and ranking. Keep this as an
 * explicit allowlist: deriving the policy by excluding known manual sources
 * would silently admit a future enum value before its provenance is reviewed.
 */
export const MARKETPLACE_AUTHORITATIVE_METRIC_SOURCES = Object.freeze([
  "AHREFS_FREE_API",
  "AHREFS_PAID_API",
  "MOZ_PAID_API",
  "OPEN_PAGE_RANK_API",
] as const)

export type MarketplaceAuthoritativeMetricSource =
  (typeof MARKETPLACE_AUTHORITATIVE_METRIC_SOURCES)[number]

/**
 * Filtering, sorting, and recommendations use the authoritative provider-only
 * trust boundary. Public display has a separate, broader allowlist for current
 * publisher- and staff-supplied values, without exposing their provenance.
 */
export const MARKETPLACE_ALGORITHMIC_METRIC_SOURCES =
  MARKETPLACE_AUTHORITATIVE_METRIC_SOURCES

export type MarketplaceAlgorithmicMetricSource =
  (typeof MARKETPLACE_ALGORITHMIC_METRIC_SOURCES)[number]

const MARKETPLACE_AUTHORITATIVE_METRIC_SOURCE_SET = new Set<string>(
  MARKETPLACE_AUTHORITATIVE_METRIC_SOURCES,
)

export function isMarketplaceAuthoritativeMetricSource(
  source: unknown,
): source is MarketplaceAuthoritativeMetricSource {
  return (
    typeof source === "string" &&
    MARKETPLACE_AUTHORITATIVE_METRIC_SOURCE_SET.has(source)
  )
}

export function isMarketplaceAlgorithmicMetricSource(
  source: unknown,
): source is MarketplaceAlgorithmicMetricSource {
  return isMarketplaceAuthoritativeMetricSource(source)
}

type MarketplaceMetricIdentity = {
  key?: unknown
  provider?: unknown
  source?: unknown
}

type MarketplaceAuthoritativeMetricRule = Readonly<{
  provider: string
  sources: readonly MarketplaceAuthoritativeMetricSource[]
}>

const MARKETPLACE_AUTHORITATIVE_METRIC_RULES: Readonly<
  Record<string, MarketplaceAuthoritativeMetricRule>
> = Object.freeze({
  AHREFS_DOMAIN_RATING: Object.freeze({
    provider: "AHREFS",
    sources: Object.freeze(["AHREFS_FREE_API", "AHREFS_PAID_API"] as const),
  }),
  AHREFS_ORGANIC_TRAFFIC: Object.freeze({
    provider: "AHREFS",
    sources: Object.freeze(["AHREFS_PAID_API"] as const),
  }),
  MOZ_DOMAIN_AUTHORITY: Object.freeze({
    provider: "MOZ",
    sources: Object.freeze(["MOZ_PAID_API"] as const),
  }),
  OPEN_PAGE_RANK: Object.freeze({
    provider: "OPEN_PAGE_RANK",
    sources: Object.freeze(["OPEN_PAGE_RANK_API"] as const),
  }),
  OPEN_PAGE_RANK_GLOBAL_RANK: Object.freeze({
    provider: "OPEN_PAGE_RANK",
    sources: Object.freeze(["OPEN_PAGE_RANK_API"] as const),
  }),
  OPEN_PAGE_RANK_REFERRING_DOMAINS: Object.freeze({
    provider: "OPEN_PAGE_RANK",
    sources: Object.freeze(["OPEN_PAGE_RANK_API"] as const),
  }),
})

/**
 * Returns the reviewed sources for one exact metric/provider pair. An empty
 * result is the fail-closed answer for unknown keys and mismatched providers.
 */
export function marketplaceAuthoritativeMetricSourcesFor(
  key: unknown,
  provider: unknown,
): readonly MarketplaceAuthoritativeMetricSource[] {
  if (typeof key !== "string") return []
  const rule = MARKETPLACE_AUTHORITATIVE_METRIC_RULES[key]
  return rule && rule.provider === provider ? rule.sources : []
}

/**
 * Checks the full key/provider/source identity. A source label alone is not
 * sufficient: for example, Ahrefs' free endpoint currently authorizes Domain
 * Rating only and must not make an organic-traffic row authoritative.
 */
export function isMarketplaceAuthoritativeMetric<
  T extends MarketplaceMetricIdentity,
>(
  metric: T,
): metric is T & {
  source: MarketplaceAuthoritativeMetricSource
} {
  return marketplaceAuthoritativeMetricSourcesFor(
    metric.key,
    metric.provider,
  ).includes(metric.source as MarketplaceAuthoritativeMetricSource)
}

/**
 * Sources allowed in the customer-facing metric projection. Manual values are
 * displayable when they use a known metric/provider identity, but remain
 * excluded from algorithmic filters and ranking because they are not
 * independently collected by the platform.
 */
export function isMarketplacePublicMetric<T extends MarketplaceMetricIdentity>(
  metric: T,
): boolean {
  if (isMarketplaceAuthoritativeMetric(metric)) return true
  if (
    metric.source !== "PUBLISHER_MANUAL" &&
    metric.source !== "STAFF_MANUAL"
  ) {
    return false
  }
  return (
    marketplaceAuthoritativeMetricSourcesFor(metric.key, metric.provider)
      .length > 0
  )
}

/**
 * Converts the persisted metric source into buyer-safe provenance language.
 * Unknown sources fail closed as unverified so a future enum value cannot be
 * presented as provider-collected until its semantics are reviewed.
 */
export function websiteMetricSourceDisclosure(
  source: string | null | undefined,
): WebsiteMetricSourceDisclosure {
  switch (source) {
    case "AHREFS_FREE_API":
    case "AHREFS_PAID_API":
      return {
        label: "Collected from the Ahrefs API",
        shortLabel: "Ahrefs API",
        detail: "Collected directly from Ahrefs by GuestPost.cc.",
        independentlyVerified: true,
      }
    case "MOZ_PAID_API":
      return {
        label: "Collected from the Moz API",
        shortLabel: "Moz API",
        detail: "Collected directly from Moz by GuestPost.cc.",
        independentlyVerified: true,
      }
    case "OPEN_PAGE_RANK_API":
      return {
        label: "Collected from the Open PageRank API",
        shortLabel: "Open PageRank API",
        detail: "Collected directly from Open PageRank by GuestPost.cc.",
        independentlyVerified: true,
      }
    case "PUBLISHER_MANUAL":
      return {
        label: `Publisher Reported; ${UNVERIFIED_SUFFIX}`,
        shortLabel: "Publisher Reported",
        detail:
          "Entered by the publisher from its own account or records; GuestPost.cc has not independently verified the value.",
        independentlyVerified: false,
      }
    case "STAFF_MANUAL":
      return {
        label: `Staff-entered; ${UNVERIFIED_SUFFIX}`,
        shortLabel: "Staff-entered",
        detail:
          "Entered by platform staff from supplied evidence; the provider did not deliver the value directly to GuestPost.cc.",
        independentlyVerified: false,
      }
    case "ADMIN_IMPORT":
      return {
        label: `Imported value; ${UNVERIFIED_SUFFIX}`,
        shortLabel: "Imported",
        detail:
          "Imported from supplied inventory data; GuestPost.cc has not independently verified the value with the provider.",
        independentlyVerified: false,
      }
    default:
      return {
        label: `Source unavailable; ${UNVERIFIED_SUFFIX}`,
        shortLabel: "Source unavailable",
        detail:
          "The metric source is unavailable and the value must not be treated as independently verified.",
        independentlyVerified: false,
      }
  }
}
