"use client"

import type { OrderStatus } from "@guestpost/shared"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  getOrderStatusPresentation,
  Input,
  Label,
  Skeleton,
  Textarea,
  StatusBadge as UIStatusBadge,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format, formatDistanceToNow } from "date-fns"
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle,
  Clock,
  DollarSign,
  Download,
  ExternalLink,
  FileText,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Upload,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../../lib/api"

const VARIANT_CIRCLE_BG: Record<string, string> = {
  default: "bg-primary/10 text-primary",
  success: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  destructive: "bg-red-100 text-red-700",
  info: "bg-blue-100 text-blue-700",
  pending: "bg-gray-100 text-gray-700",
}

const statusConfig: Record<
  string,
  { icon: React.ElementType; description: string }
> = {
  SUBMITTED: { icon: Clock, description: "Order submitted" },
  ACCEPTED: { icon: Check, description: "Order accepted" },
  CONTENT_REQUESTED: { icon: FileText, description: "Content requested" },
  CONTENT_CREATION: { icon: FileText, description: "Creating content" },
  CONTENT_READY: { icon: Check, description: "Content ready" },
  CUSTOMER_REVIEW: {
    icon: AlertCircle,
    description: "Awaiting customer review",
  },
  APPROVED: { icon: Check, description: "Content approved" },
  PUBLISHED: { icon: Check, description: "Content published" },
  VERIFIED: { icon: ShieldCheck, description: "Content verified" },
  DELIVERED: { icon: CheckCircle, description: "Order delivered" },
  SETTLED: { icon: CheckCircle, description: "Settlement processed" },
  COMPLETED: { icon: CheckCircle, description: "Order completed" },
  CANCELLED: { icon: XCircle, description: "Order cancelled" },
  REFUNDED: { icon: RefreshCw, description: "Refund issued" },
  DISPUTED: { icon: AlertCircle, description: "Order disputed" },
}

const eventLabels: Record<string, string> = {
  ORDER_CREATED: "Order created",
  PAYMENT_RECEIVED: "Payment received",
  ASSIGNED: "Assigned to you",
  CONTENT_SUBMITTED: "Content submitted",
  CONTENT_APPROVED: "Content approved",
  PUBLISHED: "Published live",
  VERIFIED: "Verified",
  UNDER_REVIEW: "Sent for review",
  DELIVERED: "Delivered",
  SETTLED: "Settlement processed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
  DISPUTED: "Dispute opened",
  REJECTED: "Rejected",
  VERIFIED_AUTO: "Automatically verified",
  AUTO_ACCEPTED: "Auto-accepted",
  REVIEW_REMINDER: "Review reminder sent",
  VERIFICATION_ESCALATED: "Verification escalated",
  SETTLEMENT_CREATED: "Settlement created",
  PUBLICATION_MARKED: "Publication marked",
  DELIVERY_CONFIRMED: "Delivery confirmed by customer",
  CONTENT_MARKED_READY: "Content marked ready",
  CONTENT_SUBMITTED_FOR_REVIEW: "Submitted for review",
  ORDER_ACCEPTED: "Order accepted by you",
  PAYMENT_CAPTURED: "Payment captured",
}

const WORKFLOW_STEPS = [
  { label: "Accept", statuses: ["SUBMITTED"] },
  {
    label: "Create",
    statuses: [
      "ACCEPTED",
      "CONTENT_REQUESTED",
      "CONTENT_CREATION",
      "CONTENT_READY",
    ],
  },
  { label: "Review", statuses: ["CUSTOMER_REVIEW", "APPROVED"] },
  { label: "Publish", statuses: ["PUBLISHED", "VERIFIED"] },
  { label: "Complete", statuses: ["DELIVERED", "SETTLED", "COMPLETED"] },
]

function getWorkflowStep(status: string): number {
  const idx = WORKFLOW_STEPS.findIndex((s) => s.statuses.includes(status))
  return idx === -1 ? 0 : idx
}

function OrderProgress({ status }: { status: string }) {
  const terminalMap: Record<string, { text: string; cls: string }> = {
    CANCELLED: { text: "Cancelled", cls: "bg-red-100 text-red-700" },
    REFUNDED: { text: "Refunded", cls: "bg-red-100 text-red-700" },
    DISPUTED: { text: "Disputed", cls: "bg-orange-100 text-orange-700" },
  }

  if (terminalMap[status]) {
    const t = terminalMap[status]
    return (
      <Card>
        <CardContent className={`flex items-center gap-2 py-3 ${t.cls}`}>
          <AlertCircle className="h-5 w-5 shrink-0" />
          <p className="text-sm font-medium">{t.text}</p>
        </CardContent>
      </Card>
    )
  }

  const current = getWorkflowStep(status)

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          {WORKFLOW_STEPS.map((step, i) => {
            const done = i < current
            const active = i === current
            return (
              <div
                key={step.label}
                className="flex flex-col items-center gap-2"
              >
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium ${
                    done
                      ? "bg-emerald-100 text-emerald-700"
                      : active
                        ? "bg-primary/10 text-primary ring-2 ring-primary/30"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {done ? <Check className="h-4 w-4" /> : i + 1}
                </div>
                <span
                  className={`text-xs ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}
                >
                  {step.label}
                </span>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { status: string }) {
  const p = getOrderStatusPresentation(status as OrderStatus)
  return (
    <UIStatusBadge variant={p.variant} className="gap-1.5">
      {p.label}
    </UIStatusBadge>
  )
}

function OrderDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-24" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-48" />
          <Skeleton className="h-32" />
        </div>
      </div>
    </div>
  )
}

function TimelineItem({ event, isLast }: { event: any; isLast: boolean }) {
  const label =
    eventLabels[event.eventType] ?? event.eventType.replace(/_/g, " ")
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        {!isLast && <div className="h-full w-px bg-border" />}
      </div>
      <div className="flex-1 pb-4">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(event.createdAt), { addSuffix: true })}
        </p>
      </div>
    </div>
  )
}

export default function OrderDetailPage() {
  const params = useParams()
  const orderId = params.id as string
  const queryClient = useQueryClient()
  const [publishedUrl, setPublishedUrl] = useState("")
  const [content, setContent] = useState("")
  const [attachments, setAttachments] = useState<File[]>([])

  const {
    data: order,
    isLoading,
    error,
  } = useQuery<any>({
    queryKey: ["order", orderId],
    queryFn: () => api.orders.getById(orderId),
  })

  const { data: proof } = useQuery<any>({
    queryKey: ["order-proof", orderId],
    queryFn: () => api.orders.deliveryProof(orderId),
    enabled:
      !!order &&
      [
        "PUBLISHED",
        "VERIFIED",
        "DELIVERED",
        "SETTLED",
        "COMPLETED",
        "DISPUTED",
      ].includes(order.status),
  })

  const { data: events = [] } = useQuery({
    queryKey: ["order-events", orderId],
    queryFn: () => api.orders.getEvents(orderId),
  })

  const refreshOrder = () => {
    queryClient.invalidateQueries({ queryKey: ["order", orderId] })
    queryClient.invalidateQueries({ queryKey: ["order-proof", orderId] })
    queryClient.invalidateQueries({ queryKey: ["order-events", orderId] })
  }

  const acceptMutation = useMutation({
    mutationFn: () => api.orders.accept(orderId),
    onSuccess: () => {
      toast.success("Order accepted")
      refreshOrder()
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to accept"),
  })

  const markPublishedMutation = useMutation({
    mutationFn: (url: string) => api.orders.markPublished(orderId, url),
    onSuccess: () => {
      toast.success("Marked as published")
      refreshOrder()
      setPublishedUrl("")
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to mark published"),
  })

  const contentSubmitMutation = useMutation({
    mutationFn: async (data: { content: string }) => {
      await api.orders.submitContent(orderId, data.content)
      await api.orders.markContentReady(orderId)
      await api.orders.submitForReview(orderId)
    },
    onSuccess: () => {
      toast.success("Content submitted")
      refreshOrder()
      setContent("")
      setAttachments([])
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to submit"),
  })

  if (error) {
    return (
      <ErrorState
        title="Failed to load order"
        description={(error as Error).message}
        onRetry={refreshOrder}
      />
    )
  }

  if (isLoading || !order) return <OrderDetailSkeleton />

  const s = order.status
  const canAccept = s === "SUBMITTED"
  const canSubmitContent = [
    "ACCEPTED",
    "CONTENT_REQUESTED",
    "CONTENT_CREATION",
  ].includes(s)
  const canMarkPublished = s === "APPROVED"
  const isVerifying =
    s === "PUBLISHED" &&
    proof?.hasDelivery &&
    ["PENDING", "RETRYING"].includes(proof.verificationStatus)
  const showDeliveryProof = proof?.hasDelivery
  const showSettlement = (order.settlements ?? []).length > 0
  const currentStatusConfig = statusConfig[s] ?? {
    icon: Clock,
    description: s.replace(/_/g, " "),
  }
  const CurrentIcon = currentStatusConfig.icon
  const allEvents = [
    ...(events.length > 0 ? events : (order.events ?? [])),
  ].sort(
    (a: any, b: any) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/dashboard/orders">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex items-center gap-3 flex-1">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-full ${VARIANT_CIRCLE_BG[s] ?? "bg-primary/10"}`}
          >
            <CurrentIcon className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">
                Order #{orderId.slice(0, 8)}
              </h1>
              <StatusBadge status={s} />
            </div>
            <p className="text-sm text-muted-foreground">
              {currentStatusConfig.description} &middot; Created{" "}
              {formatDistanceToNow(new Date(order.createdAt), {
                addSuffix: true,
              })}
            </p>
          </div>
        </div>
      </div>

      {/* Progress */}
      <OrderProgress status={s} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {/* Order Details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4" /> Order Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Service Type</p>
                  <p className="text-sm font-medium">
                    {order.type?.replace(/_/g, " ") ?? "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Price</p>
                  <p className="text-sm font-medium">
                    {order.totalAmount != null
                      ? `${order.currency ?? "USD"} ${Number(order.totalAmount).toFixed(2)}`
                      : "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Website</p>
                  <p className="text-sm font-medium">
                    {order.items?.[0]?.website?.url ?? "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Topic / Title</p>
                  <p className="text-sm font-medium">
                    {order.items?.[0]?.topic ?? order.title ?? "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Target URL</p>
                  {order.targetUrl ? (
                    <a
                      href={order.targetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                    >
                      {order.targetUrl} <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <p className="text-sm text-muted-foreground">—</p>
                  )}
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Anchor Text</p>
                  <p className="text-sm font-medium">
                    {order.anchorText ?? "—"}
                  </p>
                </div>
              </div>
              {order.instructions && (
                <>
                  <hr className="border-border" />
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Instructions
                    </p>
                    <p className="text-sm whitespace-pre-wrap">
                      {order.instructions}
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Accept Order */}
          {canAccept && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Accept Order</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm text-muted-foreground">
                  Accept this order to start working on the content.
                </p>
                <Button
                  onClick={() => acceptMutation.mutate()}
                  disabled={acceptMutation.isPending}
                >
                  <CheckCircle className="mr-2 h-4 w-4" />
                  {acceptMutation.isPending ? "Accepting..." : "Accept Order"}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Submit Content */}
          {canSubmitContent && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4" /> Submit Content
                </CardTitle>
                <CardDescription>
                  Submit your guest post content for customer review
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="content">Content</Label>
                  <Textarea
                    id="content"
                    rows={10}
                    placeholder="Paste your article content here..."
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Attachments</Label>
                  <div className="flex items-center gap-4">
                    <label className="flex h-10 cursor-pointer items-center gap-2 rounded-md border bg-background px-4 text-sm hover:bg-accent">
                      <Upload className="h-4 w-4" /> Upload Files
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) =>
                          setAttachments(Array.from(e.target.files ?? []))
                        }
                      />
                    </label>
                    {attachments.length > 0 && (
                      <span className="text-sm text-muted-foreground">
                        {attachments.length} file(s)
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  onClick={() => contentSubmitMutation.mutate({ content })}
                  disabled={contentSubmitMutation.isPending || !content.trim()}
                >
                  {contentSubmitMutation.isPending
                    ? "Submitting..."
                    : "Submit for Review"}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Mark Published */}
          {canMarkPublished && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Mark as Published</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Confirm the guest post has been published on the target
                  website.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="publishedUrl">Published URL</Label>
                  <Input
                    id="publishedUrl"
                    type="url"
                    placeholder="https://example.com/your-guest-post"
                    value={publishedUrl}
                    onChange={(e) => setPublishedUrl(e.target.value)}
                  />
                </div>
                <Button
                  onClick={() => markPublishedMutation.mutate(publishedUrl)}
                  disabled={markPublishedMutation.isPending || !publishedUrl}
                >
                  <ExternalLink className="mr-2 h-4 w-4" /> Mark as Published
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Verification in Progress */}
          {isVerifying && (
            <Card>
              <CardContent className="flex items-center gap-3 pt-6 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Automated verification is running. We&apos;re checking the live
                placement.
              </CardContent>
            </Card>
          )}

          {/* Delivery Proof */}
          {showDeliveryProof && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="h-5 w-5 text-green-600" /> Delivery
                  Verification
                </CardTitle>
                <CardDescription>
                  {proof.verifyMethod === "AUTO"
                    ? "Independently verified by the platform."
                    : proof.verifyMethod === "MANUAL_ADMIN"
                      ? "Verified by an admin reviewer."
                      : "Verified by customer confirmation."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Published URL</p>
                  <a
                    href={proof.publishedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm font-medium text-primary hover:underline break-all"
                  >
                    {proof.publishedUrl}{" "}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Verification:
                  </span>
                  <StatusBadge
                    status={
                      proof.verificationStatus === "VERIFIED"
                        ? "VERIFIED"
                        : proof.verificationStatus
                    }
                  />
                  {proof.verifyMethod && (
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        proof.verifyMethod === "AUTO"
                          ? "bg-emerald-100 text-emerald-700"
                          : proof.verifyMethod === "MANUAL_ADMIN"
                            ? "bg-blue-100 text-blue-700"
                            : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {proof.verifyMethod === "AUTO"
                        ? "Auto"
                        : proof.verifyMethod === "MANUAL_ADMIN"
                          ? "Admin"
                          : "Customer"}
                    </span>
                  )}
                </div>
                {proof.results && (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {[
                      ["URL Reachable", proof.results.urlReachable],
                      ["Link Found", proof.results.linkFound],
                      ["Target URL Matched", proof.results.targetUrlMatched],
                      ["Anchor Verified", proof.results.anchorVerified],
                    ].map(([label, ok]) => (
                      <div
                        key={label as string}
                        className="flex items-center gap-2"
                      >
                        {ok ? (
                          <CheckCircle className="h-4 w-4 text-green-600" />
                        ) : (
                          <XCircle className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className={ok ? "" : "text-muted-foreground"}>
                          {label as string}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-2">
                  {proof.submittedAt && (
                    <span>
                      Submitted: {format(new Date(proof.submittedAt), "PPp")}
                    </span>
                  )}
                  {proof.verifiedAt && (
                    <span>
                      Verified: {format(new Date(proof.verifiedAt), "PPp")}
                    </span>
                  )}
                  {proof.results?.checkedAt && (
                    <span>
                      Checked:{" "}
                      {format(new Date(proof.results.checkedAt), "PPp")}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Settlement */}
          {showSettlement &&
            (order.settlements ?? []).map((s: any) => (
              <Card key={s.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <DollarSign className="h-4 w-4" /> Settlement
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      Status:
                    </span>
                    <StatusBadge status={s.status} />
                    {s.releasePolicy && (
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          s.releasePolicy === "AUTO"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {s.releasePolicy}
                      </span>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        Gross Amount
                      </p>
                      <p className="text-sm font-medium font-mono">
                        {order.currency ?? "USD"}{" "}
                        {Number(s.grossAmount ?? s.amount ?? 0).toFixed(2)}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        Platform Fee
                      </p>
                      <p className="text-sm font-medium font-mono">
                        {order.currency ?? "USD"}{" "}
                        {Number(s.platformFee ?? 0).toFixed(2)}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        Your Payout
                      </p>
                      <p className="text-sm font-medium font-mono">
                        {order.currency ?? "USD"}{" "}
                        {Number(s.publisherAmount ?? s.amount ?? 0).toFixed(2)}
                      </p>
                    </div>
                  </div>
                  {s.reviewEndsAt &&
                    ["PENDING", "UNDER_REVIEW"].includes(s.status) && (
                      <div className="flex items-center gap-2 text-sm">
                        <Clock className="h-4 w-4 text-blue-600" />
                        <span>
                          Review window ends{" "}
                          {format(new Date(s.reviewEndsAt), "PPp")}
                          {(() => {
                            const remaining = Math.ceil(
                              (new Date(s.reviewEndsAt).getTime() -
                                Date.now()) /
                                (1000 * 60 * 60 * 24),
                            )
                            if (remaining <= 0)
                              return (
                                <span className="text-amber-600 font-medium">
                                  {" "}
                                  (due now)
                                </span>
                              )
                            if (remaining === 1)
                              return (
                                <span className="text-amber-600 font-medium">
                                  {" "}
                                  (1 day remaining)
                                </span>
                              )
                            return (
                              <span className="text-muted-foreground">
                                {" "}
                                ({remaining} days remaining)
                              </span>
                            )
                          })()}
                        </span>
                      </div>
                    )}
                </CardContent>
              </Card>
            ))}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Timeline */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              {allEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground">No events yet</p>
              ) : (
                <div className="space-y-0">
                  {allEvents.map((event: any, i: number) => (
                    <TimelineItem
                      key={event.id}
                      event={event}
                      isLast={i === allEvents.length - 1}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quick Actions */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start"
                asChild
              >
                <Link
                  href={`/dashboard/support?new=true&subject=Order%20${orderId}`}
                >
                  <MessageSquare className="mr-2 h-4 w-4" /> Contact Support
                </Link>
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => {
                  const blob = new Blob(
                    [
                      JSON.stringify(
                        {
                          orderId,
                          amount: order.totalAmount,
                          date: order.createdAt,
                        },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json" },
                  )
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement("a")
                  a.href = url
                  a.download = `invoice-${orderId.slice(0, 8)}.json`
                  a.click()
                  URL.revokeObjectURL(url)
                  toast.success("Invoice downloaded")
                }}
              >
                <Download className="mr-2 h-4 w-4" /> Download Invoice
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
