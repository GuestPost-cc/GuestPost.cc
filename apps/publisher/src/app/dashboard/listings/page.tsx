"use client"

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircle,
  Archive,
  DollarSign,
  Edit3,
  Globe2,
  Layers3,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Store,
  X,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

const SERVICE_TYPES = [
  "GUEST_POST",
  "NICHE_EDIT",
  "EDITORIAL_LINK",
  "OUTREACH_LINK",
  "LOCAL_CITATION",
  "FOUNDATION_LINK",
  "BLOG_ARTICLE",
  "SEO_CONTENT",
] as const

const STATUS_VARIANTS: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  APPROVED: "default",
  PENDING_REVIEW: "secondary",
  DRAFT: "outline",
  REJECTED: "destructive",
  PAUSED: "secondary",
  ARCHIVED: "outline",
  READY_FOR_REVIEW: "secondary",
  PUBLISHED: "default",
  NEEDS_SERVICES: "outline",
  WEBSITE_NOT_VERIFIED: "secondary",
}

const SERVICE_LABELS: Record<string, string> = {
  GUEST_POST: "Guest post",
  NICHE_EDIT: "Niche edit",
  EDITORIAL_LINK: "Editorial link",
  OUTREACH_LINK: "Outreach link",
  LOCAL_CITATION: "Local citation",
  FOUNDATION_LINK: "Foundation link",
  BLOG_ARTICLE: "Blog article",
  SEO_CONTENT: "SEO content",
}

const PHASE_COPY: Record<string, { title: string; description: string }> = {
  NEEDS_SERVICES: {
    title: "Add services",
    description: "Create at least one purchasable service before review.",
  },
  WEBSITE_NOT_VERIFIED: {
    title: "Verify website",
    description: "Website ownership must be verified before this can go live.",
  },
  READY_FOR_REVIEW: {
    title: "Ready for review",
    description: "Submit this listing for marketplace approval.",
  },
  PENDING_REVIEW: {
    title: "In review",
    description: "Our team is checking the listing before publishing.",
  },
  PUBLISHED: {
    title: "Live",
    description: "Buyers can find and order this listing.",
  },
  PAUSED: {
    title: "Paused",
    description: "Hidden from new orders until you unpause it.",
  },
  REJECTED: {
    title: "Needs changes",
    description: "Update the listing and resubmit for review.",
  },
  ARCHIVED: {
    title: "Archived",
    description: "No longer available for new marketplace orders.",
  },
}

function serviceLabel(type: string) {
  return SERVICE_LABELS[type] ?? type.replace(/_/g, " ").toLowerCase()
}

function formatMoney(value: number | string, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value) || 0)
}

function phaseCopy(phase: string) {
  return (
    PHASE_COPY[phase] ?? {
      title: phase.replace(/_/g, " ").toLowerCase(),
      description: "Manage this listing from the actions below.",
    }
  )
}

// Services-tab state. A listing's services live on the listing row itself
// (response includes services[]); per-row writes go through the dedicated
// /listings/:id/services endpoints to avoid bulk-replacing.
type ServiceRow = {
  id: string
  serviceType: string
  price: number
  currency: string
  turnaroundDays: number
  revisionRounds: number
  warrantyDays?: number | null
  availability: "AVAILABLE" | "PAUSED" | "WAITLIST"
  version: number
}

export default function PublisherListingsPage() {
  const { user } = useAuth()
  const publisherId = (user as any)?.publisherId as string | undefined
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [servicesForListing, setServicesForListing] = useState<{
    id: string
    title: string
    services: ServiceRow[]
  } | null>(null)
  const [editingListing, setEditingListing] = useState<{
    id: string
    title: string
    description: string
  } | null>(null)
  const [editingService, setEditingService] = useState<{
    listingId: string
    serviceId: string
    version: number
    price: string
    turnaroundDays: string
    revisionRounds: string
    warrantyDays: string
    currency: string
  } | null>(null)
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )

  useEffect(() => {
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setDebouncedSearch(search)
    }, 300)
    return () => clearTimeout(searchTimer.current)
  }, [search])

  const [form, setForm] = useState({
    title: "",
    description: "",
    websiteId: "",
    addServiceNow: false,
  })
  const [initialService, setInitialService] = useState({
    serviceType: "GUEST_POST",
    price: "",
    turnaroundDays: "7",
    revisionRounds: "2",
  })
  const [newService, setNewService] = useState({
    serviceType: "GUEST_POST",
    price: "",
    turnaroundDays: "7",
    revisionRounds: "2",
    warrantyDays: "",
    currency: "USD",
  })

  const listingsQ = useQuery({
    queryKey: ["publisher-listings", publisherId, debouncedSearch],
    queryFn: () =>
      api.marketplace.getPublisherListings(
        publisherId!,
        debouncedSearch ? debouncedSearch : undefined,
      ),
    enabled: !!publisherId,
  })

  const websitesQ = useQuery({
    queryKey: ["publisher-websites", publisherId],
    queryFn: async () =>
      (await api.publishers.getWebsites(publisherId!)) as any[],
    enabled: !!publisherId && showCreate,
  })

  const createMutation = useMutation({
    mutationFn: () =>
      api.marketplace.createListing({
        title: form.title.trim(),
        description: form.description.trim(),
        websiteId: form.websiteId || undefined,
        // Phase 7: optionally create with the first service inline.
        services: form.addServiceNow
          ? [
              {
                serviceType: initialService.serviceType,
                price: Number(initialService.price),
                turnaroundDays: Number(initialService.turnaroundDays) || 7,
                revisionRounds: Number(initialService.revisionRounds) || 2,
              },
            ]
          : undefined,
      }),
    onSuccess: () => {
      toast.success("Listing created")
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
      setShowCreate(false)
      setForm({
        title: "",
        description: "",
        websiteId: "",
        addServiceNow: false,
      })
      setInitialService({
        serviceType: "GUEST_POST",
        price: "",
        turnaroundDays: "7",
        revisionRounds: "2",
      })
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to create listing"),
  })

  // Service-management mutations (per-row endpoints). All three invalidate
  // the publisher-listings query so the table reflects new state.
  type AddServiceVars = {
    listingId: string
    data: {
      serviceType: string
      price: number
      turnaroundDays: number
      currency?: string
      revisionRounds?: number
      warrantyDays?: number
      availability?: "AVAILABLE" | "PAUSED" | "WAITLIST"
    }
  }
  type UpdateServiceVars = {
    listingId: string
    serviceId: string
    data: {
      version: number
      price?: number
      turnaroundDays?: number
      currency?: string
      revisionRounds?: number
      warrantyDays?: number
      availability?: "AVAILABLE" | "PAUSED" | "WAITLIST"
    }
  }
  const addServiceMut = useMutation({
    mutationFn: (vars: AddServiceVars) =>
      api.marketplace.addListingService(vars.listingId, vars.data),
    onSuccess: (service) => {
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
      setServicesForListing((current) =>
        current
          ? {
              ...current,
              services: [...current.services, service as ServiceRow],
            }
          : current,
      )
      setNewService({
        serviceType: "GUEST_POST",
        price: "",
        turnaroundDays: "7",
        revisionRounds: "2",
        warrantyDays: "",
        currency: "USD",
      })
      toast.success("Service added")
    },
    onError: (e: Error) => toast.error(e.message || "Failed to add service"),
  })
  const updateServiceMut = useMutation({
    mutationFn: (vars: UpdateServiceVars) =>
      api.marketplace.updateListingService(
        vars.listingId,
        vars.serviceId,
        vars.data,
      ),
    onSuccess: (service, vars) => {
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
      setServicesForListing((current) =>
        current?.id === vars.listingId
          ? {
              ...current,
              services: current.services.map((s) =>
                s.id === vars.serviceId ? (service as ServiceRow) : s,
              ),
            }
          : current,
      )
    },
    onError: (e: Error) => toast.error(e.message || "Update failed"),
  })
  const pauseServiceMut = useMutation({
    mutationFn: (vars: { listingId: string; serviceId: string }) =>
      api.marketplace.pauseListingService(vars.listingId, vars.serviceId),
    onSuccess: (service, vars) => {
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
      setServicesForListing((current) =>
        current?.id === vars.listingId
          ? {
              ...current,
              services: current.services.map((s) =>
                s.id === vars.serviceId ? (service as ServiceRow) : s,
              ),
            }
          : current,
      )
      toast.success("Service paused")
    },
    onError: (e: Error) => toast.error(e.message || "Pause failed"),
  })

  // ── Phase 6 lifecycle mutations (publisher-side) ────────────────────────
  // Phase 7.9 #30 — inlined the 4 useMutation calls (was a
  // makeLifecycleMutation factory that wrapped useMutation inside a
  // regular function; technically functioned but violated the
  // rules-of-hooks because the hook is called via a non-hook helper).
  // Each transition refreshes the listings query so the phase badge moves
  // immediately. Errors surface with the server's friendly message
  // (NO_AVAILABLE_SERVICES, WEBSITE_NOT_VERIFIED, etc.).
  function lifecycleOpts(label: string) {
    return {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
        toast.success(label)
      },
      onError: (e: any) => toast.error(e?.message || `${label} failed`),
    }
  }
  const submitMut = useMutation({
    mutationFn: (id: string) => api.marketplace.submitListing(id),
    ...lifecycleOpts("Submitted for review"),
  })
  const pauseMut = useMutation({
    mutationFn: (id: string) => api.marketplace.pauseListing(id),
    ...lifecycleOpts("Listing paused"),
  })
  const unpauseMut = useMutation({
    mutationFn: (id: string) => api.marketplace.unpauseListing(id),
    ...lifecycleOpts("Listing unpaused"),
  })
  const archiveMut = useMutation({
    mutationFn: (id: string) => api.marketplace.archiveListing(id),
    ...lifecycleOpts("Listing archived"),
  })

  // ── Listing metadata edit ─────────────────────────────────────────────
  const updateListingMut = useMutation({
    mutationFn: (vars: { id: string; title: string; description: string }) =>
      api.marketplace.updateListing(vars.id, {
        title: vars.title.trim(),
        description: vars.description.trim(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
      setEditingListing(null)
      toast.success("Listing updated")
    },
    onError: (e: Error) => toast.error(e.message || "Update failed"),
  })

  const listings = (listingsQ.data ?? []) as any[]
  // Websites that already have an active (non-ARCHIVED) listing — block re-selection.
  const takenWebsiteIds = new Set(
    listings
      .filter((l: any) => l.status !== "ARCHIVED" && l.websiteId)
      .map((l: any) => l.websiteId),
  )
  const initialServiceIsValid =
    !form.addServiceNow ||
    (initialService.price.trim().length > 0 && Number(initialService.price) > 0)
  const canSubmit =
    form.title.trim().length >= 3 &&
    form.description.trim().length >= 1 &&
    !!form.websiteId &&
    initialServiceIsValid

  if (listingsQ.error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Failed to load listings</h2>
        <p className="text-muted-foreground mb-4">
          {(listingsQ.error as Error).message}
        </p>
        <Button onClick={() => listingsQ.refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Store className="h-4 w-4" />
            Publisher inventory
          </div>
          <h1 className="text-3xl font-bold tracking-tight">
            Marketplace Listings
          </h1>
          <p className="max-w-2xl text-muted-foreground">
            Package each verified site into simple services buyers can order.
            Draft, price, review, and manage availability from one place.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          New Listing
        </Button>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by title, description, or domain…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 pr-9"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {listingsQ.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-10 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : listings.length === 0 && !debouncedSearch ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="rounded-full bg-muted p-4">
              <Store className="h-10 w-10 text-muted-foreground" />
            </div>
            <h3 className="mt-5 text-xl font-semibold">No listings yet</h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Create your first listing, connect it to a site, and add a service
              such as guest posts or niche edits.
            </p>
            <Button className="mt-5 gap-2" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              Create listing
            </Button>
          </CardContent>
        </Card>
      ) : listings.length === 0 && debouncedSearch ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Search className="mx-auto h-10 w-10 text-muted-foreground" />
            <h3 className="mt-5 text-xl font-semibold">No matching listings</h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              No listings match "{debouncedSearch}". Try a different search
              term.
            </p>
            <Button
              variant="outline"
              className="mt-5 gap-2"
              onClick={() => setSearch("")}
            >
              <X className="h-4 w-4" />
              Clear search
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Active listings */}
          <div className="grid gap-4 lg:grid-cols-2">
            {listings
              .filter((l: any) => l.status !== "ARCHIVED")
              .map((l: any) => {
                const services: ServiceRow[] =
                  (l.services as ServiceRow[] | undefined) ?? []
                const phase: string = l.lifecyclePhase ?? l.status
                const copy = phaseCopy(phase)
                const lowestService = services
                  .filter((s) => s.availability !== "PAUSED")
                  .sort((a, b) => Number(a.price) - Number(b.price))[0]
                const websiteLabel =
                  l.website?.url ?? l.websiteUrl ?? "Site not selected"

                return (
                  <Card key={l.id} className="overflow-hidden">
                    <CardHeader className="space-y-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <CardTitle className="truncate text-xl">
                            {l.title}
                          </CardTitle>
                          <CardDescription className="line-clamp-2">
                            {l.description ||
                              "Add a short buyer-facing description."}
                          </CardDescription>
                        </div>
                        <Badge variant={STATUS_VARIANTS[phase] ?? "secondary"}>
                          {copy.title}
                        </Badge>
                      </div>

                      <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
                          <Globe2 className="h-3.5 w-3.5" />
                          {websiteLabel}
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
                          <Layers3 className="h-3.5 w-3.5" />
                          {services.length} service
                          {services.length === 1 ? "" : "s"}
                        </span>
                        {lowestService && (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
                            <DollarSign className="h-3.5 w-3.5" />
                            From{" "}
                            {formatMoney(
                              lowestService.price,
                              lowestService.currency,
                            )}
                          </span>
                        )}
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-4">
                      <div className="rounded-lg border bg-muted/30 p-4">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 rounded-full bg-background p-2 text-muted-foreground">
                            <Settings2 className="h-4 w-4" />
                          </div>
                          <div className="space-y-1">
                            <p className="text-sm font-medium">{copy.title}</p>
                            <p className="text-sm text-muted-foreground">
                              {copy.description}
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2">
                        {services.length === 0 ? (
                          <button
                            type="button"
                            onClick={() =>
                              setServicesForListing({
                                id: l.id,
                                title: l.title,
                                services,
                              })
                            }
                            className="flex w-full items-center justify-between rounded-lg border border-dashed p-4 text-left transition hover:bg-muted/50"
                          >
                            <span>
                              <span className="block text-sm font-medium">
                                Add your first service
                              </span>
                              <span className="text-sm text-muted-foreground">
                                Buyers need a service and price before review.
                              </span>
                            </span>
                            <Plus className="h-4 w-4 text-muted-foreground" />
                          </button>
                        ) : (
                          services.slice(0, 3).map((s) => (
                            <div
                              key={s.id}
                              className="flex items-center justify-between rounded-lg border p-3"
                            >
                              <div>
                                <p className="text-sm font-medium">
                                  {serviceLabel(s.serviceType)}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {s.turnaroundDays} days · {s.revisionRounds}{" "}
                                  revisions
                                </p>
                              </div>
                              <div className="text-right">
                                <p className="text-sm font-semibold">
                                  {formatMoney(s.price, s.currency)}
                                </p>
                                <Badge variant="outline" className="mt-1">
                                  {s.availability.toLowerCase()}
                                </Badge>
                              </div>
                            </div>
                          ))
                        )}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
                        <div className="flex flex-wrap gap-2">
                          {phase === "READY_FOR_REVIEW" && (
                            <Button
                              size="sm"
                              onClick={() => submitMut.mutate(l.id)}
                              disabled={submitMut.isPending}
                              className="gap-2"
                            >
                              <Send className="h-3.5 w-3.5" />
                              Submit for review
                            </Button>
                          )}
                          {phase === "PUBLISHED" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => pauseMut.mutate(l.id)}
                              disabled={pauseMut.isPending}
                            >
                              Pause
                            </Button>
                          )}
                          {phase === "PAUSED" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => unpauseMut.mutate(l.id)}
                              disabled={unpauseMut.isPending}
                            >
                              Unpause
                            </Button>
                          )}
                          {l.status === "REJECTED" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => submitMut.mutate(l.id)}
                              disabled={submitMut.isPending}
                            >
                              Resubmit
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setServicesForListing({
                                id: l.id,
                                title: l.title,
                                services,
                              })
                            }
                            className="gap-2"
                          >
                            <Layers3 className="h-3.5 w-3.5" />
                            Services
                          </Button>
                        </div>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setEditingListing({
                                id: l.id,
                                title: l.title,
                                description: l.description ?? "",
                              })
                            }
                            className="gap-2"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            Edit
                          </Button>
                          {phase !== "ARCHIVED" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                if (
                                  confirm(
                                    "Archive this listing? Existing orders are untouched.",
                                  )
                                )
                                  archiveMut.mutate(l.id)
                              }}
                              disabled={archiveMut.isPending}
                              className="gap-2 text-muted-foreground"
                            >
                              <Archive className="h-3.5 w-3.5" />
                              Archive
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
          </div>

          {/* Archived listings */}
          {listings.filter((l: any) => l.status === "ARCHIVED").length > 0 && (
            <>
              <div className="flex items-center gap-2 pt-4">
                <Archive className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground">
                  Archived (
                  {listings.filter((l: any) => l.status === "ARCHIVED").length})
                </h2>
                <div className="flex-1 border-t" />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                {listings
                  .filter((l: any) => l.status === "ARCHIVED")
                  .map((l: any) => {
                    const services: ServiceRow[] =
                      (l.services as ServiceRow[] | undefined) ?? []
                    const phase: string = l.lifecyclePhase ?? l.status
                    const copy = phaseCopy(phase)
                    const lowestService = services
                      .filter((s) => s.availability !== "PAUSED")
                      .sort((a, b) => Number(a.price) - Number(b.price))[0]
                    const websiteLabel =
                      l.website?.url ?? l.websiteUrl ?? "Site not selected"

                    return (
                      <Card key={l.id} className="overflow-hidden">
                        <CardHeader className="space-y-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 space-y-1">
                              <CardTitle className="truncate text-xl">
                                {l.title}
                              </CardTitle>
                              <CardDescription className="line-clamp-2">
                                {l.description ||
                                  "Add a short buyer-facing description."}
                              </CardDescription>
                            </div>
                            <Badge
                              variant={STATUS_VARIANTS[phase] ?? "secondary"}
                            >
                              {copy.title}
                            </Badge>
                          </div>

                          <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
                              <Globe2 className="h-3.5 w-3.5" />
                              {websiteLabel}
                            </span>
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
                              <Layers3 className="h-3.5 w-3.5" />
                              {services.length} service
                              {services.length === 1 ? "" : "s"}
                            </span>
                            {lowestService && (
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
                                <DollarSign className="h-3.5 w-3.5" />
                                From{" "}
                                {formatMoney(
                                  lowestService.price,
                                  lowestService.currency,
                                )}
                              </span>
                            )}
                          </div>
                        </CardHeader>

                        <CardContent className="space-y-4">
                          <div className="rounded-lg border bg-muted/30 p-4">
                            <div className="flex items-start gap-3">
                              <div className="mt-0.5 rounded-full bg-background p-2 text-muted-foreground">
                                <Settings2 className="h-4 w-4" />
                              </div>
                              <div className="space-y-1">
                                <p className="text-sm font-medium">
                                  {copy.title}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  {copy.description}
                                </p>
                              </div>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                onClick={() => submitMut.mutate(l.id)}
                                disabled={submitMut.isPending}
                                className="gap-2"
                              >
                                <Send className="h-3.5 w-3.5" />
                                Resubmit for review
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  setServicesForListing({
                                    id: l.id,
                                    title: l.title,
                                    services,
                                  })
                                }
                                className="gap-2"
                              >
                                <Layers3 className="h-3.5 w-3.5" />
                                Services
                              </Button>
                            </div>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setEditingListing({
                                    id: l.id,
                                    title: l.title,
                                    description: l.description ?? "",
                                  })
                                }
                                className="gap-2"
                              >
                                <Edit3 className="h-3.5 w-3.5" />
                                Edit
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )
                  })}
              </div>
            </>
          )}
        </>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Create marketplace listing</DialogTitle>
            <DialogDescription>
              Start with the site and buyer-facing offer. You can publish after
              services are priced and the listing is reviewed.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
            <div className="space-y-5">
              <div className="rounded-xl border p-4">
                <div className="mb-4 flex items-center gap-2">
                  <div className="rounded-full bg-muted p-2">
                    <Globe2 className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">Listing basics</h3>
                    <p className="text-xs text-muted-foreground">
                      This is what buyers see in the marketplace.
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="l-title">Listing title</Label>
                    <Input
                      id="l-title"
                      value={form.title}
                      onChange={(e) =>
                        setForm({ ...form, title: e.target.value })
                      }
                      placeholder="Guest post on example.com"
                      maxLength={200}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="l-desc">Description</Label>
                    <Textarea
                      id="l-desc"
                      value={form.description}
                      onChange={(e) =>
                        setForm({ ...form, description: e.target.value })
                      }
                      placeholder="Describe the placement, accepted niches, content policy, and what is included."
                      rows={4}
                      maxLength={1000}
                    />
                    <p className="text-xs text-muted-foreground">
                      {form.description.length}/1000 characters
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Website</Label>
                    <Select
                      value={form.websiteId}
                      onValueChange={(v) => setForm({ ...form, websiteId: v })}
                    >
                      <SelectTrigger>
                        <SelectValue
                          placeholder={
                            websitesQ.isLoading
                              ? "Loading sites..."
                              : "Select a site"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {(websitesQ.data ?? [])
                          .filter((w: any) => !takenWebsiteIds.has(w.id))
                          .map((w: any) => (
                            <SelectItem key={w.id} value={w.id}>
                              {w.url}
                            </SelectItem>
                          ))}
                        {websitesQ.data &&
                          websitesQ.data.length > 0 &&
                          (websitesQ.data ?? []).every((w: any) =>
                            takenWebsiteIds.has(w.id),
                          ) && (
                            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                              All websites already have a listing.
                            </div>
                          )}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Use the website where this service will be fulfilled.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex gap-2">
                    <div className="rounded-full bg-muted p-2">
                      <Layers3 className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold">First service</h3>
                      <p className="text-xs text-muted-foreground">
                        Optional, but required before review.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="l-add-service"
                      checked={form.addServiceNow}
                      onCheckedChange={(v) =>
                        setForm({ ...form, addServiceNow: v === true })
                      }
                    />
                    <Label
                      htmlFor="l-add-service"
                      className="text-sm font-normal"
                    >
                      Add now
                    </Label>
                  </div>
                </div>

                {form.addServiceNow && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2 sm:col-span-2">
                      <Label>Service type</Label>
                      <Select
                        value={initialService.serviceType}
                        onValueChange={(v) =>
                          setInitialService({
                            ...initialService,
                            serviceType: v,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SERVICE_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {serviceLabel(t)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Price (USD)</Label>
                      <Input
                        type="number"
                        min={1}
                        step="0.01"
                        value={initialService.price}
                        onChange={(e) =>
                          setInitialService({
                            ...initialService,
                            price: e.target.value,
                          })
                        }
                        placeholder="250"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Turnaround</Label>
                      <Input
                        type="number"
                        min={1}
                        value={initialService.turnaroundDays}
                        onChange={(e) =>
                          setInitialService({
                            ...initialService,
                            turnaroundDays: e.target.value,
                          })
                        }
                        placeholder="7"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Revision rounds</Label>
                      <Input
                        type="number"
                        min={0}
                        value={initialService.revisionRounds}
                        onChange={(e) =>
                          setInitialService({
                            ...initialService,
                            revisionRounds: e.target.value,
                          })
                        }
                        placeholder="2"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Listing checklist</h3>
              <div className="mt-4 space-y-3 text-sm">
                <div className="flex items-start gap-2">
                  <Badge
                    variant={
                      form.title.trim().length >= 3 ? "default" : "outline"
                    }
                  >
                    1
                  </Badge>
                  <div>
                    <p className="font-medium">Clear title</p>
                    <p className="text-xs text-muted-foreground">
                      Name the site or service clearly.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <Badge variant={form.websiteId ? "default" : "outline"}>
                    2
                  </Badge>
                  <div>
                    <p className="font-medium">Website selected</p>
                    <p className="text-xs text-muted-foreground">
                      Choose the site this listing represents.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <Badge
                    variant={form.description.trim() ? "default" : "outline"}
                  >
                    3
                  </Badge>
                  <div>
                    <p className="font-medium">Buyer description</p>
                    <p className="text-xs text-muted-foreground">
                      Explain deliverables and requirements.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <Badge
                    variant={
                      form.addServiceNow && initialServiceIsValid
                        ? "default"
                        : "outline"
                    }
                  >
                    4
                  </Badge>
                  <div>
                    <p className="font-medium">Priced service</p>
                    <p className="text-xs text-muted-foreground">
                      Add now or manage services after creation.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!canSubmit || createMutation.isPending}
            >
              {createMutation.isPending
                ? "Creating..."
                : form.addServiceNow
                  ? "Create with service"
                  : "Create listing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        Edit listing dialog — title/description edits. Sends a PUT to
        /marketplace/listings/:id (backend updateListing).
      */}
      <Dialog
        open={!!editingListing}
        onOpenChange={(v) => {
          if (!v) setEditingListing(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit listing details</DialogTitle>
            <DialogDescription>
              Update the buyer-facing title and description. Services and prices
              are managed separately.
            </DialogDescription>
          </DialogHeader>
          {editingListing && (
            <div className="space-y-4 rounded-xl border p-4">
              <div className="space-y-2">
                <Label>Listing title</Label>
                <Input
                  value={editingListing.title}
                  onChange={(e) =>
                    setEditingListing({
                      ...editingListing,
                      title: e.target.value,
                    })
                  }
                  maxLength={200}
                />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={editingListing.description}
                  onChange={(e) =>
                    setEditingListing({
                      ...editingListing,
                      description: e.target.value,
                    })
                  }
                  rows={5}
                  maxLength={1000}
                />
                <p className="text-xs text-muted-foreground">
                  {editingListing.description.length}/1000 characters
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingListing(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                editingListing &&
                updateListingMut.mutate({
                  id: editingListing.id,
                  title: editingListing.title,
                  description: editingListing.description,
                })
              }
              disabled={
                updateListingMut.isPending ||
                !editingListing?.title.trim() ||
                !editingListing?.description.trim()
              }
            >
              {updateListingMut.isPending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        Services dialog — card-based service management. Each service is a
        compact card with inline editing. A footer section handles adding new
        services. Version-guarded PATCH; concurrent edits get a 409.
      */}
      <Dialog
        open={!!servicesForListing}
        onOpenChange={(v) => {
          if (!v) {
            setServicesForListing(null)
            setEditingService(null)
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Services</DialogTitle>
            <DialogDescription>
              Manage services on “{servicesForListing?.title}”. Each service is
              a separate offering — buyers pick one at checkout. Edits never
              affect in-flight orders.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {servicesForListing?.services.length === 0 ? (
              <div className="rounded-xl border border-dashed p-10 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                  <Layers3 className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium">No services yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add your first service below. At least one is needed before
                  the listing can be reviewed.
                </p>
              </div>
            ) : (
              <div className="grid gap-3">
                {servicesForListing?.services.map((s) => {
                  const isEditing =
                    editingService?.listingId === servicesForListing.id &&
                    editingService?.serviceId === s.id
                  return (
                    <div key={s.id} className="rounded-xl border p-4">
                      {isEditing ? (
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <h4 className="text-sm font-semibold">
                              {serviceLabel(s.serviceType)}
                            </h4>
                            <Badge variant="outline">v{s.version}</Badge>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-4">
                            <div className="space-y-1">
                              <Label className="text-xs">
                                Price ({editingService?.currency ?? "USD"})
                              </Label>
                              <Input
                                type="number"
                                min={0}
                                step="0.01"
                                value={editingService!.price}
                                onChange={(e) =>
                                  setEditingService({
                                    ...editingService!,
                                    price: e.target.value,
                                  })
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">
                                Turnaround (days)
                              </Label>
                              <Input
                                type="number"
                                min={1}
                                value={editingService!.turnaroundDays}
                                onChange={(e) =>
                                  setEditingService({
                                    ...editingService!,
                                    turnaroundDays: e.target.value,
                                  })
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Revisions</Label>
                              <Input
                                type="number"
                                min={0}
                                value={editingService!.revisionRounds}
                                onChange={(e) =>
                                  setEditingService({
                                    ...editingService!,
                                    revisionRounds: e.target.value,
                                  })
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Warranty (days)</Label>
                              <Input
                                type="number"
                                min={0}
                                value={editingService!.warrantyDays}
                                onChange={(e) =>
                                  setEditingService({
                                    ...editingService!,
                                    warrantyDays: e.target.value,
                                  })
                                }
                              />
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <Select
                              value={editingService!.currency}
                              onValueChange={(v) =>
                                setEditingService({
                                  ...editingService!,
                                  currency: v,
                                })
                              }
                            >
                              <SelectTrigger className="h-8 w-20">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="USD">USD</SelectItem>
                                <SelectItem value="EUR">EUR</SelectItem>
                                <SelectItem value="GBP">GBP</SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                onClick={() => {
                                  const p = editingService!
                                  updateServiceMut.mutate({
                                    listingId: servicesForListing!.id,
                                    serviceId: s.id,
                                    data: {
                                      version: s.version,
                                      price: Number(p.price),
                                      turnaroundDays: Number(p.turnaroundDays),
                                      revisionRounds: Number(p.revisionRounds),
                                      warrantyDays: p.warrantyDays
                                        ? Number(p.warrantyDays)
                                        : undefined,
                                      currency: p.currency,
                                    },
                                  })
                                  setEditingService(null)
                                }}
                                disabled={updateServiceMut.isPending}
                              >
                                Save
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingService(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4">
                            <div className="rounded-full bg-muted p-2">
                              <Layers3 className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <div>
                              <p className="text-sm font-medium">
                                {serviceLabel(s.serviceType)}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {s.turnaroundDays}d · {s.revisionRounds}{" "}
                                revisions
                                {s.warrantyDays
                                  ? ` · ${s.warrantyDays}d warranty`
                                  : ""}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <Select
                              value={s.availability}
                              onValueChange={(v) =>
                                updateServiceMut.mutate({
                                  listingId: servicesForListing!.id,
                                  serviceId: s.id,
                                  data: {
                                    version: s.version,
                                    availability: v as
                                      | "AVAILABLE"
                                      | "PAUSED"
                                      | "WAITLIST",
                                  },
                                })
                              }
                            >
                              <SelectTrigger className="h-8 w-[110px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="AVAILABLE">
                                  Available
                                </SelectItem>
                                <SelectItem value="PAUSED">Paused</SelectItem>
                                <SelectItem value="WAITLIST">
                                  Waitlist
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <p className="min-w-[72px] text-right text-sm font-semibold">
                              {formatMoney(s.price, s.currency)}
                            </p>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setEditingService({
                                  listingId: servicesForListing!.id,
                                  serviceId: s.id,
                                  version: s.version,
                                  price: String(s.price),
                                  turnaroundDays: String(s.turnaroundDays),
                                  revisionRounds: String(s.revisionRounds),
                                  warrantyDays:
                                    s.warrantyDays != null
                                      ? String(s.warrantyDays)
                                      : "",
                                  currency: s.currency ?? "USD",
                                })
                              }
                            >
                              <Edit3 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            <div className="rounded-xl border border-dashed p-4">
              <div className="flex items-center gap-2">
                <Layers3 className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium">Add a service</p>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-4">
                <div className="space-y-1">
                  <Label className="text-xs">Type</Label>
                  <Select
                    value={newService.serviceType}
                    onValueChange={(v) =>
                      setNewService({ ...newService, serviceType: v })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SERVICE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {serviceLabel(t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Price</Label>
                  <Input
                    type="number"
                    min={1}
                    step="0.01"
                    placeholder="250"
                    value={newService.price}
                    onChange={(e) =>
                      setNewService({ ...newService, price: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Turnaround (days)</Label>
                  <Input
                    type="number"
                    min={1}
                    placeholder="7"
                    value={newService.turnaroundDays}
                    onChange={(e) =>
                      setNewService({
                        ...newService,
                        turnaroundDays: e.target.value,
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Revisions</Label>
                  <Input
                    type="number"
                    min={0}
                    placeholder="2"
                    value={newService.revisionRounds}
                    onChange={(e) =>
                      setNewService({
                        ...newService,
                        revisionRounds: e.target.value,
                      })
                    }
                  />
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Label className="text-xs">Currency</Label>
                  <Select
                    value={newService.currency}
                    onValueChange={(v) =>
                      setNewService({ ...newService, currency: v })
                    }
                  >
                    <SelectTrigger className="h-8 w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="EUR">EUR</SelectItem>
                      <SelectItem value="GBP">GBP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="sm"
                  disabled={
                    !servicesForListing ||
                    !newService.price ||
                    Number(newService.price) <= 0 ||
                    addServiceMut.isPending
                  }
                  onClick={() => {
                    if (!servicesForListing) return
                    addServiceMut.mutate({
                      listingId: servicesForListing.id,
                      data: {
                        serviceType: newService.serviceType,
                        price: Number(newService.price),
                        turnaroundDays: Number(newService.turnaroundDays) || 7,
                        revisionRounds: Number(newService.revisionRounds) || 2,
                        warrantyDays: newService.warrantyDays
                          ? Number(newService.warrantyDays)
                          : undefined,
                        currency: newService.currency,
                      },
                    })
                  }}
                >
                  {addServiceMut.isPending ? "Adding..." : "Add service"}
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setServicesForListing(null)
                setEditingService(null)
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
