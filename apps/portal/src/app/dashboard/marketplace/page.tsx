"use client"

import {
  Button,
  cn,
  ErrorState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import {
  Check,
  Grid,
  List,
  Search,
  SlidersHorizontal,
  Star,
} from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

interface Listing {
  id: string
  title: string
  slug: string
  description: string
  shortDescription?: string
  // Phase 7: type / price / turnaroundDays are LEGACY listing-level columns
  // scheduled for drop. Prefer priceFrom + serviceTypes[] + services[].
  type?: string
  fulfillmentType?: "INTERNAL" | "PUBLISHER" | "HYBRID"
  price?: number
  priceFrom?: number | null
  serviceTypes?: string[]
  currency: string
  domainRating?: number
  traffic?: number
  country?: string
  language?: string
  turnaroundDays?: number
  featured: boolean
  verified: boolean
  category?: { id: string; name: string; slug: string }
  tags: Array<{ id: string; name: string; slug: string }>
  image?: string
  avgRating?: number
  reviewCount: number
}

interface Category {
  id: string
  name: string
  slug: string
  icon?: string
  children?: Category[]
}

export default function MarketplacePage() {
  const { user } = useAuth()
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedCategory, setSelectedCategory] = useState("all")
  const [selectedType, setSelectedType] = useState("all")
  const [sortBy, setSortBy] = useState("recommended")
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState({
    minDR: "",
    maxDR: "",
    minPrice: "",
    maxPrice: "",
    minTraffic: "",
    country: "",
    language: "",
    maxTurnaroundDays: "",
  })
  const [page, setPage] = useState(1)

  const {
    data: categories = [],
    error: categoriesError,
    refetch: refetchCategories,
  } = useQuery<Category[]>({
    queryKey: ["marketplace-categories"],
    queryFn: () => api.marketplace.getCategories(),
  })

  const searchParams = useMemo(() => {
    const params: any = { page, limit: 20, sortBy }
    if (searchQuery) params.query = searchQuery
    if (selectedCategory !== "all") params.category = selectedCategory
    if (selectedType !== "all") params.type = selectedType
    if (filters.minDR) params.minDR = Number(filters.minDR)
    if (filters.maxDR) params.maxDR = Number(filters.maxDR)
    if (filters.minPrice) params.minPrice = Number(filters.minPrice)
    if (filters.maxPrice) params.maxPrice = Number(filters.maxPrice)
    if (filters.minTraffic) params.minTraffic = Number(filters.minTraffic)
    if (filters.country) params.country = filters.country
    if (filters.language) params.language = filters.language
    if (filters.maxTurnaroundDays)
      params.maxTurnaroundDays = Number(filters.maxTurnaroundDays)
    return params
  }, [searchQuery, selectedCategory, selectedType, sortBy, filters, page])

  const {
    data: searchResult,
    isLoading,
    error: searchError,
    refetch: refetchSearch,
  } = useQuery({
    queryKey: ["marketplace-listings", searchParams],
    queryFn: () => api.marketplace.searchListings(searchParams),
  })

  const listings: Listing[] = searchResult?.listings || []
  const pagination = searchResult?.pagination || {
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  }

  function formatPrice(price: number, currency: string = "USD") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(price)
  }

  const marketplaceError = categoriesError || searchError

  if (marketplaceError) {
    return (
      <ErrorState
        title="Failed to load marketplace"
        description={(marketplaceError as Error).message}
        onRetry={() => {
          refetchCategories()
          refetchSearch()
        }}
      />
    )
  }

  function resetFilters() {
    setFilters({
      minDR: "",
      maxDR: "",
      minPrice: "",
      maxPrice: "",
      minTraffic: "",
      country: "",
      language: "",
      maxTurnaroundDays: "",
    })
    setSelectedCategory("all")
    setSelectedType("all")
    setSearchQuery("")
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Marketplace</h1>
          <p className="text-muted-foreground">
            Discover guest post opportunities and SEO services
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search listings..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedCategory} onValueChange={setSelectedCategory}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat.id} value={cat.slug}>
                  {cat.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={selectedType} onValueChange={setSelectedType}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="GUEST_POST">Guest Post</SelectItem>
              <SelectItem value="NICHE_EDIT">Niche Edit</SelectItem>
              <SelectItem value="EDITORIAL_LINK">Editorial Link</SelectItem>
              <SelectItem value="PUBLISHER_WEBSITE">
                Publisher Website
              </SelectItem>
            </SelectContent>
          </Select>

          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recommended">Recommended</SelectItem>
              <SelectItem value="dr">Highest DR</SelectItem>
              <SelectItem value="traffic">Highest Traffic</SelectItem>
              <SelectItem value="price_asc">Lowest Price</SelectItem>
              <SelectItem value="price_desc">Price: High to Low</SelectItem>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="best_rated">Best Rated</SelectItem>
              <SelectItem value="most_ordered">Most Ordered</SelectItem>
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowFilters(!showFilters)}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>

          <div className="flex border rounded-md">
            <Button
              variant={viewMode === "grid" ? "secondary" : "ghost"}
              size="icon"
              className="rounded-r-none"
              onClick={() => setViewMode("grid")}
            >
              <Grid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="icon"
              className="rounded-l-none"
              onClick={() => setViewMode("list")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {showFilters && (
        <div className="grid grid-cols-2 gap-4 p-4 border rounded-lg bg-card">
          <div>
            <label className="text-sm font-medium mb-1 block">
              Domain Rating
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                placeholder="Min"
                value={filters.minDR}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, minDR: e.target.value }))
                }
                className="w-full"
              />
              <span className="text-muted-foreground">-</span>
              <Input
                type="number"
                placeholder="Max"
                value={filters.maxDR}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, maxDR: e.target.value }))
                }
                className="w-full"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">
              Price Range
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                placeholder="Min"
                value={filters.minPrice}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, minPrice: e.target.value }))
                }
                className="w-full"
              />
              <span className="text-muted-foreground">-</span>
              <Input
                type="number"
                placeholder="Max"
                value={filters.maxPrice}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, maxPrice: e.target.value }))
                }
                className="w-full"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">
              Min Traffic
            </label>
            <Input
              type="number"
              placeholder="e.g. 1000"
              value={filters.minTraffic}
              onChange={(e) =>
                setFilters((f) => ({ ...f, minTraffic: e.target.value }))
              }
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Country</label>
            <Input
              type="text"
              placeholder="e.g. US, UK"
              value={filters.country}
              onChange={(e) =>
                setFilters((f) => ({ ...f, country: e.target.value }))
              }
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Language</label>
            <Input
              type="text"
              placeholder="e.g. English"
              value={filters.language}
              onChange={(e) =>
                setFilters((f) => ({ ...f, language: e.target.value }))
              }
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">
              Max Turnaround (Days)
            </label>
            <Input
              type="number"
              placeholder="e.g. 5"
              value={filters.maxTurnaroundDays}
              onChange={(e) =>
                setFilters((f) => ({ ...f, maxTurnaroundDays: e.target.value }))
              }
            />
          </div>
          <div className="flex items-end">
            <Button variant="outline" onClick={resetFilters} className="w-full">
              Reset Filters
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div
          className={cn(
            "grid gap-6",
            viewMode === "grid"
              ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              : "grid-cols-1",
          )}
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="border rounded-lg p-4 space-y-3">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-6 w-1/3" />
            </div>
          ))}
        </div>
      ) : listings.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="rounded-full bg-muted p-4 mb-4">
            <Search className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-1">No listings found</h3>
          <p className="text-muted-foreground mb-4">
            Try adjusting your filters or search query
          </p>
          <Button variant="outline" onClick={resetFilters}>
            Reset Filters
          </Button>
        </div>
      ) : (
        <>
          <div
            className={cn(
              "grid gap-6",
              viewMode === "grid"
                ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                : "grid-cols-1",
            )}
          >
            {listings.map((listing) => (
              <Link
                key={listing.id}
                href={`/dashboard/marketplace/${listing.slug}`}
                className="group border rounded-lg overflow-hidden hover:shadow-md transition-all"
              >
                <div className="relative aspect-[4/3] bg-muted overflow-hidden">
                  {listing.image ? (
                    <img
                      src={listing.image}
                      alt={listing.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-primary/5">
                      <span className="text-4xl font-bold text-primary/20">
                        {listing.title[0]}
                      </span>
                    </div>
                  )}
                  {listing.featured && (
                    <span className="absolute top-2 left-2 px-2 py-0.5 text-xs font-medium bg-primary text-primary-foreground rounded">
                      Featured
                    </span>
                  )}
                  {listing.verified && (
                    <span className="absolute top-2 right-2">
                      <Check className="h-5 w-5 text-green-500" />
                    </span>
                  )}
                </div>
                <div className="p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    {listing.category && (
                      <span className="text-xs font-medium text-primary">
                        {listing.category.name}
                      </span>
                    )}
                    {/* Phase 7: prefer the first AVAILABLE service over the
                        deprecated listing-level `type`. */}
                    <span className="text-xs text-muted-foreground">
                      {(
                        (listing as any).serviceTypes?.[0] ??
                        listing.type ??
                        ""
                      ).replace(/_/g, " ")}
                    </span>
                    {listing.fulfillmentType === "INTERNAL" ? (
                      <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                        Platform
                      </span>
                    ) : listing.fulfillmentType === "HYBRID" ? (
                      <span className="ml-auto rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600">
                        Hybrid
                      </span>
                    ) : (
                      <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Publisher
                      </span>
                    )}
                  </div>
                  <h3 className="font-semibold line-clamp-2 group-hover:text-primary transition-colors">
                    {listing.title}
                  </h3>
                  {viewMode === "list" && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {listing.description}
                    </p>
                  )}
                  <div className="flex items-center gap-3 pt-2">
                    {listing.domainRating && (
                      <span className="text-xs font-medium px-2 py-0.5 bg-muted rounded">
                        DR {listing.domainRating}
                      </span>
                    )}
                    {listing.traffic && (
                      <span className="text-xs text-muted-foreground">
                        {listing.traffic.toLocaleString()} visitors
                      </span>
                    )}
                  </div>
                  {/* Phase 6: per-service chips + "from $X". priceFrom is the
                      cheapest AVAILABLE service price; serviceTypes is the
                      deduped list. Falls back to the legacy listing-level
                      price when the new fields aren't on the payload. */}
                  {(listing as any).serviceTypes?.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {((listing as any).serviceTypes as string[])
                        .slice(0, 3)
                        .map((t) => (
                          <span
                            key={t}
                            className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                          >
                            {t.replace(/_/g, " ")}
                          </span>
                        ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-2 border-t">
                    <span className="font-bold text-lg">
                      {(listing as any).priceFrom != null ? (
                        <>
                          <span className="text-xs text-muted-foreground font-normal mr-1">
                            from
                          </span>
                          {formatPrice(
                            (listing as any).priceFrom,
                            listing.currency,
                          )}
                        </>
                      ) : (
                        formatPrice(listing.price ?? 0, listing.currency)
                      )}
                    </span>
                    {listing.avgRating && (
                      <div className="flex items-center gap-1">
                        <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                        <span className="text-sm font-medium">
                          {listing.avgRating.toFixed(1)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          ({listing.reviewCount})
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-8">
              <Button
                variant="outline"
                disabled={pagination.page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <Button
                variant="outline"
                disabled={pagination.page === pagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
