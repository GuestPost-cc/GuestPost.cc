import { HttpClient } from "../client"

export interface MarketplaceListing {
  id: string
  title: string
  slug: string
  description: string
  shortDescription?: string
  type: string
  status: string
  // INTERNAL = platform-fulfilled, PUBLISHER = publisher-fulfilled, HYBRID = both
  fulfillmentType: "INTERNAL" | "PUBLISHER" | "HYBRID"
  price: number
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
  revisionRounds: number
  featured: boolean
  verified: boolean
  websiteUrl?: string
  // Fulfillment website — order items must reference this, not the listing id
  websiteId?: string | null
  sampleUrl?: string
  category?: { id: string; name: string; slug: string }
  tags: Array<{ id: string; name: string; slug: string }>
  images: Array<{ url: string; isPrimary: boolean }>
  pricingTiers: Array<{ name: string; price: number; description?: string }>
  reviews?: Array<{ id: string; rating: number; title?: string; content: string; user: { name?: string; image?: string }; createdAt: string }>
  publisher?: { id: string; name: string; profile?: { rating?: number; totalReviews?: number; responseTime?: number } }
  image?: string
  avgRating?: number
  reviewCount: number
  isFavorited?: boolean
  relatedListings?: MarketplaceListing[]
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
  sortBy?: "recommended" | "dr" | "traffic" | "price_asc" | "price_desc" | "newest" | "popular" | "best_rated" | "most_ordered"
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

export class MarketplaceService {
  constructor(private client: HttpClient) {}

  searchListings(filters?: SearchFilters): Promise<SearchResult> {
    return this.client.get<SearchResult>("/marketplace/listings", { params: filters as Record<string, any> })
  }

  getListing(slug: string): Promise<MarketplaceListing> {
    return this.client.get<MarketplaceListing>(`/marketplace/listings/${slug}`)
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

  getRecommendations(params?: { listingId?: string; type?: string; limit?: number }): Promise<MarketplaceListing[]> {
    return this.client.get("/marketplace/recommendations", {
      params: params as Record<string, string | number | undefined>,
    })
  }

  getFavorites(): Promise<Array<{ id: string; listing: MarketplaceListing; addedAt: string }>> {
    return this.client.get("/marketplace/favorites")
  }

  addFavorite(listingId: string): Promise<any> {
    return this.client.post("/marketplace/favorites", { json: { listingId } })
  }

  removeFavorite(listingId: string): Promise<any> {
    return this.client.delete(`/marketplace/favorites/${listingId}`)
  }

  getSavedLists(): Promise<Array<{
    id: string
    name: string
    slug: string
    isPublic: boolean
    items: Array<{ id: string; listing: MarketplaceListing; note?: string; addedAt: string }>
  }>> {
    return this.client.get("/marketplace/saved-lists")
  }

  createSavedList(data: { name: string; slug?: string; isPublic?: boolean }): Promise<any> {
    return this.client.post("/marketplace/saved-lists", { json: data })
  }

  addToSavedList(listId: string, listingId: string, note?: string): Promise<any> {
    return this.client.post(`/marketplace/saved-lists/${listId}/items`, {
      json: { listingId, note },
    })
  }

  removeFromSavedList(listId: string, listingId: string): Promise<any> {
    return this.client.delete(`/marketplace/saved-lists/${listId}/items/${listingId}`)
  }

  createReview(data: { listingId: string; rating: number; title?: string; content: string }): Promise<any> {
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

  // Order-flow website picker. Built on the real listings endpoint and
  // normalized to a flat array — the raw /marketplace/search route returns a
  // {listings, pagination} envelope (and filters a listing type nothing
  // uses), which crashed callers that expected an array.
  // Returned `id` is the WEBSITE id (order items reference websites).
  // Order placements: one entry per fulfillment website, with price + the
  // auto-derived fulfiller. Publisher-owned site -> that publisher; platform-
  // owned (INTERNAL fulfillment) -> Platform. The customer picks a SITE; the
  // publisher is never chosen by hand.
  async searchPlacements(params?: { category?: string; language?: string; country?: string; search?: string }) {
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

  async searchPublishers(params?: { category?: string; language?: string; country?: string; search?: string }) {
    const res = await this.searchListings({
      query: params?.search,
      category: params?.category,
      language: params?.language,
      country: params?.country,
      limit: 50,
    })
    const seen = new Set<string>()
    const out: Array<{ id: string; name: string; websiteUrl: string; domainRating: number; category?: string; language?: string; country?: string }> = []
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