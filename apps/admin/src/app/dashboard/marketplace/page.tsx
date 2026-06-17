"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { Card, CardContent, CardHeader, CardTitle, ErrorState } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Badge, StatusBadge, getListingStatusPresentation } from "@guestpost/ui"
import type { ListingStatus } from "@guestpost/database"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guestpost/ui"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@guestpost/ui"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import {
  Store,
  Star,
  Eye,
  CheckCircle,
  XCircle,
  MoreVertical,
  ToggleLeft,
  ToggleRight,
  Flag,
  Search,
  Filter,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react"
import { format } from "date-fns"
import { toast } from "sonner"
import { flexRender } from "@tanstack/react-table"

// Listing-service row (Phase 2). Mirrors the API response; staff view shows
// ALL availability values (not just AVAILABLE) so reviewers can spot paused
// rows during moderation.
interface ListingServiceRow {
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

interface Listing {
  id: string
  title: string
  slug: string
  // Phase 7: type / price are LEGACY listing-level columns scheduled for
  // drop. Prefer priceFrom + serviceTypes[] + services[].
  type?: string
  status: string
  price?: number
  priceFrom?: number | null
  serviceTypes?: string[]
  currency: string
  domainRating?: number
  traffic?: number
  featured: boolean
  verified: boolean
  category?: { name: string }
  organization?: { name: string }
  publisher?: { name: string }
  websiteVerificationStatus?: string | null
  websiteVerifiedAt?: string | null
  websiteDomain?: string | null
  createdAt: string
  ownerType?: "PUBLISHER" | "PLATFORM"
  services?: ListingServiceRow[]
}

const verifyBadge: Record<string, string> = {
  VERIFIED: "bg-green-100 text-green-800",
  PENDING_VERIFICATION: "bg-yellow-100 text-yellow-800",
  VERIFICATION_FAILED: "bg-red-100 text-red-800",
  REVOKED: "bg-red-100 text-red-800",
}

// Phase 7.9 #28 — ListingStatus colors come from the centralized table.
// `verifyBadge` above maps the WebsiteVerificationStatus enum (a different
// enum, not in scope for the Phase 7.9 sweep — kept inline for now).

const LISTING_TYPES = ["GUEST_POST", "NICHE_EDIT", "EDITORIAL_LINK", "SPONSORED_CONTENT", "DIGITAL_PR", "BLOG_ARTICLE", "SEO_CONTENT"] as const

export default function AdminMarketplacePage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [page, setPage] = useState(1)
  // Moderation + platform-listing creation are SUPER_ADMIN/OPERATIONS
  const canManage = user?.staffRole === "SUPER_ADMIN" || user?.staffRole === "OPERATIONS"
  const [showCreate, setShowCreate] = useState(false)
  const [pform, setPform] = useState({ title: "", description: "", type: "GUEST_POST", price: "", websiteId: "" })

  const platformWebsitesQ = useQuery({
    queryKey: ["admin", "platform-websites"],
    queryFn: () => api.admin.listPlatformWebsites(),
    enabled: showCreate,
  })

  const createPlatformMutation = useMutation({
    mutationFn: () =>
      api.admin.createPlatformListing({
        title: pform.title.trim(),
        description: pform.description.trim(),
        type: pform.type,
        price: Number(pform.price),
        websiteId: pform.websiteId || undefined,
        status: "APPROVED",
      }),
    onSuccess: () => {
      toast.success("Platform listing created")
      queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
      setShowCreate(false)
      setPform({ title: "", description: "", type: "GUEST_POST", price: "", websiteId: "" })
    },
    onError: (e: Error) => toast.error(e.message || "Failed to create platform listing"),
  })
  const canSubmitPlatform = pform.title.trim().length >= 3 && pform.description.trim().length >= 1 && Number(pform.price) > 0

  const { data, isLoading, error: listingsError } = useQuery({
    queryKey: ["admin-marketplace-listings", page, statusFilter, typeFilter],
    queryFn: async () => {
      const params: any = { page, limit: 20 }
      if (statusFilter !== "all") params.status = statusFilter
      if (typeFilter !== "all") params.type = typeFilter
      const res = await api.admin.listMarketplaceListings(params)
      return res
    },
  })

  const { data: stats, error: statsError } = useQuery({
    queryKey: ["admin-marketplace-stats"],
    queryFn: async () => {
      const res = await api.admin.getMarketplaceStats()
      return res
    },
  })

  const queryError = listingsError || statsError
  const isSuperAdmin = user?.staffRole === "SUPER_ADMIN"

  const updateStatus = useMutation({
    mutationFn: ({ id, status, force }: { id: string; status: string; force?: boolean }) =>
      api.admin.updateListingStatus(id, status, force),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
      toast.success("Listing status updated")
    },
    onError: (err: any) => {
      // API blocks approval of listings whose website isn't VERIFIED.
      const body = err?.response?.body || err?.body || err
      const code = body?.code || body?.message?.code
      if (code === "WEBSITE_NOT_VERIFIED" || String(err?.message).includes("WEBSITE_NOT_VERIFIED")) {
        toast.error("Domain not verified — publisher must verify ownership before this listing can be approved.")
      } else {
        toast.error(err?.message || "Failed to update status")
      }
    },
  })

  const toggleFeatured = useMutation({
    mutationFn: ({ id, featured }: { id: string; featured: boolean }) =>
      api.admin.toggleListingFeatured(id, featured),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
      toast.success("Featured status updated")
    },
    onError: () => toast.error("Failed to update featured status"),
  })

  const toggleVerified = useMutation({
    mutationFn: ({ id, verified }: { id: string; verified: boolean }) =>
      api.admin.toggleListingVerified(id, verified),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
      toast.success("Verified status updated")
    },
    onError: () => toast.error("Failed to update verified status"),
  })

  const deleteListing = useMutation({
    mutationFn: (id: string) => api.admin.deleteListing(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
      toast.success("Listing deleted")
    },
    onError: () => toast.error("Failed to delete listing"),
  })

  // ── Per-service management for the listing under review ────────────────
  // Same UX as publisher Services dialog (apps/publisher/listings) but
  // routed through admin endpoints. assertListingWriteAccess on the server
  // skips the publisher-membership check for staff actors.
  type AdminService = {
    listingId: string
    serviceId: string
    data: {
      version: number
      price?: number
      turnaroundDays?: number
      availability?: "AVAILABLE" | "PAUSED" | "WAITLIST"
    }
  }
  const [servicesForListing, setServicesForListing] = useState<{ id: string; title: string; services: ListingServiceRow[] } | null>(null)
  const [newAdminService, setNewAdminService] = useState({ serviceType: "GUEST_POST", price: "", turnaroundDays: "7", revisionRounds: "2" })

  const addAdminServiceMut = useMutation({
    mutationFn: (vars: { listingId: string; data: { serviceType: string; price: number; turnaroundDays: number; revisionRounds?: number } }) =>
      api.marketplace.addPlatformListingService(vars.listingId, vars.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
      setNewAdminService({ serviceType: "GUEST_POST", price: "", turnaroundDays: "7", revisionRounds: "2" })
      toast.success("Service added")
    },
    onError: (e: Error) => toast.error(e.message || "Failed to add service"),
  })
  const updateAdminServiceMut = useMutation({
    mutationFn: (vars: AdminService) =>
      api.marketplace.updatePlatformListingService(vars.listingId, vars.serviceId, vars.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] }),
    onError: (e: Error) => toast.error(e.message || "Update failed"),
  })
  const pauseAdminServiceMut = useMutation({
    mutationFn: (vars: { listingId: string; serviceId: string }) =>
      api.marketplace.pausePlatformListingService(vars.listingId, vars.serviceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
      toast.success("Service paused")
    },
    onError: (e: Error) => toast.error(e.message || "Pause failed"),
  })

  function formatPrice(price: number, currency: string = "USD") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(price)
  }

  // Phase 7.9 #30 — early returns moved AFTER all hook calls (was before
  // 9 hooks at line 168 pre-fix, which violates rules-of-hooks: on the
  // queryError render the later hooks would be skipped, breaking React's
  // hook-ordering invariant).
  if (queryError) {
    return (
      <ErrorState
        title="Failed to load marketplace"
        description={queryError instanceof Error ? queryError.message : "An unexpected error occurred"}
        onRetry={() => {
          queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
          queryClient.invalidateQueries({ queryKey: ["admin-marketplace-stats"] })
        }}
      />
    )
  }

  const listings = data?.listings || []
  const pagination = data?.pagination || { page: 1, totalPages: 0, total: 0 }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Marketplace Management</h1>
          <p className="text-muted-foreground">Publisher and platform-owned listings</p>
        </div>
        {canManage && (
          <Button onClick={() => setShowCreate(true)}>
            <Store className="mr-2 h-4 w-4" />
            New Platform Listing
          </Button>
        )}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Platform Listing</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Platform-owned listing fulfilled by your team (no publisher). Attach an optional platform website.
          </p>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Title</label>
              <Input value={pform.title} onChange={(e) => setPform({ ...pform, title: e.target.value })} maxLength={200} placeholder="e.g. Premium editorial placement" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Description</label>
              <Input value={pform.description} onChange={(e) => setPform({ ...pform, description: e.target.value })} maxLength={1000} placeholder="What the buyer gets" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Type</label>
                <Select value={pform.type} onValueChange={(v) => setPform({ ...pform, type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LISTING_TYPES.map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Price (USD)</label>
                <Input type="number" min={1} step="0.01" value={pform.price} onChange={(e) => setPform({ ...pform, price: e.target.value })} placeholder="500" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Platform website (optional)</label>
              <Select value={pform.websiteId || "none"} onValueChange={(v) => setPform({ ...pform, websiteId: v === "none" ? "" : v })}>
                <SelectTrigger>
                  <SelectValue placeholder={platformWebsitesQ.isLoading ? "Loading..." : "No website (service listing)"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No website (service listing)</SelectItem>
                  {(platformWebsitesQ.data ?? []).map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name ?? w.url}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Only platform-owned websites are selectable. Create them under Websites.</p>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={() => createPlatformMutation.mutate()} disabled={!canSubmitPlatform || createPlatformMutation.isPending}>
              {createPlatformMutation.isPending ? "Creating..." : "Create Listing"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Listings</CardTitle>
            <Store className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalListings || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.activeListings || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Reviews</CardTitle>
            <Star className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalReviews || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Avg Rating</CardTitle>
            <Star className="h-4 w-4 text-yellow-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.avgRating ? stats.avgRating.toFixed(1) : "N/A"}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search listings..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1) }}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
              <SelectItem value="PENDING_REVIEW">Pending Review</SelectItem>
              <SelectItem value="PAUSED">Paused</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
              <SelectItem value="ARCHIVED">Archived</SelectItem>
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(1) }}>
            <SelectTrigger className="w-[180px]">
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
        </div>
      </div>

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[300px]">Listing</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Domain</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>DR</TableHead>
              <TableHead>Featured</TableHead>
              <TableHead>Verified</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 10 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : listings.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                  No listings found
                </TableCell>
              </TableRow>
            ) : (
              listings.map((listing: Listing) => (
                <TableRow key={listing.id}>
                  <TableCell>
                    <div>
                      <div className="font-medium">{listing.title}</div>
                      <div className="text-sm text-muted-foreground">{listing.slug}</div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {/* Phase 7: prefer the first AVAILABLE service. */}
                    <Badge variant="outline">{(((listing as any).serviceTypes?.[0]) ?? listing.type ?? "").replace(/_/g, " ")}</Badge>
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const p = getListingStatusPresentation(listing.status as ListingStatus)
                      return <StatusBadge variant={p.variant}>{p.label}</StatusBadge>
                    })()}
                  </TableCell>
                  <TableCell>
                    {listing.websiteVerificationStatus ? (
                      <Badge
                        className={verifyBadge[listing.websiteVerificationStatus] || "bg-gray-100"}
                        title={listing.websiteDomain ?? undefined}
                      >
                        {listing.websiteVerificationStatus.replace("_VERIFICATION", "").replace("_", " ")}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">Platform</span>
                    )}
                  </TableCell>
                  <TableCell>{formatPrice((listing as any).priceFrom ?? listing.price ?? 0, listing.currency)}</TableCell>
                  <TableCell>{listing.domainRating || "-"}</TableCell>
                  <TableCell>
                    {listing.featured ? (
                      <ToggleRight className="h-5 w-5 text-primary" />
                    ) : (
                      <ToggleLeft
                        className="h-5 w-5 text-muted-foreground cursor-pointer"
                        onClick={() => toggleFeatured.mutate({ id: listing.id, featured: true })}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    {listing.verified ? (
                      <ShieldCheck className="h-5 w-5 text-green-500" />
                    ) : (
                      <XCircle className="h-5 w-5 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell>{format(new Date(listing.createdAt), "MMM d, yyyy")}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() =>
                            toggleFeatured.mutate({
                              id: listing.id,
                              featured: !listing.featured,
                            })
                          }
                        >
                          {listing.featured ? "Remove Featured" : "Mark Featured"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            toggleVerified.mutate({
                              id: listing.id,
                              verified: !listing.verified,
                            })
                          }
                        >
                          {listing.verified ? "Remove Verified" : "Mark Verified"}
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          {/* In-app preview of the public page (staff cannot
                              enter the customer portal) + moderation actions */}
                          <a href={`/dashboard/marketplace/${listing.slug}`}>
                            View Public Page
                          </a>
                        </DropdownMenuItem>
                        {/* Manage services — visible for all listings; the
                            server enforces staff-only for PUBLISHER-owned
                            (admin can edit any listing's services from here). */}
                        <DropdownMenuItem
                          onClick={() => setServicesForListing({
                            id: listing.id,
                            title: listing.title,
                            services: listing.services ?? [],
                          })}
                        >
                          Manage Services ({listing.services?.length ?? 0})
                        </DropdownMenuItem>
                        {listing.status !== "ARCHIVED" && (
                          <>
                            {(() => {
                              const blocked =
                                !!listing.websiteVerificationStatus &&
                                listing.websiteVerificationStatus !== "VERIFIED"
                              if (blocked) {
                                return (
                                  <>
                                    <DropdownMenuItem disabled className="text-muted-foreground">
                                      Approve (domain not verified)
                                    </DropdownMenuItem>
                                    {isSuperAdmin && (
                                      <DropdownMenuItem
                                        className="text-amber-600"
                                        onClick={() => {
                                          if (
                                            confirm(
                                              "Emergency override: approve this listing even though the domain is NOT verified? This is audited.",
                                            )
                                          ) {
                                            updateStatus.mutate({ id: listing.id, status: "APPROVED", force: true })
                                          }
                                        }}
                                      >
                                        Force approve (emergency)
                                      </DropdownMenuItem>
                                    )}
                                  </>
                                )
                              }
                              return (
                                <DropdownMenuItem
                                  onClick={() => updateStatus.mutate({ id: listing.id, status: "APPROVED" })}
                                >
                                  Approve
                                </DropdownMenuItem>
                              )
                            })()}
                            <DropdownMenuItem
                              onClick={() =>
                                updateStatus.mutate({
                                  id: listing.id,
                                  status: "REJECTED",
                                })
                              }
                            >
                              Reject
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                updateStatus.mutate({
                                  id: listing.id,
                                  status: "PAUSED",
                                })
                              }
                            >
                              Pause / Suspend
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => deleteListing.mutate(listing.id)}
                            >
                              Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <Button
            variant="outline"
            disabled={page === pagination.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      {/*
        Admin Services dialog. Same shape as the publisher version but routes
        through the staff-gated /admin/marketplace/listings/:id/services
        endpoints. Pause is soft (PAUSED), preserving historical orders'
        listingServiceId references.
      */}
      <Dialog open={!!servicesForListing} onOpenChange={(v) => { if (!v) setServicesForListing(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Services on “{servicesForListing?.title}”</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Per-service prices, turnarounds, and availability. Pausing a service keeps it linked to historical orders.
          </p>
          <div className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>TAT</TableHead>
                  <TableHead>Availability</TableHead>
                  <TableHead className="text-right"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servicesForListing?.services.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-6">No services configured yet.</TableCell>
                  </TableRow>
                )}
                {servicesForListing?.services.map(s => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.serviceType.replace(/_/g, " ")}</TableCell>
                    <TableCell className="font-mono text-sm">{formatPrice(Number(s.price), s.currency)}</TableCell>
                    <TableCell>{s.turnaroundDays}d</TableCell>
                    <TableCell>
                      <Select
                        value={s.availability}
                        onValueChange={(v) => updateAdminServiceMut.mutate({
                          listingId: servicesForListing!.id,
                          serviceId: s.id,
                          data: { version: s.version, availability: v as "AVAILABLE" | "PAUSED" | "WAITLIST" },
                        })}
                      >
                        <SelectTrigger className="h-8 w-[110px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="AVAILABLE">Available</SelectItem>
                          <SelectItem value="PAUSED">Paused</SelectItem>
                          <SelectItem value="WAITLIST">Waitlist</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => pauseAdminServiceMut.mutate({ listingId: servicesForListing!.id, serviceId: s.id })}
                        disabled={s.availability === "PAUSED"}
                      >
                        Pause
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="border-t pt-4 space-y-3">
              <div className="text-sm font-medium">Add a service</div>
              <div className="grid grid-cols-4 gap-3">
                <Select value={newAdminService.serviceType} onValueChange={(v) => setNewAdminService({ ...newAdminService, serviceType: v })}>
                  <SelectTrigger><SelectValue placeholder="Service" /></SelectTrigger>
                  <SelectContent>
                    {(["GUEST_POST","NICHE_EDIT","EDITORIAL_LINK","OUTREACH_LINK","LOCAL_CITATION","FOUNDATION_LINK","BLOG_ARTICLE","SEO_CONTENT"] as const).map(t => (
                      <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input type="number" min={1} step="0.01" placeholder="Price" value={newAdminService.price} onChange={(e) => setNewAdminService({ ...newAdminService, price: e.target.value })} />
                <Input type="number" min={1} placeholder="TAT (days)" value={newAdminService.turnaroundDays} onChange={(e) => setNewAdminService({ ...newAdminService, turnaroundDays: e.target.value })} />
                <Input type="number" min={0} placeholder="Revisions" value={newAdminService.revisionRounds} onChange={(e) => setNewAdminService({ ...newAdminService, revisionRounds: e.target.value })} />
              </div>
              <Button
                size="sm"
                disabled={!servicesForListing || !newAdminService.price || Number(newAdminService.price) <= 0 || addAdminServiceMut.isPending}
                onClick={() => servicesForListing && addAdminServiceMut.mutate({
                  listingId: servicesForListing.id,
                  data: {
                    serviceType: newAdminService.serviceType,
                    price: Number(newAdminService.price),
                    turnaroundDays: Number(newAdminService.turnaroundDays) || 7,
                    revisionRounds: Number(newAdminService.revisionRounds) || 2,
                  },
                })}
              >
                {addAdminServiceMut.isPending ? "Adding..." : "Add service"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}