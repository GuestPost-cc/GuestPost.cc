import type {
  ListingServiceOption,
  MarketplaceListing,
} from "@guestpost/api-client"

export const SERVICE_OPTIONS = [
  {
    value: "GUEST_POST",
    label: "Guest post",
    shortLabel: "Guest post",
    description: "Publish a new article with your link.",
  },
  {
    value: "NICHE_EDIT",
    label: "Niche edit",
    shortLabel: "Niche edit",
    description: "Add your link to an existing relevant article.",
  },
  {
    value: "EDITORIAL_LINK",
    label: "Editorial link",
    shortLabel: "Editorial",
    description: "Earn an editorially placed contextual link.",
  },
  {
    value: "OUTREACH_LINK",
    label: "Outreach link",
    shortLabel: "Outreach",
    description: "Let the fulfillment team handle publisher outreach.",
  },
  {
    value: "LOCAL_CITATION",
    label: "Local citation",
    shortLabel: "Citation",
    description: "Build a consistent local business citation.",
  },
  {
    value: "FOUNDATION_LINK",
    label: "Foundation link",
    shortLabel: "Foundation",
    description: "Strengthen your backlink profile with a foundational link.",
  },
  {
    value: "BLOG_ARTICLE",
    label: "Blog article",
    shortLabel: "Blog article",
    description: "Commission a publish-ready blog article.",
  },
  {
    value: "SEO_CONTENT",
    label: "SEO content",
    shortLabel: "SEO content",
    description: "Order search-focused content for your campaign.",
  },
] as const

const SERVICE_BY_VALUE = new Map(
  SERVICE_OPTIONS.map((option) => [option.value, option]),
)

export function serviceLabel(serviceType: string): string {
  return (
    SERVICE_BY_VALUE.get(
      serviceType as (typeof SERVICE_OPTIONS)[number]["value"],
    )?.label ?? serviceType.replace(/_/g, " ").toLowerCase()
  )
}

export function serviceShortLabel(serviceType: string): string {
  return (
    SERVICE_BY_VALUE.get(
      serviceType as (typeof SERVICE_OPTIONS)[number]["value"],
    )?.shortLabel ?? serviceLabel(serviceType)
  )
}

export function serviceDescription(serviceType: string): string {
  return (
    SERVICE_BY_VALUE.get(
      serviceType as (typeof SERVICE_OPTIONS)[number]["value"],
    )?.description ?? "A campaign-ready placement service."
  )
}

export function formatMoney(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value)
}

export function availableServices(
  listing: Pick<MarketplaceListing, "services">,
): ListingServiceOption[] {
  return (listing.services ?? []).filter(
    (service) => service.availability === "AVAILABLE",
  )
}

export function fastestTurnaround(
  listing: Pick<MarketplaceListing, "services" | "turnaroundDays">,
): number | undefined {
  const days = availableServices(listing).map(
    (service) => service.turnaroundDays,
  )
  return days.length > 0 ? Math.min(...days) : listing.turnaroundDays
}

export function startingPrice(
  listing: Pick<MarketplaceListing, "priceFrom" | "price" | "services">,
): number {
  if (listing.priceFrom != null) return Number(listing.priceFrom)
  const prices = availableServices(listing).map((service) => service.price)
  if (prices.length > 0) return Math.min(...prices)
  return Number(listing.price ?? 0)
}

export function listingImage(listing: MarketplaceListing): string | null {
  return (
    listing.image ??
    listing.images?.find((image) => image.isPrimary)?.url ??
    listing.images?.[0]?.url ??
    null
  )
}

export function displayWebsiteHost(url?: string): string {
  if (!url) return "Website URL unavailable"
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
  }
}

export function fulfillmentLabel(listing: MarketplaceListing): string {
  if (
    listing.ownerType === "PLATFORM" ||
    listing.fulfillmentType === "INTERNAL"
  ) {
    return "Platform managed"
  }
  return "Publisher managed"
}

export function fulfillmentBadgeClass(listing: MarketplaceListing): string {
  if (
    listing.ownerType === "PLATFORM" ||
    listing.fulfillmentType === "INTERNAL"
  ) {
    return "border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-50 dark:border-purple-900 dark:bg-purple-950/60 dark:text-purple-300"
  }
  return "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300"
}

export function visiblePaginationPages(
  current: number,
  total: number,
): Array<number | "ellipsis"> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)

  const pages = new Set([1, total, current - 1, current, current + 1])
  const normalized = [...pages]
    .filter((page) => page >= 1 && page <= total)
    .sort((a, b) => a - b)
  const result: Array<number | "ellipsis"> = []

  for (const page of normalized) {
    const previous = result.at(-1)
    if (typeof previous === "number" && page - previous > 1) {
      result.push("ellipsis")
    }
    result.push(page)
  }
  return result
}
