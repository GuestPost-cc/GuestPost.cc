"use client"

import type { MarketplaceListing } from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircle,
  Archive,
  ArrowRight,
  CheckCircle2,
  DollarSign,
  Globe2,
  Layers3,
  Pause,
  Plus,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  Store,
  X,
} from "lucide-react"
import Link from "next/link"
import { useDeferredValue, useMemo, useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

const SERVICE_TYPES = [
  ["GUEST_POST", "Guest post"],
  ["NICHE_EDIT", "Niche edit"],
  ["EDITORIAL_LINK", "Editorial link"],
  ["OUTREACH_LINK", "Outreach link"],
  ["LOCAL_CITATION", "Local citation"],
  ["FOUNDATION_LINK", "Foundation link"],
  ["BLOG_ARTICLE", "Blog article"],
  ["SEO_CONTENT", "SEO content"],
] as const

const PHASES: Record<
  string,
  { label: string; guidance: string; tone: string }
> = {
  AWAITING_VERIFICATION: {
    label: "Verify domain",
    guidance: "Complete DNS verification before marketplace review.",
    tone: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-950 dark:bg-amber-950/30 dark:text-amber-300",
  },
  AWAITING_SERVICES: {
    label: "Add services",
    guidance: "Add at least one available service before review.",
    tone: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-950 dark:bg-amber-950/30 dark:text-amber-300",
  },
  READY_FOR_REVIEW: {
    label: "Ready for review",
    guidance: "The listing is complete and can be submitted.",
    tone: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-950 dark:bg-blue-950/30 dark:text-blue-300",
  },
  IN_REVIEW: {
    label: "In review",
    guidance: "GuestPost is reviewing the listing before publication.",
    tone: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-950 dark:bg-violet-950/30 dark:text-violet-300",
  },
  PUBLISHED: {
    label: "Live",
    guidance: "Buyers can find and order available services.",
    tone: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-300",
  },
  PAUSED: {
    label: "Paused",
    guidance: "The listing is hidden from new marketplace orders.",
    tone: "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
  },
  REJECTED: {
    label: "Needs changes",
    guidance: "Update the requested details, then resubmit.",
    tone: "border-red-200 bg-red-50 text-red-700 dark:border-red-950 dark:bg-red-950/30 dark:text-red-300",
  },
  ARCHIVED: {
    label: "Archived",
    guidance: "This listing is no longer available to buyers.",
    tone: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400",
  },
}

function serviceLabel(value: string) {
  return (
    SERVICE_TYPES.find(([type]) => type === value)?.[1] ??
    value.replace(/_/g, " ").toLowerCase()
  )
}

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value))
}

function listingPhase(listing: MarketplaceListing) {
  return listing.lifecyclePhase ?? listing.status
}

export default function PublisherListingsPage() {
  const { user } = useAuth()
  const publisherId = user?.publisherId
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [serviceFilter, setServiceFilter] = useState("all")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const deferredSearch = useDeferredValue(search.trim().toLowerCase())

  const listingsQ = useQuery({
    queryKey: ["publisher-listings", publisherId],
    queryFn: () => api.marketplace.getPublisherListings(publisherId!),
    enabled: !!publisherId,
  })
  const listings = listingsQ.data ?? []

  const categories = useMemo(() => {
    const values = new Map<string, string>()
    for (const listing of listings) {
      if (listing.category) {
        values.set(listing.category.id, listing.category.name)
      }
    }
    return [...values.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [listings])

  const filteredListings = useMemo(
    () =>
      listings.filter((listing) => {
        const phase = listingPhase(listing)
        const services = listing.services ?? []
        const searchable = [
          listing.title,
          listing.description,
          listing.websiteUrl,
          listing.category?.name,
          ...services.map((service) => serviceLabel(service.serviceType)),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
        const matchesSearch =
          !deferredSearch || searchable.includes(deferredSearch)
        const matchesStatus =
          statusFilter === "all" ||
          (statusFilter === "ACTION_REQUIRED"
            ? [
                "AWAITING_VERIFICATION",
                "AWAITING_SERVICES",
                "READY_FOR_REVIEW",
                "REJECTED",
              ].includes(phase)
            : phase === statusFilter)
        const matchesService =
          serviceFilter === "all" ||
          services.some(
            (service) =>
              service.serviceType === serviceFilter &&
              service.availability !== "PAUSED",
          )
        const matchesCategory =
          categoryFilter === "all" || listing.category?.id === categoryFilter
        return (
          matchesSearch && matchesStatus && matchesService && matchesCategory
        )
      }),
    [categoryFilter, deferredSearch, listings, serviceFilter, statusFilter],
  )

  const stats = useMemo(
    () => ({
      total: listings.filter((listing) => listing.status !== "ARCHIVED").length,
      live: listings.filter((listing) => listingPhase(listing) === "PUBLISHED")
        .length,
      action: listings.filter((listing) =>
        [
          "AWAITING_VERIFICATION",
          "AWAITING_SERVICES",
          "READY_FOR_REVIEW",
          "REJECTED",
        ].includes(listingPhase(listing)),
      ).length,
      availableServices: listings.reduce(
        (total, listing) =>
          total +
          (listing.services ?? []).filter(
            (service) => service.availability === "AVAILABLE",
          ).length,
        0,
      ),
    }),
    [listings],
  )

  const lifecycleMut = useMutation({
    mutationFn: ({
      listingId,
      action,
    }: {
      listingId: string
      action: "submit" | "pause" | "unpause"
    }) => {
      if (action === "submit") return api.marketplace.submitListing(listingId)
      if (action === "pause") return api.marketplace.pauseListing(listingId)
      return api.marketplace.unpauseListing(listingId)
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
      queryClient.invalidateQueries({ queryKey: ["publisher-websites"] })
      toast.success(
        variables.action === "submit"
          ? "Listing submitted for review"
          : variables.action === "pause"
            ? "Listing paused"
            : "Listing is live again",
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const activeFilterCount = [
    statusFilter,
    serviceFilter,
    categoryFilter,
  ].filter((value) => value !== "all").length
  const resetFilters = () => {
    setSearch("")
    setStatusFilter("all")
    setServiceFilter("all")
    setCategoryFilter("all")
  }

  if (listingsQ.isError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center py-14 text-center">
          <AlertCircle className="h-9 w-9 text-destructive" />
          <h2 className="mt-4 text-lg font-semibold">
            Listings could not load
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {(listingsQ.error as Error).message}
          </p>
          <Button
            variant="outline"
            className="mt-5"
            onClick={() => listingsQ.refetch()}
          >
            <RefreshCw className="mr-2 h-4 w-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-blue-600 dark:text-blue-400">
            <Store className="h-4 w-4" /> Publisher marketplace
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Listings</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Review every site&apos;s marketplace readiness, find services
            quickly, and open the website workspace to manage listing details,
            verification, and pricing.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/websites/new">
            <Plus className="mr-2 h-4 w-4" /> Enlist website
          </Link>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Active listings" value={stats.total} Icon={Store} />
        <SummaryCard label="Live" value={stats.live} Icon={CheckCircle2} />
        <SummaryCard
          label="Needs attention"
          value={stats.action}
          Icon={AlertCircle}
        />
        <SummaryCard
          label="Available services"
          value={stats.availableServices}
          Icon={Layers3}
        />
      </div>

      <Card>
        <CardContent className="p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold">
                <SlidersHorizontal className="h-4 w-4" /> Find a listing
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Search titles, domains, descriptions, categories, or services.
              </p>
            </div>
            {(activeFilterCount > 0 || search) && (
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                Reset
              </Button>
            )}
          </div>
          <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(240px,1fr)_180px_180px_180px]">
            <div className="space-y-2">
              <Label htmlFor="publisher-listing-search">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="publisher-listing-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search inventory"
                  className="pl-9 pr-9"
                />
                {search && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setSearch("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            <FilterSelect
              label="Status"
              value={statusFilter}
              onValueChange={setStatusFilter}
              options={[
                ["all", "All statuses"],
                ["ACTION_REQUIRED", "Needs attention"],
                ["PUBLISHED", "Live"],
                ["IN_REVIEW", "In review"],
                ["PAUSED", "Paused"],
                ["ARCHIVED", "Archived"],
              ]}
            />
            <FilterSelect
              label="Service"
              value={serviceFilter}
              onValueChange={setServiceFilter}
              options={[
                ["all", "All services"],
                ...SERVICE_TYPES.map(
                  ([value, label]) => [value, label] as const,
                ),
              ]}
            />
            <FilterSelect
              label="Category"
              value={categoryFilter}
              onValueChange={setCategoryFilter}
              options={[
                ["all", "All categories"],
                ...categories.map(([value, label]) => [value, label] as const),
              ]}
            />
          </div>
        </CardContent>
      </Card>

      {listingsQ.isLoading ? (
        <div className="grid gap-5 lg:grid-cols-2">
          {[1, 2, 3, 4].map((item) => (
            <Skeleton key={item} className="h-96 rounded-2xl" />
          ))}
        </div>
      ) : filteredListings.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Search className="h-9 w-9 text-muted-foreground" />
            <h2 className="mt-4 text-lg font-semibold">No listings match</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Broaden the search or remove a filter to see more publisher
              inventory.
            </p>
            <Button variant="outline" className="mt-5" onClick={resetFilters}>
              Clear search and filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {filteredListings.length} listing
              {filteredListings.length === 1 ? "" : "s"}
            </p>
            <Badge className="border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300">
              Publisher managed
            </Badge>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            {filteredListings.map((listing) => (
              <PublisherListingCard
                key={listing.id}
                listing={listing}
                lifecyclePending={lifecycleMut.isPending}
                onLifecycle={(action) =>
                  lifecycleMut.mutate({ listingId: listing.id, action })
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function SummaryCard({
  label,
  value,
  Icon,
}: {
  label: string
  value: number
  Icon: typeof Store
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-bold">{value}</p>
        </div>
        <div className="rounded-xl bg-blue-50 p-2.5 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300">
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  )
}

function FilterSelect({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string
  value: string
  onValueChange: (value: string) => void
  options: ReadonlyArray<readonly [string, string]>
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>
              {optionLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function PublisherListingCard({
  listing,
  lifecyclePending,
  onLifecycle,
}: {
  listing: MarketplaceListing
  lifecyclePending: boolean
  onLifecycle: (action: "submit" | "pause" | "unpause") => void
}) {
  const phase = listingPhase(listing)
  const phaseInfo = PHASES[phase] ?? {
    label: phase.replace(/_/g, " ").toLowerCase(),
    guidance: "Open the website workspace to manage this listing.",
    tone: "border-border bg-muted text-muted-foreground",
  }
  const services = listing.services ?? []
  const availableServices = services.filter(
    (service) => service.availability === "AVAILABLE",
  )
  const lowestPrice = availableServices
    .map((service) => Number(service.price))
    .sort((a, b) => a - b)[0]

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader className="space-y-4 border-b">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {listing.category && (
                <Badge variant="secondary">{listing.category.name}</Badge>
              )}
              <Badge className={phaseInfo.tone}>{phaseInfo.label}</Badge>
            </div>
            <CardTitle className="mt-3 line-clamp-1 text-xl">
              {listing.title}
            </CardTitle>
            <CardDescription
              className="mt-2 line-clamp-2 min-h-10 leading-5"
              title={listing.description}
            >
              {listing.description}
            </CardDescription>
          </div>
          <Badge className="shrink-0 border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300">
            Publisher
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted px-3 py-1.5">
            <Globe2 className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {listing.websiteUrl ?? "Website unavailable"}
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5">
            <Layers3 className="h-3.5 w-3.5" />
            {availableServices.length} available
          </span>
          {lowestPrice != null && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5">
              <DollarSign className="h-3.5 w-3.5" />
              From {formatMoney(lowestPrice, listing.currency)}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-5 pt-5">
        <div className="rounded-xl border bg-muted/20 p-4">
          <p className="text-sm font-medium">{phaseInfo.label}</p>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {phaseInfo.guidance}
          </p>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Service menu
            </p>
            <span className="text-xs text-muted-foreground">
              {services.length} total
            </span>
          </div>
          {services.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {services.slice(0, 4).map((service) => (
                <span
                  key={service.id}
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
                >
                  {serviceLabel(service.serviceType)}
                  <span
                    className={
                      service.availability === "AVAILABLE"
                        ? "h-1.5 w-1.5 rounded-full bg-emerald-500"
                        : service.availability === "WAITLIST"
                          ? "h-1.5 w-1.5 rounded-full bg-amber-500"
                          : "h-1.5 w-1.5 rounded-full bg-slate-400"
                    }
                  />
                </span>
              ))}
              {services.length > 4 && (
                <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                  +{services.length - 4} more
                </span>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              No services have been configured.
            </p>
          )}
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-4">
          <div className="flex gap-2">
            {phase === "READY_FOR_REVIEW" && (
              <Button
                size="sm"
                disabled={lifecyclePending}
                onClick={() => onLifecycle("submit")}
              >
                <Send className="mr-2 h-3.5 w-3.5" /> Submit
              </Button>
            )}
            {phase === "REJECTED" && (
              <Button
                size="sm"
                variant="outline"
                disabled={lifecyclePending}
                onClick={() => onLifecycle("submit")}
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" /> Resubmit
              </Button>
            )}
            {phase === "PUBLISHED" && (
              <Button
                size="sm"
                variant="outline"
                disabled={lifecyclePending}
                onClick={() => onLifecycle("pause")}
              >
                <Pause className="mr-2 h-3.5 w-3.5" /> Pause
              </Button>
            )}
            {phase === "PAUSED" && (
              <Button
                size="sm"
                variant="outline"
                disabled={lifecyclePending}
                onClick={() => onLifecycle("unpause")}
              >
                Resume
              </Button>
            )}
          </div>
          {listing.websiteId ? (
            <Button size="sm" asChild>
              <Link
                href={`/dashboard/websites/${listing.websiteId}#marketplace`}
              >
                Manage listing & services
                <ArrowRight className="ml-2 h-3.5 w-3.5" />
              </Link>
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled>
              <Archive className="mr-2 h-3.5 w-3.5" /> Website link missing
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
