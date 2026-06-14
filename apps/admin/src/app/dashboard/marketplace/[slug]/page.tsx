"use client"

/**
 * Staff preview of a marketplace listing's public page, with moderation
 * actions inline. Staff cannot enter the customer portal (CUSTOMER-only
 * session gate), so the public view is rendered here from the same public
 * API the portal uses — what staff see is what customers see.
 *
 * Action visibility mirrors the backend guards exactly:
 * status/featured/verified mutations are SUPER_ADMIN + OPERATIONS routes.
 */
import { use } from "react"
import Link from "next/link"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"
import {
  Button,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@guestpost/ui"
import {
  ArrowLeft,
  AlertCircle,
  RefreshCw,
  TrendingUp,
  ShieldCheck,
  Star,
  ExternalLink,
  Globe,
} from "lucide-react"
import { toast } from "sonner"

const PORTAL_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://localhost:3001"

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  APPROVED: "default",
  PENDING_REVIEW: "secondary",
  DRAFT: "outline",
  REJECTED: "destructive",
  PAUSED: "secondary",
  ARCHIVED: "outline",
}

export default function AdminListingPreviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params)
  const { user } = useAuth()
  const queryClient = useQueryClient()

  // Moderation is SUPER_ADMIN/OPERATIONS on the backend — FINANCE can look,
  // not touch (buttons hidden; API would 403 anyway)
  const canModerate = user?.staffRole === "SUPER_ADMIN" || user?.staffRole === "OPERATIONS"

  const { data: listing, isLoading, error, refetch } = useQuery({
    // Staff endpoint returns the listing in ANY status (pending/draft/etc) —
    // the public getListing 404s anything not APPROVED for non-owners.
    queryKey: ["admin", "listing-preview", slug],
    queryFn: () => api.admin.getListingBySlug(slug),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin", "listing-preview", slug] })
    queryClient.invalidateQueries({ queryKey: ["admin", "marketplace"] })
  }

  const statusMutation = useMutation({
    mutationFn: (status: string) => api.admin.updateListingStatus(listing!.id, status),
    onSuccess: () => { toast.success("Listing status updated"); invalidate() },
    onError: (e: Error) => toast.error(e.message || "Failed to update status"),
  })
  const featuredMutation = useMutation({
    mutationFn: (featured: boolean) => api.admin.toggleListingFeatured(listing!.id, featured),
    onSuccess: () => { toast.success("Featured flag updated"); invalidate() },
    onError: (e: Error) => toast.error(e.message || "Failed to update featured"),
  })
  const verifiedMutation = useMutation({
    mutationFn: (verified: boolean) => api.admin.toggleListingVerified(listing!.id, verified),
    onSuccess: () => { toast.success("Verified flag updated"); invalidate() },
    onError: (e: Error) => toast.error(e.message || "Failed to update verified"),
  })
  const busy = statusMutation.isPending || featuredMutation.isPending || verifiedMutation.isPending

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (error || !listing) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Listing not found</h2>
        <p className="text-muted-foreground mb-4">{(error as Error)?.message ?? "It may have been archived."}</p>
        <div className="flex gap-2">
          <Button variant="outline" asChild><Link href="/dashboard/marketplace">Back to Marketplace</Link></Button>
          <Button onClick={() => refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/marketplace"><ArrowLeft className="mr-2 h-4 w-4" />Back to Marketplace</Link>
        </Button>
        <a
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          href={`${PORTAL_URL}/dashboard/marketplace/${listing.slug}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open on customer portal <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* ── Public-page preview (same data customers see) ── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANTS[listing.status] ?? "secondary"}>{listing.status.replace(/_/g, " ")}</Badge>
            {/* Phase 7: prefer the first AVAILABLE service. */}
            <Badge variant="outline">{(((listing as any).serviceTypes?.[0]) ?? listing.type ?? "").replace(/_/g, " ")}</Badge>
            {listing.fulfillmentType === "INTERNAL" ? (
              <Badge>Platform fulfilled</Badge>
            ) : listing.fulfillmentType === "HYBRID" ? (
              <Badge variant="secondary">Hybrid fulfillment</Badge>
            ) : (
              <Badge variant="secondary">Publisher fulfilled</Badge>
            )}
            {listing.verified && (
              <span className="inline-flex items-center gap-1 text-xs text-green-600"><ShieldCheck className="h-3.5 w-3.5" /> Verified</span>
            )}
            {listing.featured && (
              <span className="inline-flex items-center gap-1 text-xs text-primary"><Star className="h-3.5 w-3.5" /> Featured</span>
            )}
          </div>
          <CardTitle className="text-2xl">{listing.title}</CardTitle>
          {listing.category && <p className="text-sm text-primary">{listing.category.name}</p>}
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{listing.description}</p>
          <div className="flex flex-wrap items-center gap-6 text-sm">
            {/* Phase 7: priceFrom + first AVAILABLE service price > legacy. */}
            <span className="text-2xl font-bold">${Number((listing as any).priceFrom ?? listing.price ?? 0).toFixed(2)}</span>
            {typeof listing.domainRating === "number" && (
              <span className="inline-flex items-center gap-1 text-muted-foreground"><TrendingUp className="h-4 w-4" /> DR {listing.domainRating}</span>
            )}
            {typeof listing.traffic === "number" && listing.traffic > 0 && (
              <span className="text-muted-foreground">{Intl.NumberFormat("en", { notation: "compact" }).format(listing.traffic)} visits/mo</span>
            )}
            {listing.websiteUrl && (
              <span className="inline-flex items-center gap-1 text-muted-foreground"><Globe className="h-4 w-4" /> {listing.websiteUrl}</span>
            )}
            {(() => {
              // Phase 7: surface the first AVAILABLE service's TAT in the
              // header summary; fall back to the legacy listing column.
              const td = (listing as any).services?.find((s: any) => s.availability === "AVAILABLE")?.turnaroundDays ?? listing.turnaroundDays
              return td ? <span className="text-muted-foreground">{td}d turnaround</span> : null
            })()}
          </div>
          {listing.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {listing.tags.map((t: any) => (
                <span key={t.id} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t.name}</span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Moderation (mirrors backend SUPER_ADMIN/OPERATIONS guards) ── */}
      {canModerate && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Moderation</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {listing.status !== "APPROVED" && (
              <Button size="sm" disabled={busy} onClick={() => statusMutation.mutate("APPROVED")}>Approve</Button>
            )}
            {listing.status === "PENDING_REVIEW" && (
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => statusMutation.mutate("REJECTED")}>Reject</Button>
            )}
            {listing.status === "APPROVED" && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => statusMutation.mutate("PAUSED")}>Pause</Button>
            )}
            {listing.status === "PAUSED" && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => statusMutation.mutate("APPROVED")}>Unpause</Button>
            )}
            {listing.status !== "ARCHIVED" && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => statusMutation.mutate("ARCHIVED")}>Archive</Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => featuredMutation.mutate(!listing.featured)}>
              {listing.featured ? "Remove Featured" : "Mark Featured"}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => verifiedMutation.mutate(!listing.verified)}>
              {listing.verified ? "Remove Verified" : "Mark Verified"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
