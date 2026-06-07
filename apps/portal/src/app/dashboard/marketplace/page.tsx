"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { api } from "../../../lib/api"
import { cn } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { Star, Filter, Grid, List, Search, SlidersHorizontal, ExternalLink, Check } from "lucide-react"
import { useAuth } from "../../../lib/auth"

interface Listing {
  id: string
  title: string
  slug: string
  description: string
  shortDescription?: string
  type: string
  price: number
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
  const [listings, setListings] = useState<Listing[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
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
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 })

  useEffect(() => {
    loadCategories()
  }, [])

  useEffect(() => {
    loadListings()
  }, [searchQuery, selectedCategory, selectedType, sortBy, filters, pagination.page])

  async function loadCategories() {
    try {
      const res = await api.marketplace.getCategories()
      setCategories(res || [])
    } catch (err) {
      console.error("Failed to load categories:", err)
    }
  }

  async function loadListings() {
    setLoading(true)
    try {
      const params: any = {
        page: pagination.page,
        limit: 20,
        sortBy,
      }
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
      if (filters.maxTurnaroundDays) params.maxTurnaroundDays = Number(filters.maxTurnaroundDays)

      const result = await api.marketplace.searchListings(params)
      setListings(result?.listings || [])
      if (result?.pagination) {
        setPagination(prev => ({ ...prev, ...result.pagination }))
      }
    } catch (err) {
      console.error("Failed to load listings:", err)
    } finally {
      setLoading(false)
    }
  }

  function formatPrice(price: number, currency: string = "USD") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(price)
  }

  function resetFilters() {
    setFilters({ minDR: "", maxDR: "", minPrice: "", maxPrice: "", minTraffic: "", country: "", language: "", maxTurnaroundDays: "" })
    setSelectedCategory("all")
    setSelectedType("all")
    setSearchQuery("")
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Marketplace</h1>
          <p className="text-muted-foreground">Discover guest post opportunities and SEO services</p>
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
              <SelectItem value="PUBLISHER_WEBSITE">Publisher Website</SelectItem>
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

          <Button variant="outline" size="icon" onClick={() => setShowFilters(!showFilters)}>
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
            <label className="text-sm font-medium mb-1 block">Domain Rating</label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                placeholder="Min"
                value={filters.minDR}
                onChange={(e) => setFilters(f => ({ ...f, minDR: e.target.value }))}
                className="w-full"
              />
              <span className="text-muted-foreground">-</span>
              <Input
                type="number"
                placeholder="Max"
                value={filters.maxDR}
                onChange={(e) => setFilters(f => ({ ...f, maxDR: e.target.value }))}
                className="w-full"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Price Range</label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                placeholder="Min"
                value={filters.minPrice}
                onChange={(e) => setFilters(f => ({ ...f, minPrice: e.target.value }))}
                className="w-full"
              />
              <span className="text-muted-foreground">-</span>
              <Input
                type="number"
                placeholder="Max"
                value={filters.maxPrice}
                onChange={(e) => setFilters(f => ({ ...f, maxPrice: e.target.value }))}
                className="w-full"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Min Traffic</label>
            <Input
              type="number"
              placeholder="e.g. 1000"
              value={filters.minTraffic}
              onChange={(e) => setFilters(f => ({ ...f, minTraffic: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Country</label>
            <Input
              type="text"
              placeholder="e.g. US, UK"
              value={filters.country}
              onChange={(e) => setFilters(f => ({ ...f, country: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Language</label>
            <Input
              type="text"
              placeholder="e.g. English"
              value={filters.language}
              onChange={(e) => setFilters(f => ({ ...f, language: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Max Turnaround (Days)</label>
            <Input
              type="number"
              placeholder="e.g. 5"
              value={filters.maxTurnaroundDays}
              onChange={(e) => setFilters(f => ({ ...f, maxTurnaroundDays: e.target.value }))}
            />
          </div>
          <div className="flex items-end">
            <Button variant="outline" onClick={resetFilters} className="w-full">
              Reset Filters
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className={cn(
          "grid gap-6",
          viewMode === "grid" ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : "grid-cols-1"
        )}>
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
          <p className="text-muted-foreground mb-4">Try adjusting your filters or search query</p>
          <Button variant="outline" onClick={resetFilters}>Reset Filters</Button>
        </div>
      ) : (
        <>
          <div className={cn(
            "grid gap-6",
            viewMode === "grid" ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : "grid-cols-1"
          )}>
            {listings.map((listing) => (
              <Link
                key={listing.id}
                href={`/dashboard/marketplace/${listing.slug}`}
                className="group border rounded-lg overflow-hidden hover:shadow-md transition-all"
              >
                <div className="relative aspect-[4/3] bg-muted overflow-hidden">
                  {listing.image ? (
                    <img src={listing.image} alt={listing.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-primary/5">
                      <span className="text-4xl font-bold text-primary/20">{listing.title[0]}</span>
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
                      <span className="text-xs font-medium text-primary">{listing.category.name}</span>
                    )}
                    <span className="text-xs text-muted-foreground">{listing.type.replace("_", " ")}</span>
                  </div>
                  <h3 className="font-semibold line-clamp-2 group-hover:text-primary transition-colors">
                    {listing.title}
                  </h3>
                  {viewMode === "list" && (
                    <p className="text-sm text-muted-foreground line-clamp-2">{listing.description}</p>
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
                  <div className="flex items-center justify-between pt-2 border-t">
                    <span className="font-bold text-lg">{formatPrice(listing.price, listing.currency)}</span>
                    {listing.avgRating && (
                      <div className="flex items-center gap-1">
                        <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                        <span className="text-sm font-medium">{listing.avgRating.toFixed(1)}</span>
                        <span className="text-xs text-muted-foreground">({listing.reviewCount})</span>
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
                onClick={() => setPagination(p => ({ ...p, page: p.page - 1 }))}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <Button
                variant="outline"
                disabled={pagination.page === pagination.totalPages}
                onClick={() => setPagination(p => ({ ...p, page: p.page + 1 }))}
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