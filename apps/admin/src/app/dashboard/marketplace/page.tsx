"use client"

import type { AdminMarketplaceListingRow } from "@guestpost/api-client"
import type { ListingStatus } from "@guestpost/database"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ErrorState,
  getListingStatusPresentation,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import {
  Building2,
  CircleAlert,
  Eye,
  FileClock,
  MoreHorizontal,
  Search,
  ShieldCheck,
  Store,
} from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"
import {
  AdminEmptyState,
  AdminFilterBar,
  AdminMetricCard,
  AdminNotice,
  AdminPage,
  AdminPageHeader,
} from "../../../components/admin-workspace"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { ForbiddenPage, useRequireRole } from "../../../lib/use-require-role"

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

function formatMetric(value: number | undefined, compact = false) {
  if (value == null) return "—"
  return compact
    ? Intl.NumberFormat("en", { notation: "compact" }).format(value)
    : Intl.NumberFormat("en").format(value)
}

function metricStatus(listing: AdminMarketplaceListingRow) {
  const metrics = [
    listing.domainMetrics?.ahrefs.domainRating,
    listing.domainMetrics?.ahrefs.organicTraffic,
    listing.domainMetrics?.moz.domainAuthority,
    listing.domainMetrics?.openPageRank.pageRank,
  ]
  if (metrics.every((metric) => metric == null)) return "MISSING"
  if (metrics.some((metric) => metric?.status === "STALE")) return "STALE"
  if (metrics.some((metric) => metric == null)) return "PARTIAL"
  return "CURRENT"
}

function sourceLabel(listing: AdminMarketplaceListingRow) {
  return listing.ownerType === "PLATFORM"
    ? "GuestPost.cc"
    : listing.publisher?.name || "Publisher unavailable"
}

export default function AdminMarketplacePage() {
  const { allowed, loading } = useRequireRole(
    "SUPER_ADMIN",
    "OPERATIONS",
    "FINANCE",
  )
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Staff marketplace access" />
  return <AdminMarketplacePageInner />
}

function AdminMarketplacePageInner() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [ownerTypeFilter, setOwnerTypeFilter] = useState("all")
  const [page, setPage] = useState(1)

  const canModerate = user?.staffRole !== "FINANCE"
  const roleLabel =
    user?.staffRole === "FINANCE"
      ? "Financial inventory context"
      : user?.staffRole === "OPERATIONS"
        ? "Marketplace operations"
        : "Marketplace oversight"

  const filters = {
    ...(statusFilter !== "all" && { status: statusFilter }),
    ...(typeFilter !== "all" && { type: typeFilter }),
    ...(ownerTypeFilter !== "all" && { ownerType: ownerTypeFilter }),
    ...(search.trim() && { search: search.trim() }),
    page,
    limit: 20,
  }

  const listingsQ = useQuery({
    queryKey: ["admin-marketplace-listings", filters],
    queryFn: () => api.admin.listMarketplaceListings(filters),
  })
  const statsQ = useQuery({
    queryKey: ["admin-marketplace-stats"],
    queryFn: () => api.admin.getMarketplaceStats(),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
    queryClient.invalidateQueries({ queryKey: ["admin-marketplace-stats"] })
  }
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.admin.updateListingStatus(id, status),
    onSuccess: () => {
      toast.success("Listing status updated")
      invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const activeFilterCount = [
    search.trim(),
    statusFilter !== "all",
    typeFilter !== "all",
    ownerTypeFilter !== "all",
  ].filter(Boolean).length
  const listings = listingsQ.data?.listings ?? []
  const pagination = listingsQ.data?.pagination

  const resetFilters = () => {
    setSearch("")
    setStatusFilter("all")
    setTypeFilter("all")
    setOwnerTypeFilter("all")
    setPage(1)
  }

  return (
    <AdminPage>
      <AdminPageHeader
        eyebrow={roleLabel}
        title="Marketplace inventory"
        description="Review listing readiness, publisher context, services, and source-aware domain metrics without leaving the workflow. Actions remain role-protected by the API."
        icon={Store}
        badges={
          user?.staffRole === "FINANCE" ? (
            <Badge variant="secondary">Read only</Badge>
          ) : null
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          label="Total listings"
          value={statsQ.data?.totalListings ?? "—"}
          description={`${statsQ.data?.platformListings ?? 0} platform · ${statsQ.data?.publisherListings ?? 0} publisher`}
          icon={Store}
        />
        <AdminMetricCard
          label="Live inventory"
          value={statsQ.data?.activeListings ?? "—"}
          description="Approved and customer-visible"
          icon={ShieldCheck}
          tone="success"
        />
        <AdminMetricCard
          label="Needs attention"
          value={statsQ.data?.needsAttention ?? "—"}
          description={`${statsQ.data?.pendingListings ?? 0} in review · ${statsQ.data?.pausedListings ?? 0} paused`}
          icon={CircleAlert}
          tone="warning"
        />
        <AdminMetricCard
          label="Draft preparation"
          value={statsQ.data?.draftListings ?? "—"}
          description="Missing readiness steps or not submitted"
          icon={FileClock}
          tone="info"
        />
      </div>

      {user?.staffRole === "FINANCE" ? (
        <AdminNotice title="Finance view is contextual and read only">
          Use listing price, ownership, publisher profile, and metric evidence
          to investigate orders and settlements. Moderation and inventory
          changes remain unavailable to Finance.
        </AdminNotice>
      ) : null}

      <AdminFilterBar
        activeCount={activeFilterCount}
        resultCount={pagination?.total}
        resultLabel="listings"
        onClear={resetFilters}
      >
        <div className="relative min-w-0 flex-1 lg:min-w-72">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
            placeholder="Search title or domain"
            className="bg-background pl-9"
            aria-label="Search marketplace listings"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) => {
            setStatusFilter(value)
            setPage(1)
          }}
        >
          <SelectTrigger className="w-full bg-background sm:w-48">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {[
              "DRAFT",
              "PENDING_REVIEW",
              "APPROVED",
              "PAUSED",
              "REJECTED",
              "ARCHIVED",
            ].map((status) => (
              <SelectItem key={status} value={status}>
                {status.replaceAll("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={ownerTypeFilter}
          onValueChange={(value) => {
            setOwnerTypeFilter(value)
            setPage(1)
          }}
        >
          <SelectTrigger className="w-full bg-background sm:w-48">
            <SelectValue placeholder="Owner" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All owners</SelectItem>
            <SelectItem value="PUBLISHER">Publisher owned</SelectItem>
            <SelectItem value="PLATFORM">Platform owned</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={typeFilter}
          onValueChange={(value) => {
            setTypeFilter(value)
            setPage(1)
          }}
        >
          <SelectTrigger className="w-full bg-background sm:w-52">
            <SelectValue placeholder="Service" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All services</SelectItem>
            {SERVICE_TYPES.map((service) => (
              <SelectItem key={service} value={service}>
                {service.replaceAll("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </AdminFilterBar>

      {listingsQ.isError || statsQ.isError ? (
        <ErrorState
          title="Marketplace data unavailable"
          description={(listingsQ.error ?? statsQ.error)?.message}
          onRetry={() => {
            listingsQ.refetch()
            statsQ.refetch()
          }}
        />
      ) : (
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="border-b">
            <CardTitle className="text-base">Listing work queue</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {listingsQ.isLoading ? (
              <div className="space-y-3 p-5">
                {Array.from({ length: 5 }, (_, index) => (
                  <Skeleton key={index} className="h-20 w-full" />
                ))}
              </div>
            ) : listings.length === 0 ? (
              <AdminEmptyState
                title="No listings match this view"
                description="Clear one or more filters to return to the full marketplace inventory."
                action={
                  activeFilterCount ? (
                    <Button variant="outline" onClick={resetFilters}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <div className="space-y-3 p-4 md:hidden">
                  {listings.map((listing) => (
                    <ListingCard
                      key={listing.id}
                      listing={listing}
                      canModerate={canModerate}
                      busy={statusMutation.isPending}
                      onStatus={(status) =>
                        statusMutation.mutate({ id: listing.id, status })
                      }
                    />
                  ))}
                </div>
                <div className="hidden overflow-x-auto md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Listing</TableHead>
                        <TableHead>Owner</TableHead>
                        <TableHead>Services</TableHead>
                        <TableHead>Domain metrics</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-12">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {listings.map((listing) => (
                        <ListingRow
                          key={listing.id}
                          listing={listing}
                          canModerate={canModerate}
                          busy={statusMutation.isPending}
                          onStatus={(status) =>
                            statusMutation.mutate({ id: listing.id, status })
                          }
                        />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {pagination && pagination.totalPages > 1 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || listingsQ.isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pagination.totalPages || listingsQ.isFetching}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </AdminPage>
  )
}

function ListingActions({
  listing,
  canModerate,
  busy,
  onStatus,
}: {
  listing: AdminMarketplaceListingRow
  canModerate: boolean
  busy: boolean
  onStatus: (status: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for ${listing.title}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/dashboard/marketplace/${listing.slug}`}>
            <Eye className="mr-2 h-4 w-4" /> View details
          </Link>
        </DropdownMenuItem>
        {canModerate && listing.status === "PENDING_REVIEW" ? (
          <>
            <DropdownMenuItem
              disabled={busy}
              onClick={() => onStatus("APPROVED")}
            >
              Approve
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy}
              onClick={() => onStatus("REJECTED")}
            >
              Reject
            </DropdownMenuItem>
          </>
        ) : null}
        {canModerate && listing.status === "APPROVED" ? (
          <DropdownMenuItem disabled={busy} onClick={() => onStatus("PAUSED")}>
            Pause listing
          </DropdownMenuItem>
        ) : null}
        {canModerate && listing.status === "PAUSED" ? (
          <DropdownMenuItem
            disabled={busy}
            onClick={() => onStatus("APPROVED")}
          >
            Restore listing
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ListingRow({
  listing,
  canModerate,
  busy,
  onStatus,
}: {
  listing: AdminMarketplaceListingRow
  canModerate: boolean
  busy: boolean
  onStatus: (status: string) => void
}) {
  const presentation = getListingStatusPresentation(
    listing.status as ListingStatus,
  )
  const health = metricStatus(listing)
  return (
    <TableRow>
      <TableCell className="max-w-72">
        <Link
          href={`/dashboard/marketplace/${listing.slug}`}
          className="font-medium hover:text-primary hover:underline"
        >
          {listing.title}
        </Link>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {listing.websiteDomain || listing.websiteUrl || "Domain unavailable"}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Added {format(new Date(listing.createdAt), "PP")}
        </p>
      </TableCell>
      <TableCell>
        <div className="flex items-start gap-2">
          <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">{sourceLabel(listing)}</p>
            <p className="text-xs text-muted-foreground">
              {listing.ownerType === "PLATFORM"
                ? listing.websiteManagedBy?.name || "Shared Ops queue"
                : listing.publisher?.tier || "Publisher"}
            </p>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <p className="text-sm font-medium">
          {
            listing.services.filter(
              (service) => service.availability === "AVAILABLE",
            ).length
          }{" "}
          available
        </p>
        <p className="text-xs text-muted-foreground">
          {listing.priceFrom == null
            ? "No active price"
            : `From ${listing.currency} ${listing.priceFrom.toFixed(2)}`}
        </p>
      </TableCell>
      <TableCell>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <span>
            DR {formatMetric(listing.domainMetrics?.ahrefs.domainRating?.value)}
          </span>
          <span>
            DA {formatMetric(listing.domainMetrics?.moz.domainAuthority?.value)}
          </span>
          <span>
            Traffic{" "}
            {formatMetric(
              listing.domainMetrics?.ahrefs.organicTraffic?.value,
              true,
            )}
          </span>
          <span>
            OPR{" "}
            {formatMetric(listing.domainMetrics?.openPageRank.pageRank?.value)}
          </span>
        </div>
        <Badge
          className="mt-2"
          variant={
            health === "CURRENT"
              ? "success"
              : health === "MISSING"
                ? "destructive"
                : "warning"
          }
        >
          {health.toLowerCase()}
        </Badge>
      </TableCell>
      <TableCell>
        <StatusBadge variant={presentation.variant}>
          {presentation.label}
        </StatusBadge>
        <p className="mt-1 text-xs text-muted-foreground">
          Domain{" "}
          {listing.websiteVerificationStatus
            ?.replaceAll("_", " ")
            .toLowerCase() || "unknown"}
        </p>
      </TableCell>
      <TableCell>
        <ListingActions
          listing={listing}
          canModerate={canModerate}
          busy={busy}
          onStatus={onStatus}
        />
      </TableCell>
    </TableRow>
  )
}

function ListingCard(props: {
  listing: AdminMarketplaceListingRow
  canModerate: boolean
  busy: boolean
  onStatus: (status: string) => void
}) {
  const { listing } = props
  const presentation = getListingStatusPresentation(
    listing.status as ListingStatus,
  )
  return (
    <div className="min-w-0 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/dashboard/marketplace/${listing.slug}`}
            className="font-semibold hover:text-primary"
          >
            {listing.title}
          </Link>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {listing.websiteDomain || "Domain unavailable"}
          </p>
        </div>
        <ListingActions {...props} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <StatusBadge variant={presentation.variant}>
          {presentation.label}
        </StatusBadge>
        <Badge variant="outline">{sourceLabel(listing)}</Badge>
        <Badge variant="secondary">{listing.services.length} services</Badge>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-2 rounded-lg bg-muted/40 p-3 text-center">
        <div>
          <p className="text-[10px] text-muted-foreground">DR</p>
          <p className="text-sm font-semibold">
            {formatMetric(listing.domainMetrics?.ahrefs.domainRating?.value)}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">DA</p>
          <p className="text-sm font-semibold">
            {formatMetric(listing.domainMetrics?.moz.domainAuthority?.value)}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">Traffic</p>
          <p className="text-sm font-semibold">
            {formatMetric(
              listing.domainMetrics?.ahrefs.organicTraffic?.value,
              true,
            )}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">OPR</p>
          <p className="text-sm font-semibold">
            {formatMetric(listing.domainMetrics?.openPageRank.pageRank?.value)}
          </p>
        </div>
      </div>
    </div>
  )
}
