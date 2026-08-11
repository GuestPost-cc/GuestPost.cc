export type WebsiteMetricSourceDisclosure = {
  label: string
  shortLabel: string
  detail: string
  independentlyVerified: boolean
}

const UNVERIFIED_SUFFIX = "not independently verified"

/**
 * Sources that may contribute a metric to marketplace filtering, sorting, or
 * recommendations. Keep this as an explicit, reviewed allowlist: deriving the
 * policy by excluding one known-bad source would silently admit a future enum
 * value before its collection and trust semantics have been reviewed.
 *
 * Provider/key checks remain mandatory at each algorithm call site. This list
 * only answers whether the source class itself is eligible.
 */
export const MARKETPLACE_ALGORITHMIC_METRIC_SOURCES = Object.freeze([
  "AHREFS_FREE_API",
  "AHREFS_PAID_API",
  "MOZ_PAID_API",
  "OPEN_PAGE_RANK_API",
  "STAFF_MANUAL",
  "ADMIN_IMPORT",
] as const)

export type MarketplaceAlgorithmicMetricSource =
  (typeof MARKETPLACE_ALGORITHMIC_METRIC_SOURCES)[number]

const MARKETPLACE_ALGORITHMIC_METRIC_SOURCE_SET = new Set<string>(
  MARKETPLACE_ALGORITHMIC_METRIC_SOURCES,
)

export function isMarketplaceAlgorithmicMetricSource(
  source: unknown,
): source is MarketplaceAlgorithmicMetricSource {
  return (
    typeof source === "string" &&
    MARKETPLACE_ALGORITHMIC_METRIC_SOURCE_SET.has(source)
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
