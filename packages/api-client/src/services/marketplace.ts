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

  searchPublishers(params?: { category?: string; language?: string; country?: string; search?: string }): Promise<Array<{ id: string; name: string; websiteUrl: string; domainRating: number }>> {
    return this.client.get("/marketplace/search", { params: params as Record<string, string | undefined> })
  }


}