"use client"

import type {
  Category,
  MarketplaceListing,
  SearchFilters,
} from "@guestpost/api-client"
import {
  Button,
  ErrorState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Heart,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react"
import Link from "next/link"
import { useCallback, useDeferredValue, useMemo, useState } from "react"
import { MarketplaceListingCard } from "../../../components/marketplace/marketplace-listing-card"
import {
  SERVICE_OPTIONS,
  serviceLabel,
  visiblePaginationPages,
} from "../../../components/marketplace/marketplace-ui"
import { api } from "../../../lib/api"
import { useCustomerAccess } from "../../../lib/hooks/use-customer-access"

interface FilterState {
  minDR: string
  maxDR: string
  minPrice: string
  maxPrice: string
  minTraffic: string
  country: string
  language: string
  maxTurnaroundDays: string
}

const EMPTY_FILTERS: FilterState = {
  minDR: "",
  maxDR: "",
  minPrice: "",
  maxPrice: "",
  minTraffic: "",
  country: "",
  language: "",
  maxTurnaroundDays: "",
}

export default function MarketplacePage() {
  const [searchQuery, setSearchQuery] = useState("")
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const [selectedCategory, setSelectedCategory] = useState("all")
  const [selectedService, setSelectedService] = useState("all")
  const [sortBy, setSortBy] = useState<SearchFilters["sortBy"]>("recommended")
  const [showMobileFilters, setShowMobileFilters] = useState(false)
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)

  const {
    data: categories = [],
    error: categoriesError,
    refetch: refetchCategories,
  } = useQuery<Category[]>({
    queryKey: ["marketplace-categories"],
    queryFn: () => api.marketplace.getCategories(),
  })

  const searchParams = useMemo<SearchFilters>(() => {
    const params: SearchFilters = { page, limit: 18, sortBy }
    const query = deferredSearchQuery.trim()
    if (query) params.query = query
    if (selectedCategory !== "all") params.category = selectedCategory
    if (selectedService !== "all") params.type = selectedService
    if (filters.minDR) params.minDR = Number(filters.minDR)
    if (filters.maxDR) params.maxDR = Number(filters.maxDR)
    if (filters.minPrice) params.minPrice = Number(filters.minPrice)
    if (filters.maxPrice) params.maxPrice = Number(filters.maxPrice)
    if (filters.minTraffic) params.minTraffic = Number(filters.minTraffic)
    if (filters.country.trim()) params.country = filters.country.trim()
    if (filters.language.trim()) params.language = filters.language.trim()
    if (filters.maxTurnaroundDays) {
      params.maxTurnaroundDays = Number(filters.maxTurnaroundDays)
    }
    return params
  }, [
    deferredSearchQuery,
    filters,
    page,
    selectedCategory,
    selectedService,
    sortBy,
  ])

  const {
    data: searchResult,
    isLoading,
    isFetching,
    error: searchError,
    refetch: refetchSearch,
  } = useQuery({
    queryKey: ["marketplace-listings", searchParams],
    queryFn: () => api.marketplace.searchListings(searchParams),
  })

  const listings: MarketplaceListing[] = searchResult?.listings ?? []
  const pagination = searchResult?.pagination ?? {
    page: 1,
    limit: 18,
    total: 0,
    totalPages: 0,
  }
  const { canViewUrls } = useCustomerAccess()

  const resetFilters = () => {
    setFilters(EMPTY_FILTERS)
    setSelectedCategory("all")
    setSelectedService("all")
    setSearchQuery("")
    setPage(1)
  }

  const updateFilter = useCallback((key: keyof FilterState, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }))
    setPage(1)
  }, [])

  const categoryName = categories.find(
    (category) => category.slug === selectedCategory,
  )?.name

  const activeFilters = useMemo(() => {
    const active: Array<{ key: string; label: string; clear: () => void }> = []
    if (selectedService !== "all") {
      active.push({
        key: "service",
        label: serviceLabel(selectedService),
        clear: () => {
          setSelectedService("all")
          setPage(1)
        },
      })
    }
    if (selectedCategory !== "all") {
      active.push({
        key: "category",
        label: categoryName ?? selectedCategory,
        clear: () => {
          setSelectedCategory("all")
          setPage(1)
        },
      })
    }
    if (filters.minPrice || filters.maxPrice) {
      active.push({
        key: "price",
        label: `$${filters.minPrice || "0"}–$${filters.maxPrice || "any"}`,
        clear: () => {
          setFilters((current) => ({
            ...current,
            minPrice: "",
            maxPrice: "",
          }))
          setPage(1)
        },
      })
    }
    if (filters.minDR || filters.maxDR) {
      active.push({
        key: "dr",
        label: `DR ${filters.minDR || "1"}–${filters.maxDR || "100"}`,
        clear: () => {
          setFilters((current) => ({
            ...current,
            minDR: "",
            maxDR: "",
          }))
          setPage(1)
        },
      })
    }
    if (filters.minTraffic) {
      active.push({
        key: "traffic",
        label: `${Number(filters.minTraffic).toLocaleString()}+ traffic`,
        clear: () => updateFilter("minTraffic", ""),
      })
    }
    if (filters.maxTurnaroundDays) {
      active.push({
        key: "turnaround",
        label: `Up to ${filters.maxTurnaroundDays} days`,
        clear: () => updateFilter("maxTurnaroundDays", ""),
      })
    }
    if (filters.country) {
      active.push({
        key: "country",
        label: filters.country,
        clear: () => updateFilter("country", ""),
      })
    }
    if (filters.language) {
      active.push({
        key: "language",
        label: filters.language,
        clear: () => updateFilter("language", ""),
      })
    }
    return active
  }, [categoryName, filters, selectedCategory, selectedService, updateFilter])

  if (searchError) {
    return (
      <ErrorState
        title="The marketplace could not be loaded"
        description={(searchError as Error).message}
        onRetry={() => refetchSearch()}
      />
    )
  }

  const filterPanel = (
    <FilterPanel
      categories={categories}
      categoriesError={categoriesError as Error | null}
      selectedCategory={selectedCategory}
      onCategoryChange={(value) => {
        setSelectedCategory(value)
        setPage(1)
      }}
      filters={filters}
      onFilterChange={updateFilter}
      onReset={resetFilters}
      onRetryCategories={() => refetchCategories()}
      activeCount={activeFilters.length}
    />
  )

  return (
    <div className="mx-auto max-w-[1500px] space-y-7">
      <section className="relative overflow-hidden rounded-3xl bg-slate-950 px-5 py-8 text-white shadow-sm sm:px-8 sm:py-10 lg:px-10">
        <div className="absolute -right-20 -top-28 h-72 w-72 rounded-full bg-blue-500/20 blur-3xl" />
        <div className="absolute -bottom-32 left-1/3 h-64 w-64 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative max-w-4xl">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-300">
                <Sparkles className="h-3.5 w-3.5" /> Buyer marketplace
              </p>
              <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
                Find the right placement for every campaign
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
                Compare verified sites by service, authority, traffic, delivery
                time, and price before you place an order.
              </p>
            </div>
            <div className="hidden gap-2 sm:flex">
              <Button
                asChild
                variant="outline"
                className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white"
              >
                <Link href="/dashboard/marketplace/favorites">
                  <Heart className="mr-2 h-4 w-4" /> Favorites
                </Link>
              </Button>
              <Button
                asChild
                variant="outline"
                className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white"
              >
                <Link href="/dashboard/marketplace/saved-lists">
                  <Bookmark className="mr-2 h-4 w-4" /> Saved lists
                </Link>
              </Button>
            </div>
          </div>

          <div className="relative mt-7 max-w-3xl">
            <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
            <Input
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value)
                setPage(1)
              }}
              placeholder="Search a niche, site, category, or keyword"
              aria-label="Search marketplace listings"
              className="h-13 border-white/15 bg-white pl-12 pr-12 text-base text-slate-950 shadow-xl placeholder:text-slate-400 focus-visible:ring-white"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setSearchQuery("")
                  setPage(1)
                }}
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="service-filter-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="service-filter-heading" className="text-sm font-semibold">
              What do you need?
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Pick a service to see listings that offer it now.
            </p>
          </div>
        </div>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-2">
          <Button
            variant={selectedService === "all" ? "default" : "outline"}
            size="sm"
            className="shrink-0 rounded-full"
            onClick={() => {
              setSelectedService("all")
              setPage(1)
            }}
          >
            All services
          </Button>
          {SERVICE_OPTIONS.map((service) => (
            <Button
              key={service.value}
              variant={
                selectedService === service.value ? "default" : "outline"
              }
              size="sm"
              className="shrink-0 rounded-full"
              onClick={() => {
                setSelectedService(service.value)
                setPage(1)
              }}
            >
              {service.label}
            </Button>
          ))}
        </div>
      </section>

      <div className="flex items-center justify-between gap-3 xl:hidden">
        <Button
          variant="outline"
          onClick={() => setShowMobileFilters((current) => !current)}
          aria-expanded={showMobileFilters}
        >
          <SlidersHorizontal className="mr-2 h-4 w-4" />
          Filters
          {activeFilters.length > 0 && (
            <span className="ml-2 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
              {activeFilters.length}
            </span>
          )}
        </Button>
        <Select
          value={sortBy}
          onValueChange={(value) => {
            setSortBy(value as SearchFilters["sortBy"])
            setPage(1)
          }}
        >
          <SelectTrigger className="w-[175px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SortOptions />
          </SelectContent>
        </Select>
      </div>

      {showMobileFilters && (
        <div className="rounded-2xl border bg-card p-6 xl:hidden">
          {filterPanel}
        </div>
      )}

      <div className="grid items-start gap-7 xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="sticky top-6 hidden rounded-2xl border bg-card p-6 xl:block">
          {filterPanel}
        </aside>

        <div className="min-w-0">
          <div className="mb-5 flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold tracking-tight">
                  {deferredSearchQuery.trim()
                    ? `Results for “${deferredSearchQuery.trim()}”`
                    : "Available placements"}
                </h2>
                {isFetching && !isLoading && (
                  <span
                    role="status"
                    className="h-2 w-2 animate-pulse rounded-full bg-primary"
                    aria-label="Updating results"
                  />
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {pagination.total.toLocaleString()} matching listing
                {pagination.total === 1 ? "" : "s"}
              </p>
            </div>
            <div className="hidden items-center gap-2 xl:flex">
              <Label
                htmlFor="marketplace-sort"
                className="text-xs text-muted-foreground"
              >
                Sort by
              </Label>
              <Select
                value={sortBy}
                onValueChange={(value) => {
                  setSortBy(value as SearchFilters["sortBy"])
                  setPage(1)
                }}
              >
                <SelectTrigger id="marketplace-sort" className="w-[185px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SortOptions />
                </SelectContent>
              </Select>
            </div>
          </div>

          {activeFilters.length > 0 && (
            <div
              role="group"
              className="mb-5 flex flex-wrap items-center gap-2"
              aria-label="Active filters"
            >
              {activeFilters.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  onClick={filter.clear}
                  className="inline-flex items-center gap-1.5 rounded-full border bg-secondary px-3 py-1.5 text-xs font-medium transition hover:bg-secondary/70"
                >
                  {filter.label}
                  <X className="h-3 w-3" />
                </button>
              ))}
              <button
                type="button"
                onClick={resetFilters}
                className="px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Clear all
              </button>
            </div>
          )}

          {isLoading ? (
            <MarketplaceSkeleton />
          ) : listings.length === 0 ? (
            <div className="rounded-2xl border border-dashed bg-muted/20 px-6 py-16 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-background shadow-sm">
                <Search className="h-5 w-5 text-muted-foreground" />
              </div>
              <h3 className="mt-5 text-lg font-semibold">
                No placements match yet
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                Remove one or two filters, broaden the search, or browse all
                services to see more options.
              </p>
              <Button variant="outline" className="mt-5" onClick={resetFilters}>
                Clear search and filters
              </Button>
            </div>
          ) : (
            <>
              <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
                {listings.map((listing) => (
                  <MarketplaceListingCard
                    key={listing.id}
                    listing={listing}
                    canViewUrls={canViewUrls}
                    serviceTypeFilter={
                      selectedService === "all" ? undefined : selectedService
                    }
                  />
                ))}
              </div>

              {pagination.totalPages > 1 && (
                <nav
                  aria-label="Marketplace pagination"
                  className="mt-8 flex flex-wrap items-center justify-center gap-1"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pagination.page === 1}
                    onClick={() =>
                      setPage((current) => Math.max(1, current - 1))
                    }
                    className="mr-2"
                  >
                    <ArrowLeft className="mr-1.5 h-4 w-4" /> Previous
                  </Button>
                  {visiblePaginationPages(
                    pagination.page,
                    pagination.totalPages,
                  ).map((item, index) =>
                    item === "ellipsis" ? (
                      <span
                        key={`ellipsis-${index}`}
                        className="flex h-9 w-8 items-center justify-center text-sm text-muted-foreground"
                      >
                        …
                      </span>
                    ) : (
                      <Button
                        key={item}
                        variant={pagination.page === item ? "default" : "ghost"}
                        size="sm"
                        className="h-9 w-9 p-0"
                        aria-current={
                          pagination.page === item ? "page" : undefined
                        }
                        onClick={() => setPage(item)}
                      >
                        {item}
                      </Button>
                    ),
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pagination.page === pagination.totalPages}
                    onClick={() => setPage((current) => current + 1)}
                    className="ml-2"
                  >
                    Next <ArrowRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </nav>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SortOptions() {
  return (
    <>
      <SelectItem value="recommended">Best match</SelectItem>
      <SelectItem value="dr">Highest authority</SelectItem>
      <SelectItem value="traffic">Most traffic</SelectItem>
      <SelectItem value="price_asc">Lowest starting price</SelectItem>
      <SelectItem value="price_desc">Highest starting price</SelectItem>
      <SelectItem value="best_rated">Most reviewed</SelectItem>
      <SelectItem value="newest">Newest listings</SelectItem>
    </>
  )
}

function FilterPanel({
  categories,
  categoriesError,
  selectedCategory,
  onCategoryChange,
  filters,
  onFilterChange,
  onReset,
  onRetryCategories,
  activeCount,
}: {
  categories: Category[]
  categoriesError: Error | null
  selectedCategory: string
  onCategoryChange: (value: string) => void
  filters: FilterState
  onFilterChange: (key: keyof FilterState, value: string) => void
  onReset: () => void
  onRetryCategories: () => void
  activeCount: number
}) {
  return (
    <div className="space-y-7">
      <div className="flex items-center justify-between border-b px-1 pb-4">
        <div>
          <h2 className="font-semibold">Refine results</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {activeCount > 0 ? `${activeCount} active` : "All placements"}
          </p>
        </div>
        {activeCount > 0 && (
          <Button variant="ghost" size="sm" onClick={onReset}>
            Reset
          </Button>
        )}
      </div>

      <div className="space-y-3 px-1">
        <Label htmlFor="marketplace-category">Category</Label>
        <Select value={selectedCategory} onValueChange={onCategoryChange}>
          <SelectTrigger id="marketplace-category" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((category) => (
              <SelectItem key={category.id} value={category.slug}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {categoriesError && (
          <button
            type="button"
            onClick={onRetryCategories}
            className="text-left text-xs text-destructive hover:underline"
          >
            Categories unavailable. Try again.
          </button>
        )}
      </div>

      <fieldset className="space-y-3 px-1">
        <legend className="text-sm font-medium">Budget</legend>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label htmlFor="minimum-price" className="sr-only">
              Minimum price
            </Label>
            <Input
              id="minimum-price"
              type="number"
              min={0}
              placeholder="Min $"
              value={filters.minPrice}
              onChange={(event) =>
                onFilterChange("minPrice", event.target.value)
              }
            />
          </div>
          <div>
            <Label htmlFor="maximum-price" className="sr-only">
              Maximum price
            </Label>
            <Input
              id="maximum-price"
              type="number"
              min={0}
              placeholder="Max $"
              value={filters.maxPrice}
              onChange={(event) =>
                onFilterChange("maxPrice", event.target.value)
              }
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-3 px-1">
        <legend className="text-sm font-medium">Domain rating</legend>
        <div className="grid grid-cols-2 gap-2">
          <Input
            aria-label="Minimum domain rating"
            type="number"
            min={1}
            max={100}
            placeholder="Min DR"
            value={filters.minDR}
            onChange={(event) => onFilterChange("minDR", event.target.value)}
          />
          <Input
            aria-label="Maximum domain rating"
            type="number"
            min={1}
            max={100}
            placeholder="Max DR"
            value={filters.maxDR}
            onChange={(event) => onFilterChange("maxDR", event.target.value)}
          />
        </div>
      </fieldset>

      <div className="space-y-3 px-1">
        <Label htmlFor="minimum-traffic">Minimum monthly traffic</Label>
        <Input
          id="minimum-traffic"
          type="number"
          min={0}
          placeholder="e.g. 10,000"
          value={filters.minTraffic}
          onChange={(event) => onFilterChange("minTraffic", event.target.value)}
        />
      </div>

      <div className="space-y-3 px-1">
        <Label htmlFor="maximum-turnaround">Maximum delivery time</Label>
        <Select
          value={filters.maxTurnaroundDays || "any"}
          onValueChange={(value) =>
            onFilterChange("maxTurnaroundDays", value === "any" ? "" : value)
          }
        >
          <SelectTrigger id="maximum-turnaround" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any delivery time</SelectItem>
            <SelectItem value="3">Up to 3 days</SelectItem>
            <SelectItem value="7">Up to 7 days</SelectItem>
            <SelectItem value="14">Up to 14 days</SelectItem>
            <SelectItem value="30">Up to 30 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-4 px-1 xl:grid-cols-1">
        <div className="space-y-3">
          <Label htmlFor="marketplace-country">Country</Label>
          <Input
            id="marketplace-country"
            placeholder="e.g. US"
            value={filters.country}
            onChange={(event) => onFilterChange("country", event.target.value)}
          />
        </div>
        <div className="space-y-3">
          <Label htmlFor="marketplace-language">Language</Label>
          <Input
            id="marketplace-language"
            placeholder="e.g. English"
            value={filters.language}
            onChange={(event) => onFilterChange("language", event.target.value)}
          />
        </div>
      </div>
    </div>
  )
}

function MarketplaceSkeleton() {
  return (
    <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="overflow-hidden rounded-2xl border">
          <Skeleton className="aspect-[16/9] w-full rounded-none" />
          <div className="space-y-4 p-5">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-6 w-4/5" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}
