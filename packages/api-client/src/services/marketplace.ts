import type { HttpClient } from "../client"

// A single purchasable service on a listing. The customer's pick locks
// (listingId, listingServiceId) onto the order — service and website cannot
// be re-selected after this point in the flow.
export interface ListingServiceOption {
  id: string
  serviceType: string
  price: number
  currency: string
  turnaroundDays: number
  revisionRounds: number
  warrantyDays?: number | null
  requirements?: Record<string, unknown> | null
  availability: "AVAILABLE" | "PAUSED" | "WAITLIST"
}

export interface ListingAttribution {
  kind: "PUBLISHER" | "PLATFORM"
  label: string
}

export interface MarketplaceListing {
  id: string
  title: string
  slug: string
  description: string
  shortDescription?: string
  // ── Phase 7 deprecation ───────────────────────────────────────────────
  // type / price / turnaroundDays / revisionRounds are LEGACY listing-level
  // columns scheduled for drop. Read priceFrom + services[] instead:
  //   - `priceFrom`        — min price across AVAILABLE services
  //   - `serviceTypes[]`   — deduped list of offered services
  //   - `services[]`       — full per-service rows (price/TAT/availability)
  // The helpers below (resolveDisplayType, resolveDisplayPrice, etc.) wrap
  // the fallback for views that haven't fully migrated yet. Marked optional
  // so the upcoming column drop doesn't break compilation.
  type?: string
  status: string
  // INTERNAL = platform-fulfilled, PUBLISHER = publisher-fulfilled, HYBRID = both
  fulfillmentType: "INTERNAL" | "PUBLISHER" | "HYBRID"
  price?: number
  currency: string
  priceType: string
  minPrice?: number
  maxPrice?: number
  domainRating?: number
  domainAuthority?: number
  traffic?: number
  country?: string
  language?: string
  turnaroundDays?: number
  revisionRounds?: number
  featured: boolean
  verified: boolean
  websiteUrl?: string
  // Fulfillment website — order items must reference this, not the listing id
  websiteId?: string | null
  sampleUrl?: string
  category?: { id: string; name: string; slug: string }
  tags: Array<{ id: string; name: string; slug: string }>
  images: Array<{ url: string; isPrimary: boolean }>
  // pricingTiers removed in Phase 5 — replaced by the per-service price on
  // each ListingService row in `services[]`.
  reviews?: Array<{
    id: string
    rating: number
    title?: string
    content: string
    user: { name?: string; image?: string }
    createdAt: string
  }>
  publisher?: {
    id: string
    name: string
    profile?: { rating?: number; totalReviews?: number; responseTime?: number }
  }
  image?: string
  avgRating?: number
  reviewCount: number
  isFavorited?: boolean
  relatedListings?: MarketplaceListing[]
  // Phase 2 fields. ownerType drives the routing decision at order creation
  // (server-side); attribution is what the UI renders ("Listed by GuestPost.cc"
  // for PLATFORM, publisher name for PUBLISHER). services is the menu of
  // ordered offerings on this listing — undefined on legacy clients.
  ownerType?: "PUBLISHER" | "PLATFORM"
  attribution?: ListingAttribution
  services?: ListingServiceOption[]
  // Phase 6 derived UI phase + card summary fields. Computed by the API
  // off (status, ownerType, website verification, AVAILABLE service count).
  lifecyclePhase?:
    | "AWAITING_VERIFICATION"
    | "AWAITING_SERVICES"
    | "READY_FOR_REVIEW"
    | "IN_REVIEW"
    | "READY_TO_PUBLISH"
    | "PUBLISHED"
    | "PAUSED"
    | "REJECTED"
    | "ARCHIVED"
  // "From $X" — the minimum AVAILABLE service price. NULL when no service
  // is currently available (listing would be excluded from search anyway).
  priceFrom?: number | null
  // Deduped list of offered serviceTypes (AVAILABLE only).
  serviceTypes?: string[]
}

export interface SearchFilters {
  query?: string
  category?: string
  type?: string
  tags?: string[]
  country?: string
  language?: string
  minPrice?: number
  maxPrice?: number
  minDR?: number
  maxDR?: number
  minTraffic?: number
  maxTurnaroundDays?: number
  sortBy?:
    | "recommended"
    | "dr"
    | "traffic"
    | "price_asc"
    | "price_desc"
    | "newest"
    | "popular"
    | "best_rated"
    | "most_ordered"
  page?: number
  limit?: number
}

export interface SearchResult {
  listings: MarketplaceListing[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export interface Category {
  id: string
  name: string
  slug: string
  icon?: string
  children?: Category[]
}

// ── Phase 7 display helpers ───────────────────────────────────────────────
// These collapse the per-service AVAILABLE rows into the single value a
// card/badge wants to render. They prefer the new fields (priceFrom,
// services[]) and fall back to the legacy listing-level columns ONLY while
// the column drop migration is pending. After Phase 7 the legacy fields go
// away and only the new fields remain — these helpers stay correct.

interface DisplayListing {
  type?: string
  price?: number
  turnaroundDays?: number
  revisionRounds?: number
  priceFrom?: number | null
  serviceTypes?: string[]
  services?: ListingServiceOption[]
}

export function resolveDisplayType(listing: DisplayListing): string {
  return (
    listing.serviceTypes?.[0] ??
    listing.services?.[0]?.serviceType ??
    listing.type ??
    ""
  )
}

export function resolveDisplayPrice(listing: DisplayListing): number {
  if (listing.priceFrom != null) return listing.priceFrom
  if (listing.services && listing.services.length > 0) {
    const avail = listing.services.filter((s) => s.availability === "AVAILABLE")
    if (avail.length > 0) return Math.min(...avail.map((s) => s.price))
  }
  return listing.price ?? 0
}

export function resolveDisplayTurnaroundDays(
  listing: DisplayListing,
): number | undefined {
  const fromService = listing.services?.find(
    (s) => s.availability === "AVAILABLE",
  )?.turnaroundDays
  return fromService ?? listing.turnaroundDays
}

export function resolveDisplayRevisionRounds(
  listing: DisplayListing,
): number | undefined {
  const fromService = listing.services?.find(
    (s) => s.availability === "AVAILABLE",
  )?.revisionRounds
  return fromService ?? listing.revisionRounds
}

export class MarketplaceService {
  constructor(private client: HttpClient) {}

  searchListings(filters?: SearchFilters): Promise<SearchResult> {
    return this.client.get<SearchResult>("/marketplace/listings", {
      params: filters as Record<string, any>,
    })
  }

  getListing(slug: string): Promise<MarketplaceListing> {
    return this.client.get<MarketplaceListing>(`/marketplace/listings/${slug}`)
  }

  // Lightweight service-menu fetch for the order-flow picker. Returns only
  // AVAILABLE + WAITLIST rows (PAUSED is hidden from buyers).
  getListingServices(slug: string): Promise<{
    ownerType: "PUBLISHER" | "PLATFORM"
    services: ListingServiceOption[]
  }> {
    return this.client.get(`/marketplace/listings/${slug}/services`)
  }

  getCategories(): Promise<Category[]> {
    return this.client.get<Category[]>("/marketplace/categories")
  }

  getTags(): Promise<Array<{ id: string; name: string; slug: string }>> {
    return this.client.get("/marketplace/tags")
  }

  getServices(): Promise<MarketplaceListing[]> {
    return this.client.get("/marketplace/services")
  }

  getStats(): Promise<{
    totalListings: number
    activeListings: number
    totalReviews: number
    avgRating: number
    topCategories: Array<{ category: any; count: number }>
  }> {
    return this.client.get("/marketplace/stats")
  }

  getRecommendations(params?: {
    listingId?: string
    type?: string
    limit?: number
  }): Promise<MarketplaceListing[]> {
    return this.client.get("/marketplace/recommendations", {
      params: params as Record<string, string | number | undefined>,
    })
  }

  getFavorites(): Promise<
    Array<{ id: string; listing: MarketplaceListing; addedAt: string }>
  > {
    return this.client.get("/marketplace/favorites")
  }

  addFavorite(listingId: string): Promise<any> {
    return this.client.post("/marketplace/favorites", { json: { listingId } })
  }

  removeFavorite(listingId: string): Promise<any> {
    return this.client.delete(`/marketplace/favorites/${listingId}`)
  }

  getSavedLists(): Promise<
    Array<{
      id: string
      name: string
      slug: string
      isPublic: boolean
      items: Array<{
        id: string
        listing: MarketplaceListing
        note?: string
        addedAt: string
      }>
    }>
  > {
    return this.client.get("/marketplace/saved-lists")
  }

  createSavedList(data: {
    name: string
    slug?: string
    isPublic?: boolean
  }): Promise<any> {
    return this.client.post("/marketplace/saved-lists", { json: data })
  }

  addToSavedList(
    listId: string,
    listingId: string,
    note?: string,
  ): Promise<any> {
    return this.client.post(`/marketplace/saved-lists/${listId}/items`, {
      json: { listingId, note },
    })
  }

  removeFromSavedList(listId: string, listingId: string): Promise<any> {
    return this.client.delete(
      `/marketplace/saved-lists/${listId}/items/${listingId}`,
    )
  }

  createReview(data: {
    listingId: string
    rating: number
    title?: string
    content: string
  }): Promise<any> {
    return this.client.post("/marketplace/reviews", { json: data })
  }

  getPublisherListings(publisherId: string): Promise<MarketplaceListing[]> {
    return this.client.get(`/marketplace/publisher/${publisherId}/listings`)
  }

  createListing(data: any): Promise<any> {
    return this.client.post("/marketplace/listings", { json: data })
  }

  updateListing(listingId: string, data: any): Promise<any> {
    return this.client.put(`/marketplace/listings/${listingId}`, { json: data })
  }

  deleteListing(listingId: string): Promise<any> {
    return this.client.delete(`/marketplace/listings/${listingId}`)
  }

  // ── Per-service endpoints (publisher path) ─────────────────────────────
  // Manage individual ListingService rows on a publisher-owned listing.
  // Soft-delete via the DELETE endpoint flips availability to PAUSED — the
  // row is kept so historical orders' listingServiceId never orphan.
  addListingService(
    listingId: string,
    data: {
      serviceType: string
      price: number
      turnaroundDays: number
      currency?: string
      revisionRounds?: number
      warrantyDays?: number
      requirements?: Record<string, unknown>
      fulfillmentSettings?: Record<string, unknown>
      availability?: "AVAILABLE" | "PAUSED" | "WAITLIST"
    },
  ): Promise<ListingServiceOption> {
    return this.client.post(`/marketplace/listings/${listingId}/services`, {
      json: data,
    })
  }

  updateListingService(
    listingId: string,
    serviceId: string,
    data: {
      version: number
      price?: number
      turnaroundDays?: number
      currency?: string
      revisionRounds?: number
      warrantyDays?: number
      requirements?: Record<string, unknown>
      fulfillmentSettings?: Record<string, unknown>
      availability?: "AVAILABLE" | "PAUSED" | "WAITLIST"
    },
  ): Promise<ListingServiceOption> {
    return this.client.put(
      `/marketplace/listings/${listingId}/services/${serviceId}`,
      { json: data },
    )
  }

  pauseListingService(
    listingId: string,
    serviceId: string,
  ): Promise<ListingServiceOption> {
    return this.client.delete(
      `/marketplace/listings/${listingId}/services/${serviceId}`,
    )
  }

  // ── Per-service endpoints (admin path) ─────────────────────────────────
  // Admin mirrors of the publisher per-service endpoints for PLATFORM-owned
  // listings. Same wire shape; different auth gate on the server.
  addPlatformListingService(
    listingId: string,
    data: {
      serviceType: string
      price: number
      turnaroundDays: number
      currency?: string
      revisionRounds?: number
      warrantyDays?: number
      requirements?: Record<string, unknown>
      fulfillmentSettings?: Record<string, unknown>
      availability?: "AVAILABLE" | "PAUSED" | "WAITLIST"
    },
  ): Promise<ListingServiceOption> {
    return this.client.post(
      `/admin/marketplace/listings/${listingId}/services`,
      { json: data },
    )
  }

  updatePlatformListingService(
    listingId: string,
    serviceId: string,
    data: {
      version: number
      price?: number
      turnaroundDays?: number
      currency?: string
      revisionRounds?: number
      warrantyDays?: number
      requirements?: Record<string, unknown>
      fulfillmentSettings?: Record<string, unknown>
      availability?: "AVAILABLE" | "PAUSED" | "WAITLIST"
    },
  ): Promise<ListingServiceOption> {
    return this.client.put(
      `/admin/marketplace/listings/${listingId}/services/${serviceId}`,
      { json: data },
    )
  }

  pausePlatformListingService(
    listingId: string,
    serviceId: string,
  ): Promise<ListingServiceOption> {
    return this.client.delete(
      `/admin/marketplace/listings/${listingId}/services/${serviceId}`,
    )
  }

  // ── Phase 6 lifecycle transitions (publisher-side) ───────────────────────
  submitListing(listingId: string) {
    return this.client.post(`/marketplace/listings/${listingId}/submit`)
  }
  pauseListing(listingId: string) {
    return this.client.post(`/marketplace/listings/${listingId}/pause`)
  }
  unpauseListing(listingId: string) {
    return this.client.post(`/marketplace/listings/${listingId}/unpause`)
  }
  archiveListing(listingId: string) {
    return this.client.post(`/marketplace/listings/${listingId}/archive`)
  }

  // Order-flow website picker. Built on the real listings endpoint and
  // normalized to a flat array — the raw /marketplace/search route returns a
  // {listings, pagination} envelope (and filters a listing type nothing
  // uses), which crashed callers that expected an array.
  // Returned `id` is the WEBSITE id (order items reference websites).
  // Order placements: one entry per fulfillment website, with price + the
  // auto-derived fulfiller. Publisher-owned site -> that publisher; platform-
  // owned (INTERNAL fulfillment) -> Platform. The customer picks a SITE; the
  // publisher is never chosen by hand.
  async searchPlacements(params?: {
    category?: string
    language?: string
    country?: string
    search?: string
  }) {
    const res = await this.searchListings({
      query: params?.search,
      category: params?.category,
      language: params?.language,
      country: params?.country,
      limit: 50,
    })
    const seen = new Set<string>()
    const out: Array<{
      websiteId: string
      listingSlug: string
      name: string
      websiteUrl: string
      price: number
      currency: string
      domainRating: number
      traffic: number
      category?: string
      language?: string
      country?: string
      turnaroundDays?: number
      fulfilledBy: { kind: "PLATFORM" | "PUBLISHER"; name: string }
    }> = []
    for (const l of res.listings ?? []) {
      if (!l.websiteId || seen.has(l.websiteId)) continue
      seen.add(l.websiteId)
      const isPlatform = l.fulfillmentType === "INTERNAL"
      out.push({
        websiteId: l.websiteId,
        listingSlug: l.slug,
        name: l.title,
        websiteUrl: l.websiteUrl ?? "",
        price: l.price ?? 0,
        currency: l.currency ?? "USD",
        domainRating: l.domainRating ?? 0,
        traffic: l.traffic ?? 0,
        category: l.category?.name,
        language: l.language,
        country: l.country,
        turnaroundDays: l.turnaroundDays,
        fulfilledBy: isPlatform
          ? { kind: "PLATFORM", name: "Platform" }
          : { kind: "PUBLISHER", name: l.publisher?.name ?? "Publisher" },
      })
    }
    return out
  }

  async searchPublishers(params?: {
    category?: string
    language?: string
    country?: string
    search?: string
  }) {
    const res = await this.searchListings({
      query: params?.search,
      category: params?.category,
      language: params?.language,
      country: params?.country,
      limit: 50,
    })
    const seen = new Set<string>()
    const out: Array<{
      id: string
      name: string
      websiteUrl: string
      domainRating: number
      category?: string
      language?: string
      country?: string
    }> = []
    for (const l of res.listings ?? []) {
      if (!l.websiteId || seen.has(l.websiteId)) continue
      seen.add(l.websiteId)
      out.push({
        id: l.websiteId,
        name: l.title,
        websiteUrl: l.websiteUrl ?? "",
        domainRating: l.domainRating ?? 0,
        category: l.category?.name,
        language: l.language,
        country: l.country,
      })
    }
    return out
  }
}
