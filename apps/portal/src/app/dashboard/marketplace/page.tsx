"use client"

import {
  Badge,
  Button,
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
import { Lock, Search, SlidersHorizontal, Star, X } from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import { useMemo, useState } from "react"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { useCustomerAccess } from "../../../lib/hooks/use-customer-access"

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
  websiteUrl?: string
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
  const [sortBy, setSortBy] = useState("recommended")
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
  }, [searchQuery, selectedCategory, sortBy, filters, page])

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

  const { canViewUrls } = useCustomerAccess()

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
    setSearchQuery("")
  }

  const hasActiveFilters =
    filters.minDR ||
    filters.maxDR ||
    filters.minPrice ||
    filters.maxPrice ||
    filters.minTraffic ||
    filters.country ||
    filters.language ||
    filters.maxTurnaroundDays

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Marketplace</h1>
        <p className="mt-1.5 text-muted-foreground">
          Browse guest post opportunities and SEO services from verified
          publishers.
        </p>
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
            <SelectTrigger className="w-[160px]">
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

          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recommended">Recommended</SelectItem>
              <SelectItem value="dr">Highest DR</SelectItem>
              <SelectItem value="price_asc">Lowest Price</SelectItem>
              <SelectItem value="price_desc">Price: High to Low</SelectItem>
              <SelectItem value="newest">Newest</SelectItem>
            </SelectContent>
          </Select>

          <Button
            variant={showFilters ? "secondary" : "outline"}
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
            className="gap-2"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
            {hasActiveFilters && (
              <span className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
                !
              </span>
            )}
          </Button>
        </div>
      </div>

      {showFilters && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 p-5 border rounded-xl bg-card sm:grid-cols-3 lg:grid-cols-6">
          <div className="space-y-1.5 sm:col-span-1">
            <label className="text-xs font-medium text-muted-foreground">
              Domain Rating
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                placeholder="Min"
                value={filters.minDR}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, minDR: e.target.value }))
                }
              />
              <span className="text-muted-foreground text-xs">to</span>
              <Input
                type="number"
                placeholder="Max"
                value={filters.maxDR}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, maxDR: e.target.value }))
                }
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Price Range
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                placeholder="Min"
                value={filters.minPrice}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, minPrice: e.target.value }))
                }
              />
              <span className="text-muted-foreground text-xs">to</span>
              <Input
                type="number"
                placeholder="Max"
                value={filters.maxPrice}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, maxPrice: e.target.value }))
                }
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Min Traffic
            </label>
            <Input
              type="number"
              placeholder="e.g. 10,000"
              value={filters.minTraffic}
              onChange={(e) =>
                setFilters((f) => ({ ...f, minTraffic: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Country
            </label>
            <Input
              placeholder="e.g. US"
              value={filters.country}
              onChange={(e) =>
                setFilters((f) => ({ ...f, country: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Language
            </label>
            <Input
              placeholder="e.g. English"
              value={filters.language}
              onChange={(e) =>
                setFilters((f) => ({ ...f, language: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Max Turnaround
            </label>
            <Input
              type="number"
              placeholder="Days"
              value={filters.maxTurnaroundDays}
              onChange={(e) =>
                setFilters((f) => ({ ...f, maxTurnaroundDays: e.target.value }))
              }
            />
          </div>
          <div className="col-span-full flex items-center justify-between pt-1">
            <span className="text-xs text-muted-foreground">
              {listings.length} listing{listings.length !== 1 ? "s" : ""} found
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="gap-1.5"
            >
              <X className="h-3.5 w-3.5" />
              Reset all filters
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-3">
              <Skeleton className="aspect-[4/3] w-full rounded-xl" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))}
        </div>
      ) : listings.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-muted p-4 mb-4">
            <Search className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold">No listings found</h3>
          <p className="text-muted-foreground mt-1 mb-5">
            Try adjusting your filters or search query
          </p>
          <Button variant="outline" onClick={resetFilters}>
            Reset Filters
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {listings.map((listing) => (
              <Link
                key={listing.id}
                href={`/dashboard/marketplace/${listing.slug}`}
                className="group rounded-xl border bg-card hover:shadow-md transition-all"
              >
                <div className="relative aspect-[4/3] overflow-hidden rounded-t-xl bg-muted">
                  {listing.image ? (
                    <Image
                      fill
                      unoptimized
                      src={listing.image}
                      alt={listing.title}
                      className="object-cover group-hover:scale-105 transition-transform duration-300"
                      sizes="(max-width: 768px) 50vw, 33vw"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center bg-gradient-to-br from-primary/5 to-primary/10">
                      <span className="text-5xl font-bold text-primary/15">
                        {listing.title[0]}
                      </span>
                    </div>
                  )}
                  {listing.featured && (
                    <span className="absolute left-3 top-3 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold text-primary-foreground">
                      Featured
                    </span>
                  )}
                </div>
                <div className="p-4 space-y-2.5">
                  <div className="flex items-center gap-2">
                    {listing.category && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] px-1.5 py-0"
                      >
                        {listing.category.name}
                      </Badge>
                    )}
                    {listing.fulfillmentType && (
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1.5 py-0"
                      >
                        {listing.fulfillmentType === "INTERNAL"
                          ? "Platform"
                          : listing.fulfillmentType === "HYBRID"
                            ? "Hybrid"
                            : "Publisher"}
                      </Badge>
                    )}
                  </div>
                  <h3 className="font-semibold leading-snug line-clamp-2 group-hover:text-primary transition-colors">
                    {listing.title}
                  </h3>
                  {listing.websiteUrl && (
                    <div className="flex items-center gap-1.5 text-xs">
                      {canViewUrls ? (
                        <span className="truncate text-muted-foreground">
                          {listing.websiteUrl}
                        </span>
                      ) : (
                        <span className="relative inline-block">
                          <span className="select-none text-muted-foreground blur-sm">
                            {listing.websiteUrl}
                          </span>
                          <Lock className="absolute left-0 top-0 h-3 w-3 text-muted-foreground" />
                        </span>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {listing.domainRating && (
                      <span className="font-medium text-foreground">
                        DR {listing.domainRating}
                      </span>
                    )}
                    {listing.traffic && (
                      <span>{listing.traffic.toLocaleString()} /mo</span>
                    )}
                  </div>
                  {(listing as any).serviceTypes?.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {((listing as any).serviceTypes as string[])
                        .slice(0, 2)
                        .map((t) => (
                          <span
                            key={t}
                            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground"
                          >
                            {t.replace(/_/g, " ")}
                          </span>
                        ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-1.5">
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
                        <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
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
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={pagination.page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <div className="flex items-center gap-1.5">
                {Array.from(
                  { length: Math.min(pagination.totalPages, 5) },
                  (_, i) => {
                    const pageNum = i + 1
                    return (
                      <Button
                        key={pageNum}
                        variant={
                          pagination.page === pageNum ? "default" : "ghost"
                        }
                        size="sm"
                        className="w-8"
                        onClick={() => setPage(pageNum)}
                      >
                        {pageNum}
                      </Button>
                    )
                  },
                )}
                {pagination.totalPages > 5 && (
                  <span className="text-xs text-muted-foreground px-1">
                    … {pagination.totalPages}
                  </span>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
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
