"use client"

import { use } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../../lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Skeleton, ErrorState } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Label } from "@guestpost/ui"
import { Textarea } from "@guestpost/ui"
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@guestpost/ui"
import {
  ArrowLeft,
  Clock,
  CheckCircle,
  FileText,
  MessageSquare,
  RefreshCw,
  ExternalLink,
  XCircle,
  AlertCircle,
  Check,
  User,
  Globe,
  ShieldCheck,
} from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import Link from "next/link"
import { toast } from "sonner"
import { useState } from "react"

const statusConfig: Record<string, { color: string; icon: React.ElementType; description: string }> = {
  DRAFT: { color: "bg-gray-100 text-gray-700", icon: FileText, description: "Order is in draft state" },
  PENDING_PAYMENT: { color: "bg-amber-100 text-amber-700", icon: Clock, description: "Awaiting payment" },
  PAID: { color: "bg-blue-100 text-blue-700", icon: CheckCircle, description: "Payment received" },
  SUBMITTED: { color: "bg-indigo-100 text-indigo-700", icon: CheckCircle, description: "Order submitted" },
  ACCEPTED: { color: "bg-blue-100 text-blue-700", icon: CheckCircle, description: "Order accepted" },
  ASSIGNED: { color: "bg-purple-100 text-purple-700", icon: User, description: "Order assigned to writer" },
  CONTENT_REQUESTED: { color: "bg-cyan-100 text-cyan-700", icon: FileText, description: "Content requested" },
  CONTENT_CREATION: { color: "bg-cyan-100 text-cyan-700", icon: FileText, description: "Creating content" },
  CONTENT_READY: { color: "bg-teal-100 text-teal-700", icon: Check, description: "Content ready" },
  REVIEW: { color: "bg-orange-100 text-orange-700", icon: AlertCircle, description: "Reviewing content" },
  OUTREACH: { color: "bg-pink-100 text-pink-700", icon: Globe, description: "Outreach in progress" },
  PUBLISHED: { color: "bg-green-100 text-green-700", icon: Check, description: "Content published" },
  VERIFIED: { color: "bg-green-100 text-green-700", icon: ShieldCheck, description: "Content verified" },
  DELIVERED: { color: "bg-emerald-100 text-emerald-700", icon: CheckCircle, description: "Order delivered" },
  UNDER_REVIEW: { color: "bg-orange-100 text-orange-700", icon: AlertCircle, description: "Awaiting your review" },
  COMPLETED: { color: "bg-emerald-100 text-emerald-700", icon: CheckCircle, description: "Order completed" },
  CANCELLED: { color: "bg-red-100 text-red-700", icon: XCircle, description: "Order cancelled" },
  REFUNDED: { color: "bg-gray-100 text-gray-500", icon: RefreshCw, description: "Refund issued" },
}

const eventLabels: Record<string, string> = {
  ORDER_CREATED: "Order created",
  PAYMENT_RECEIVED: "Payment received",
  ASSIGNED: "Writer assigned",
  CONTENT_SUBMITTED: "Content submitted",
  CONTENT_APPROVED: "Content approved",
  PUBLISHED: "Published live",
  VERIFIED: "Verified",
  UNDER_REVIEW: "Sent for review",
  SETTLED: "Settlement processed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
  DISPUTED: "Dispute opened",
  REJECTED: "Rejected",
}

interface TimelineEvent {
  id: string
  eventType: string
  metadata: Record<string, unknown> | null
  createdAt: string
}

// Mirrors the api-client OrderResponse (normalized from the real API payload)
interface OrderDetail {
  id: string
  status: string
  paymentStatus: string
  items: Array<{
    id: string
    serviceType: string
    topic: string | null
    instructions: string | null
    budget: number | null
    website: { id: string; url: string } | null
  }>
  totalAmount: number | null
  currency: string
  createdAt: string
  updatedAt: string
  events: TimelineEvent[]
}

function OrderTimeline({ events }: { events: TimelineEvent[] }) {
  const sortedEvents = [...events].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )

  return (
    <div className="relative">
      <div className="absolute left-4 top-0 h-full w-px bg-border" />
      <div className="space-y-6">
        {sortedEvents.map((event, index) => {
          const config = statusConfig[event.eventType] || statusConfig.DRAFT
          const Icon = config.icon
          const isLatest = index === 0

          return (
            <div key={event.id} className="relative pl-10">
              <div
                className={`absolute left-2.5 top-1 flex h-5 w-5 items-center justify-center rounded-full ${
                  isLatest ? "bg-primary" : "bg-muted"
                }`}
              >
                <Icon className={`h-3 w-3 ${isLatest ? "text-primary-foreground" : "text-muted-foreground"}`} />
              </div>
              <div className="flex flex-col">
                <span className="font-medium">{eventLabels[event.eventType] || event.eventType}</span>
                <span className="text-sm text-muted-foreground">
                  {formatDistanceToNow(new Date(event.createdAt), { addSuffix: true })}
                </span>
                {event.metadata && Object.keys(event.metadata).length > 0 && (
                  <div className="mt-1 text-sm text-muted-foreground">
                    {JSON.stringify(event.metadata)}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] || statusConfig.DRAFT
  const Icon = config.icon

  return (
    <Badge className={`${config.color} gap-1.5 capitalize`}>
      <Icon className="h-3.5 w-3.5" />
      {status.replace(/_/g, " ").toLowerCase()}
    </Badge>
  )
}

function OrderDetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10" />
        <Skeleton className="h-8 w-48" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card><CardContent className="pt-6"><Skeleton className="h-32 w-full" /></CardContent></Card>
          <Card><CardContent className="pt-6"><Skeleton className="h-48 w-full" /></CardContent></Card>
        </div>
        <div className="space-y-6">
          <Card><CardContent className="pt-6"><Skeleton className="h-24 w-full" /></CardContent></Card>
          <Card><CardContent className="pt-6"><Skeleton className="h-48 w-full" /></CardContent></Card>
        </div>
      </div>
    </div>
  )
}

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params)
  const queryClient = useQueryClient()
  const [showRevisionDialog, setShowRevisionDialog] = useState(false)
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [showDisputeDialog, setShowDisputeDialog] = useState(false)
  const [revisionMessage, setRevisionMessage] = useState("")
  const [disputeReason, setDisputeReason] = useState("")

  const { data: order, isLoading, error, refetch } = useQuery<OrderDetail>({
    queryKey: ["order", resolvedParams.id],
    queryFn: () => api.orders.getById(resolvedParams.id) as Promise<OrderDetail>,
  })

  const { data: proof } = useQuery<any>({
    queryKey: ["order-proof", resolvedParams.id],
    queryFn: () => api.orders.deliveryProof(resolvedParams.id),
    enabled: !!order && ["PUBLISHED", "VERIFIED", "DELIVERED", "SETTLED", "COMPLETED", "DISPUTED"].includes(order.status),
  })

  const cancelMutation = useMutation({
    mutationFn: () => api.orders.transitionStatus(resolvedParams.id, "CANCELLED"),
    onSuccess: () => {
      toast.success("Order cancelled successfully")
      queryClient.invalidateQueries({ queryKey: ["order", resolvedParams.id] })
      queryClient.invalidateQueries({ queryKey: ["orders"] })
      setShowCancelDialog(false)
    },
    onError: () => {
      toast.error("Failed to cancel order")
    },
  })

  const disputeMutation = useMutation({
    mutationFn: () => api.orders.openDispute(resolvedParams.id, disputeReason.trim()),
    onSuccess: () => {
      toast.success("Dispute opened — our team will review it")
      queryClient.invalidateQueries({ queryKey: ["order", resolvedParams.id] })
      queryClient.invalidateQueries({ queryKey: ["orders"] })
      setShowDisputeDialog(false)
      setDisputeReason("")
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to open dispute")
    },
  })

  const requestRevisionMutation = useMutation({
    mutationFn: () => api.campaigns.requestRevision(resolvedParams.id, { notes: revisionMessage }),
    onSuccess: () => {
      toast.success("Revision request submitted")
      queryClient.invalidateQueries({ queryKey: ["order", resolvedParams.id] })
      setShowRevisionDialog(false)
      setRevisionMessage("")
    },
    onError: () => {
      toast.error("Failed to submit revision request")
    },
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/orders">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Orders
          </Link>
        </Button>
        <OrderDetailSkeleton />
      </div>
    )
  }

  if (error) {
    return <ErrorState title="Failed to load order" description={(error as Error).message} onRetry={() => refetch()} />
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <h2 className="mt-4 text-xl font-semibold">Order Not Found</h2>
        <p className="mt-2 text-muted-foreground">
          The order you&apos;re looking for doesn&apos;t exist or you don&apos;t have access to it.
        </p>
        <Button className="mt-4" asChild>
          <Link href="/dashboard/orders">View All Orders</Link>
        </Button>
      </div>
    )
  }

  const currentStatusConfig = statusConfig[order.status] || statusConfig.DRAFT
  const currentStatusIcon = currentStatusConfig.icon

  const canRequestRevision = ["UNDER_REVIEW", "CONTENT_SUBMITTED", "PUBLISHED"].includes(order.status)
  const canCancel = !["COMPLETED", "CANCELLED", "REFUNDED"].includes(order.status)
  // Backend allows disputes on PUBLISHED/VERIFIED/DELIVERED/CANCELLED or any
  // paid order; surface the button once money has moved and no terminal state
  const canDispute =
    order.paymentStatus === "PAID" &&
    !["REFUNDED", "DISPUTED"].includes(order.status)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/dashboard/orders">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">Order #{order.id.slice(0, 8)}</h1>
              <StatusBadge status={order.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              Created {format(new Date(order.createdAt), "PPp")}
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          {canRequestRevision && (
            <Button variant="outline" onClick={() => setShowRevisionDialog(true)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Request Revision
            </Button>
          )}
          {canDispute && (
            <Button variant="outline" onClick={() => setShowDisputeDialog(true)}>
              <AlertCircle className="mr-2 h-4 w-4" />
              Open Dispute
            </Button>
          )}
          {canCancel && (
            <Button variant="destructive" onClick={() => setShowCancelDialog(true)}>
              <XCircle className="mr-2 h-4 w-4" />
              Cancel Order
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {proof?.hasDelivery && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-green-600" /> Delivery Proof
                </CardTitle>
                <CardDescription>Independently verified by the platform — no manual checking needed.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Published URL</p>
                  <a href={proof.publishedUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline break-all">{proof.publishedUrl}</a>
                </div>
                {proof.pageTitle && (
                  <div className="space-y-1"><p className="text-sm text-muted-foreground">Page Title</p><p className="font-medium">{proof.pageTitle}</p></div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Verification:</span>
                  <StatusBadge status={proof.verificationStatus === "VERIFIED" || proof.interventionStatus === "APPROVED" || proof.interventionStatus === "OVERRIDDEN" ? "VERIFIED" : proof.verificationStatus} />
                </div>
                {proof.results && (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {[
                      ["URL Reachable", proof.results.urlReachable],
                      ["Link Found", proof.results.linkFound],
                      ["Target URL Matched", proof.results.targetUrlMatched],
                      ["Anchor Verified", proof.results.anchorVerified],
                    ].map(([label, ok]) => (
                      <div key={label as string} className="flex items-center gap-2">
                        {ok ? <CheckCircle className="h-4 w-4 text-green-600" /> : <XCircle className="h-4 w-4 text-muted-foreground" />}
                        <span className={ok ? "" : "text-muted-foreground"}>{label}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-2">
                  <span>Delivered by: {proof.deliveredBy}</span>
                  {proof.submittedAt && <span>Submitted: {format(new Date(proof.submittedAt), "PPp")}</span>}
                  {proof.verifiedAt && <span>Verified: {format(new Date(proof.verifiedAt), "PPp")}</span>}
                  {proof.results?.checkedAt && <span>Checked: {format(new Date(proof.results.checkedAt), "PPp")}</span>}
                </div>
                {proof.screenshotUrl && (
                  <a href={proof.screenshotUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">View screenshot</a>
                )}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Order Details</CardTitle>
              <CardDescription>Details of your order</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Service Type</p>
                  <p className="font-medium capitalize">
                    {order.items?.[0]?.serviceType?.replace(/_/g, " ").toLowerCase() ?? "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Website</p>
                  <p className="font-medium">
                    {order.items?.[0]?.website?.url ? (
                      <a
                        href={order.items[0].website.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-primary hover:underline"
                      >
                        {new URL(order.items[0].website.url).hostname}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Topic / Title</p>
                  <p className="font-medium">{order.items?.[0]?.topic || "—"}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Total Amount</p>
                  <p className="font-medium font-mono">
                    {order.totalAmount ? `$${order.totalAmount.toFixed(2)}` : "—"}
                  </p>
                </div>
              </div>

              {order.items?.[0]?.instructions && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Instructions</p>
                  <p className="whitespace-pre-wrap text-sm">{order.items[0].instructions}</p>
                </div>
              )}

            </CardContent>
          </Card>

          {order.items?.[0]?.instructions && (
            <Card>
              <CardHeader>
                <CardTitle>Content Brief</CardTitle>
                <CardDescription>Original content requirements</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{order.items[0].instructions}</p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Order Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <div className={`flex h-12 w-12 items-center justify-center rounded-full ${currentStatusConfig.color}`}>
                  {(() => {
                    const Icon = currentStatusIcon
                    return Icon ? <Icon className="h-6 w-6" /> : null
                  })()}
                </div>
                <div>
                  <p className="font-medium">{currentStatusConfig.description}</p>
                  <p className="text-sm text-muted-foreground">
                    Updated {formatDistanceToNow(new Date(order.updatedAt), { addSuffix: true })}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Timeline</CardTitle>
              <CardDescription>Order history and updates</CardDescription>
            </CardHeader>
            <CardContent>
              <OrderTimeline events={order.events || []} />
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={showRevisionDialog} onOpenChange={setShowRevisionDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Revision</DialogTitle>
            <DialogDescription>
              Describe the changes you&apos;d like to the delivered content
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="revision-message">Revision Details</Label>
            <Textarea
              id="revision-message"
              rows={4}
              value={revisionMessage}
              onChange={(e) => setRevisionMessage(e.target.value)}
              placeholder="Please describe the changes needed..."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRevisionDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => requestRevisionMutation.mutate()}
              disabled={!revisionMessage.trim() || requestRevisionMutation.isPending}
            >
              {requestRevisionMutation.isPending ? "Submitting..." : "Submit Revision"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Order</DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel this order? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCancelDialog(false)}>
              Keep Order
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? "Cancelling..." : "Cancel Order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDisputeDialog} onOpenChange={setShowDisputeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open a Dispute</DialogTitle>
            <DialogDescription>
              Tell us what went wrong with this order. Our team reviews every dispute —
              settlement to the publisher is paused while a dispute is active.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Describe the issue (at least 10 characters)..."
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
            rows={4}
            maxLength={2000}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDisputeDialog(false)}>
              Back
            </Button>
            <Button
              variant="destructive"
              onClick={() => disputeMutation.mutate()}
              disabled={disputeMutation.isPending || disputeReason.trim().length < 10}
            >
              {disputeMutation.isPending ? "Submitting..." : "Open Dispute"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}