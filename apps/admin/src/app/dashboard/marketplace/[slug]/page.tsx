"use client"

import type {
  AdminMarketplaceListingDetail,
  PublicDomainMetricValue,
} from "@guestpost/api-client"
import type { ListingStatus } from "@guestpost/database"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  getListingStatusPresentation,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusBadge,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  Building2,
  CalendarClock,
  ExternalLink,
  Globe2,
  RefreshCw,
  ShieldCheck,
  Star,
  Store,
  UserRound,
} from "lucide-react"
import Link from "next/link"
import { use, useState } from "react"
import { toast } from "sonner"
import {
  AdminEmptyState,
  AdminMetricCard,
  AdminNotice,
  AdminPage,
  AdminPageHeader,
} from "../../../../components/admin-workspace"
import { api } from "../../../../lib/api"
import { ForbiddenPage, useRequireRole } from "../../../../lib/use-require-role"

const PORTAL_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://localhost:3001"
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

function formatMetric(value?: number, compact = false) {
  if (value == null) return "—"
  return compact
    ? Intl.NumberFormat("en", { notation: "compact" }).format(value)
    : Intl.NumberFormat("en").format(value)
}

function sourceName(source: string) {
  const labels: Record<string, string> = {
    AHREFS_FREE_API: "Ahrefs free API",
    AHREFS_PAID_API: "Ahrefs paid API",
    OPEN_PAGE_RANK_API: "OpenPageRank API",
    MOZ_PAID_API: "Moz paid API",
    PUBLISHER_MANUAL: "Publisher supplied",
    STAFF_MANUAL: "Staff supplied",
    ADMIN_IMPORT: "Admin CSV import",
  }
  return labels[source] ?? source.replaceAll("_", " ").toLowerCase()
}

function MetricCard({
  label,
  metric,
  compact,
}: {
  label: string
  metric?: PublicDomainMetricValue
  compact?: boolean
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Badge
          variant={
            !metric
              ? "destructive"
              : metric.status === "CURRENT"
                ? "success"
                : "warning"
          }
        >
          {metric?.status.toLowerCase() ?? "missing"}
        </Badge>
      </div>
      <p className="mt-2 text-2xl font-bold tabular-nums">
        {formatMetric(metric?.value, compact)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {metric
          ? `${sourceName(metric.source)} · measured ${format(new Date(metric.measuredAt), "PP")}`
          : "No trusted value has been collected"}
      </p>
    </div>
  )
}

function YesNo({ value }: { value: boolean | null | undefined }) {
  return value == null ? "Not reviewed" : value ? "Yes" : "No"
}

export default function AdminListingDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { allowed, loading } = useRequireRole(
    "SUPER_ADMIN",
    "OPERATIONS",
    "FINANCE",
  )
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Staff marketplace access" />
  return <AdminListingDetailPageInner params={params} />
}

function AdminListingDetailPageInner({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = use(params)
  const queryClient = useQueryClient()
  const [newService, setNewService] = useState({
    serviceType: "GUEST_POST",
    price: "",
    turnaroundDays: "7",
    revisionRounds: "2",
  })

  const listingQ = useQuery<AdminMarketplaceListingDetail>({
    queryKey: ["admin", "listing-preview", slug],
    queryFn: () => api.admin.getListingBySlug(slug),
  })
  const listing = listingQ.data

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: ["admin", "listing-preview", slug],
    })
    queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
    queryClient.invalidateQueries({ queryKey: ["admin-marketplace-stats"] })
  }
  const statusMutation = useMutation({
    mutationFn: (status: string) =>
      api.admin.updateListingStatus(listing!.id, status),
    onSuccess: () => {
      toast.success("Listing status updated")
      invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const featuredMutation = useMutation({
    mutationFn: (featured: boolean) =>
      api.admin.toggleListingFeatured(listing!.id, featured),
    onSuccess: () => {
      toast.success("Featured flag updated")
      invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const verifiedMutation = useMutation({
    mutationFn: (verified: boolean) =>
      api.admin.toggleListingVerified(listing!.id, verified),
    onSuccess: () => {
      toast.success("Verified flag updated")
      invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const addServiceMutation = useMutation({
    mutationFn: () =>
      api.admin.addPlatformListingService(listing!.id, {
        serviceType: newService.serviceType,
        price: Number(newService.price),
        turnaroundDays: Number(newService.turnaroundDays),
        revisionRounds: Number(newService.revisionRounds),
      }),
    onSuccess: () => {
      toast.success("Service added")
      setNewService({
        serviceType: "GUEST_POST",
        price: "",
        turnaroundDays: "7",
        revisionRounds: "2",
      })
      invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const pauseServiceMutation = useMutation({
    mutationFn: (serviceId: string) =>
      api.admin.pausePlatformListingService(listing!.id, serviceId),
    onSuccess: () => {
      toast.success("Service paused")
      invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (listingQ.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-28 w-full" />
          ))}
        </div>
        <Skeleton className="h-80 w-full" />
      </div>
    )
  }

  if (listingQ.isError || !listing) {
    return (
      <AdminPage>
        <AdminPageHeader
          eyebrow="Role-protected listing context"
          title="Listing unavailable"
          description="The listing may not exist or could not be loaded safely."
          icon={AlertCircle}
        />
        <Card>
          <AdminEmptyState
            title="No listing context available"
            description="Return to the marketplace inventory or retry this request."
            action={
              <div className="flex gap-2">
                <Button variant="outline" asChild>
                  <Link href="/dashboard/marketplace">Back to marketplace</Link>
                </Button>
                <Button onClick={() => listingQ.refetch()}>Retry</Button>
              </div>
            }
          />
        </Card>
      </AdminPage>
    )
  }

  const statusPresentation = getListingStatusPresentation(
    listing.status as ListingStatus,
  )
  const busy =
    statusMutation.isPending ||
    featuredMutation.isPending ||
    verifiedMutation.isPending
  const publisherLabel =
    listing.ownerType === "PLATFORM"
      ? "GuestPost.cc"
      : listing.publisher?.name || "Publisher unavailable"
  const availableServices = listing.services.filter(
    (service) => service.availability === "AVAILABLE",
  )

  return (
    <AdminPage>
      <AdminPageHeader
        eyebrow={
          listing.access.role === "FINANCE"
            ? "Financial listing context"
            : "Marketplace listing review"
        }
        title={listing.title}
        description={`${listing.website?.domain || listing.websiteUrl || "Domain unavailable"} · ${publisherLabel}`}
        icon={Store}
        badges={
          <>
            <StatusBadge variant={statusPresentation.variant}>
              {statusPresentation.label}
            </StatusBadge>
            <Badge variant="outline">
              {listing.ownerType.toLowerCase()} owned
            </Badge>
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/marketplace">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Marketplace
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => listingQ.refetch()}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            {listing.status === "APPROVED" ? (
              <Button variant="outline" size="sm" asChild>
                <a
                  href={`${PORTAL_URL}/dashboard/marketplace/${listing.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Customer view <ExternalLink className="ml-2 h-3.5 w-3.5" />
                </a>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          label="Starting price"
          value={
            listing.priceFrom == null
              ? "—"
              : `${listing.currency} ${Number(listing.priceFrom).toFixed(2)}`
          }
          description={`${availableServices.length} available service${availableServices.length === 1 ? "" : "s"}`}
          icon={Store}
          tone="success"
        />
        <AdminMetricCard
          label="Publisher / owner"
          value={publisherLabel}
          description={
            listing.publisher?.tier ||
            listing.website?.managedBy?.name ||
            "Platform inventory"
          }
          icon={UserRound}
        />
        <AdminMetricCard
          label="Domain verification"
          value={
            listing.website?.verificationStatus.replaceAll("_", " ") ||
            "Unknown"
          }
          description={
            listing.website?.verifiedAt
              ? `Verified ${format(new Date(listing.website.verifiedAt), "PP")}`
              : "No verification date"
          }
          icon={ShieldCheck}
          tone={
            listing.website?.verificationStatus === "VERIFIED"
              ? "success"
              : "warning"
          }
        />
        <AdminMetricCard
          label="Last updated"
          value={format(new Date(listing.updatedAt), "PP")}
          description={`Created ${format(new Date(listing.createdAt), "PP")}`}
          icon={CalendarClock}
          tone="info"
        />
      </div>

      {listing.access.role === "FINANCE" ? (
        <AdminNotice title="Read-only financial context">
          Listing price, ownership, services, publisher profile, and metric
          provenance are visible for order and settlement investigation.
          Moderation and inventory actions are intentionally hidden.
        </AdminNotice>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Moderation actions</CardTitle>
            <CardDescription>
              Normal approval always enforces domain ownership and listing
              readiness gates.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {listing.status === "PENDING_REVIEW" ? (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => statusMutation.mutate("APPROVED")}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => statusMutation.mutate("REJECTED")}
                >
                  Reject
                </Button>
              </>
            ) : null}
            {listing.status === "APPROVED" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => statusMutation.mutate("PAUSED")}
              >
                Pause
              </Button>
            ) : null}
            {listing.status === "PAUSED" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => statusMutation.mutate("APPROVED")}
              >
                Restore
              </Button>
            ) : null}
            {listing.access.canManageGlobalFlags ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => featuredMutation.mutate(!listing.featured)}
                >
                  <Star className="mr-2 h-4 w-4" />
                  {listing.featured ? "Remove featured" : "Mark featured"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => verifiedMutation.mutate(!listing.verified)}
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {listing.verified ? "Remove verified" : "Mark verified"}
                </Button>
              </>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4" />
            Domain metrics
          </CardTitle>
          <CardDescription>
            Publisher and platform inventory share the same provenance,
            freshness, and API collection model.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Ahrefs Domain Rating"
              metric={listing.domainMetrics?.ahrefs.domainRating}
            />
            <MetricCard
              label="Ahrefs organic traffic"
              metric={listing.domainMetrics?.ahrefs.organicTraffic}
              compact
            />
            <MetricCard
              label="Moz Domain Authority"
              metric={listing.domainMetrics?.moz.domainAuthority}
            />
            <MetricCard
              label="OpenPageRank"
              metric={listing.domainMetrics?.openPageRank.pageRank}
            />
          </div>
          {listing.domainMetrics?.openPageRank.globalRank ||
          listing.domainMetrics?.openPageRank.referringDomains ? (
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">
                Global rank{" "}
                {formatMetric(
                  listing.domainMetrics.openPageRank.globalRank?.value,
                )}
              </Badge>
              <Badge variant="outline">
                Referring domains{" "}
                {formatMetric(
                  listing.domainMetrics.openPageRank.referringDomains?.value,
                  true,
                )}
              </Badge>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Listing overview</CardTitle>
              <CardDescription>
                Customer-facing description and marketplace taxonomy
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                {listing.description}
              </p>
              <div className="flex flex-wrap gap-2">
                {listing.categories.map((category) => (
                  <Badge key={category.id} variant="secondary">
                    {category.name}
                  </Badge>
                ))}
                {listing.tags.map((tag) => (
                  <Badge key={tag.id} variant="outline">
                    {tag.name}
                  </Badge>
                ))}
              </div>
              <div className="grid gap-4 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3">
                <Detail label="Country" value={listing.country || "Not set"} />
                <Detail
                  label="Language"
                  value={listing.language || "Not set"}
                />
                <Detail
                  label="Backlinks"
                  value={listing.backlinkCount?.toString() || "Not reviewed"}
                />
                <Detail
                  label="Link type"
                  value={
                    listing.linkType?.replaceAll("_", " ") || "Not reviewed"
                  }
                />
                <Detail
                  label="Link validity"
                  value={
                    listing.linkValidity?.replaceAll("_", " ") || "Not reviewed"
                  }
                />
                <Detail
                  label="Google News"
                  value={YesNo({ value: listing.googleNews })}
                />
                <Detail
                  label="Sports / gaming"
                  value={YesNo({ value: listing.sportsGamingAllowed })}
                />
                <Detail
                  label="Pharmacy"
                  value={YesNo({ value: listing.pharmacyAllowed })}
                />
                <Detail
                  label="Crypto"
                  value={YesNo({ value: listing.cryptoAllowed })}
                />
                <Detail
                  label="Marked sponsored"
                  value={YesNo({ value: listing.markedSponsored })}
                />
                <Detail
                  label="Foreign language"
                  value={YesNo({ value: listing.foreignLanguageAllowed })}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Services</CardTitle>
              <CardDescription>
                Every service retains its own price, turnaround, revision, and
                availability state.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {listing.services.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No services configured.
                </p>
              ) : (
                listing.services.map((service) => (
                  <div
                    key={service.id}
                    className="flex flex-col justify-between gap-3 rounded-xl border p-4 sm:flex-row sm:items-center"
                  >
                    <div>
                      <p className="font-medium">
                        {service.serviceType.replaceAll("_", " ")}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {service.currency} {Number(service.price).toFixed(2)} ·{" "}
                        {service.turnaroundDays} days · {service.revisionRounds}{" "}
                        revisions
                        {service.warrantyDays
                          ? ` · ${service.warrantyDays}d warranty`
                          : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          service.availability === "AVAILABLE"
                            ? "success"
                            : service.availability === "PAUSED"
                              ? "warning"
                              : "secondary"
                        }
                      >
                        {service.availability.toLowerCase()}
                      </Badge>
                      {listing.access.canManageServices &&
                      service.availability !== "PAUSED" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pauseServiceMutation.isPending}
                          onClick={() =>
                            pauseServiceMutation.mutate(service.id)
                          }
                        >
                          Pause
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))
              )}

              {listing.access.canManageServices ? (
                <div className="mt-4 rounded-xl border border-dashed bg-muted/20 p-4">
                  <p className="text-sm font-semibold">Add service</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Select
                      value={newService.serviceType}
                      onValueChange={(serviceType) =>
                        setNewService({ ...newService, serviceType })
                      }
                    >
                      <SelectTrigger aria-label="Service type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SERVICE_TYPES.map((service) => (
                          <SelectItem key={service} value={service}>
                            {service.replaceAll("_", " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div>
                      <Label htmlFor="service-price" className="sr-only">
                        Price
                      </Label>
                      <Input
                        id="service-price"
                        type="number"
                        min={0.01}
                        step="0.01"
                        placeholder="Price"
                        value={newService.price}
                        onChange={(event) =>
                          setNewService({
                            ...newService,
                            price: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div>
                      <Label htmlFor="service-turnaround" className="sr-only">
                        Turnaround days
                      </Label>
                      <Input
                        id="service-turnaround"
                        type="number"
                        min={1}
                        placeholder="Turnaround days"
                        value={newService.turnaroundDays}
                        onChange={(event) =>
                          setNewService({
                            ...newService,
                            turnaroundDays: event.target.value,
                          })
                        }
                      />
                    </div>
                    <Button
                      disabled={
                        addServiceMutation.isPending ||
                        Number(newService.price) <= 0 ||
                        Number(newService.turnaroundDays) < 1
                      }
                      onClick={() => addServiceMutation.mutate()}
                    >
                      {addServiceMutation.isPending ? "Adding…" : "Add service"}
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2 className="h-4 w-4" />
                Publisher / owner
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Detail label="Display name" value={publisherLabel} />
              {listing.publisher ? (
                <>
                  <Detail label="Tier" value={listing.publisher.tier} />
                  <Detail
                    label="Rating"
                    value={
                      listing.publisher.profile?.rating == null
                        ? "Not rated"
                        : `${listing.publisher.profile.rating.toFixed(1)} / 5`
                    }
                  />
                  <Detail
                    label="Completed reviews"
                    value={String(listing.publisher.profile?.totalReviews ?? 0)}
                  />
                  <Detail
                    label="Response time"
                    value={
                      listing.publisher.profile?.responseTime == null
                        ? "Unavailable"
                        : `${listing.publisher.profile.responseTime} hours`
                    }
                  />
                  {listing.publisher.email ? (
                    <Detail label="Contact" value={listing.publisher.email} />
                  ) : null}
                </>
              ) : (
                <Detail
                  label="Operations owner"
                  value={listing.website?.managedBy?.name || "Shared Ops queue"}
                />
              )}
              {listing.organization?.name ? (
                <Detail
                  label="Organization"
                  value={listing.organization.name}
                />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Globe2 className="h-4 w-4" />
                Website & integrations
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Detail
                label="Domain"
                value={listing.website?.domain || "Unavailable"}
              />
              <Detail
                label="Verification"
                value={
                  listing.website?.verificationStatus.replaceAll("_", " ") ||
                  "Unknown"
                }
              />
              {listing.website?.url ? (
                <a
                  href={listing.website.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 break-all text-sm text-primary hover:underline"
                >
                  Open website <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : null}
              {(listing.website?.integrations.length ?? 0) > 0 ? (
                <div className="border-t pt-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    Connected data sources
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {listing.website!.integrations.map((integration) => (
                      <Badge key={integration.provider} variant="secondary">
                        {integration.provider === "GOOGLE_SEARCH_CONSOLE"
                          ? "GSC"
                          : "GA4"}{" "}
                        · {integration.status.toLowerCase()}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
              {listing.ownerType === "PLATFORM" &&
              listing.website &&
              listing.access.role !== "FINANCE" ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/dashboard/websites/${listing.website.id}`}>
                    Manage platform website
                  </Link>
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </AdminPage>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm font-medium">{value}</p>
    </div>
  )
}
