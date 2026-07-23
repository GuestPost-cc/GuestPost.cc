"use client"

import type { CancellationReasonCode } from "@guestpost/api-client"
import type { OrderStatus } from "@guestpost/shared"
import {
  BriefRenderer,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  getOrderStatusPresentation,
  Input,
  Label,
  OrderLifecycleProgress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  StatusBadge as UIStatusBadge,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format, formatDistanceToNow } from "date-fns"
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle,
  Clock,
  DollarSign,
  ExternalLink,
  FileText,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../../lib/api"
import {
  formatPublisherMoney,
  getOrderDueState,
  getPublisherNextAction,
} from "../../../../lib/publisher-order-workflow"

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

function OrderProgress({ status }: { status: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <OrderLifecycleProgress status={status} />
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
  const [showCancellationDialog, setShowCancellationDialog] = useState(false)
  const [cancellationReason, setCancellationReason] =
    useState<CancellationReasonCode>("CAPACITY_UNAVAILABLE")
  const [cancellationNote, setCancellationNote] = useState("")
  const [cancellationResponseNote, setCancellationResponseNote] = useState("")

  const {
    data: order,
    isLoading,
    error,
  } = useQuery<any>({
    queryKey: ["order", orderId],
    queryFn: () => api.orders.getById(orderId),
  })

  const { data: cancellationPreview } = useQuery({
    queryKey: ["order-cancellation-preview", orderId],
    queryFn: () => api.orders.cancellationPreview(orderId),
    enabled: Boolean(order),
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

  const cancellationMutation = useMutation({
    mutationFn: async () => {
      if (!cancellationPreview)
        throw new Error("Cancellation policy unavailable")
      const data = {
        reasonCode: cancellationReason,
        note: cancellationNote.trim() || undefined,
        expectedVersion: cancellationPreview.expectedVersion,
        idempotencyKey: `publisher-${orderId}-${cancellationPreview.expectedVersion}`,
      }
      if (cancellationPreview.action === "DECLINE_NOW") {
        return api.orders.decline(orderId, data)
      }
      if (cancellationPreview.action === "REQUEST_CANCELLATION") {
        return api.orders.requestCancellation(orderId, data)
      }
      throw new Error(cancellationPreview.message)
    },
    onSuccess: () => {
      toast.success(
        cancellationPreview?.action === "DECLINE_NOW"
          ? "Order declined and customer refunded"
          : "Cancellation request sent to the customer",
      )
      setShowCancellationDialog(false)
      setCancellationNote("")
      refreshOrder()
    },
    onError: (error: Error) =>
      toast.error(error.message || "Failed to process cancellation"),
  })

  const respondToCancellationMutation = useMutation({
    mutationFn: (action: "ACCEPT" | "CONTEST") => {
      const request = cancellationPreview?.activeRequest
      if (!request) throw new Error("No active cancellation request")
      return api.orders.respondToCancellation(
        orderId,
        request.id,
        action,
        cancellationResponseNote.trim() || undefined,
      )
    },
    onSuccess: (_data, action) => {
      toast.success(
        action === "ACCEPT"
          ? "Cancellation accepted; customer refunded"
          : "Cancellation contested and sent for staff review",
      )
      setCancellationResponseNote("")
      refreshOrder()
      queryClient.invalidateQueries({
        queryKey: ["order-cancellation-preview", orderId],
      })
    },
    onError: (error: Error) => toast.error(error.message || "Response failed"),
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
  const due = getOrderDueState(order)
  const nextAction = getPublisherNextAction(order)
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
  const statusPresentation = getOrderStatusPresentation(s as OrderStatus)
  const CurrentIcon = currentStatusConfig.icon
  const websiteUrl =
    order.website?.url ??
    order.items?.[0]?.website?.url ??
    "Website unavailable"
  const latestRevision = [...(order.revisions ?? [])].sort(
    (left: any, right: any) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  )[0]
  const allEvents = [
    ...(events.length > 0 ? events : (order.events ?? [])),
  ].sort(
    (a: any, b: any) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  const hasPrimaryAction =
    canAccept ||
    canSubmitContent ||
    canMarkPublished ||
    (cancellationPreview?.activeRequest?.status === "REQUESTED" &&
      cancellationPreview.activeRequest.requesterType === "CUSTOMER")

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card className="overflow-hidden rounded-2xl shadow-sm">
        <CardContent className="p-0">
          <div className="flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 items-start gap-3 sm:gap-4">
              <Button variant="ghost" size="icon" className="shrink-0" asChild>
                <Link href="/dashboard/orders" aria-label="Back to orders">
                  <ArrowLeft className="h-4 w-4" />
                </Link>
              </Button>
              <div
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${VARIANT_CIRCLE_BG[statusPresentation.variant] ?? "bg-primary/10 text-primary"}`}
              >
                <CurrentIcon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                    Order #{orderId.slice(0, 8)}
                  </h1>
                  <StatusBadge status={s} />
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  {websiteUrl} · {order.type.replaceAll("_", " ").toLowerCase()}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {currentStatusConfig.description} · Created{" "}
                  {formatDistanceToNow(new Date(order.createdAt), {
                    addSuffix: true,
                  })}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:min-w-[430px]">
              <div className="rounded-xl border bg-muted/30 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Order value
                </p>
                <p className="mt-1 font-semibold tabular-nums">
                  {formatPublisherMoney(order.totalAmount, order.currency)}
                </p>
              </div>
              <div className="rounded-xl border bg-muted/30 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Deadline
                </p>
                <p
                  className={`mt-1 text-sm font-semibold ${
                    due.risk === "overdue"
                      ? "text-red-700"
                      : due.risk === "soon"
                        ? "text-amber-700"
                        : ""
                  }`}
                >
                  {due.label}
                </p>
              </div>
              <div className="col-span-2 rounded-xl border bg-muted/30 p-3 sm:col-span-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Turnaround
                </p>
                <p className="mt-1 text-sm font-semibold">
                  {order.turnaroundDays
                    ? `${order.turnaroundDays} days`
                    : "Not specified"}
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-3 border-t bg-muted/30 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Next step
              </p>
              <p className="mt-0.5 font-semibold">{nextAction.label}</p>
            </div>
            {hasPrimaryAction ? (
              <Button asChild>
                <a href="#order-action">
                  Continue workflow <ArrowRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                No action is required from you right now.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Progress */}
      <OrderProgress status={s} />

      {cancellationPreview?.activeRequest?.status === "REQUESTED" &&
        cancellationPreview.activeRequest.requesterType === "CUSTOMER" && (
          <Card
            id="order-action"
            className="scroll-mt-24 border-amber-300 bg-amber-50/50"
          >
            <CardHeader>
              <CardTitle className="text-base">
                Cancellation response needed
              </CardTitle>
              <CardDescription>
                The customer requested cancellation for{" "}
                {cancellationPreview.activeRequest.reasonCode
                  .replaceAll("_", " ")
                  .toLowerCase()}
                . Accepting issues the full wallet refund. Contesting sends the
                case to staff review.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {cancellationPreview.actorCanMutate ? (
                <>
                  <Textarea
                    value={cancellationResponseNote}
                    onChange={(event) =>
                      setCancellationResponseNote(event.target.value)
                    }
                    placeholder="Optional response details"
                    rows={3}
                    maxLength={2000}
                  />
                  <div className="flex gap-2">
                    <Button
                      onClick={() =>
                        respondToCancellationMutation.mutate("ACCEPT")
                      }
                      disabled={respondToCancellationMutation.isPending}
                    >
                      Accept and Refund
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        respondToCancellationMutation.mutate("CONTEST")
                      }
                      disabled={respondToCancellationMutation.isPending}
                    >
                      Contest
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  A publisher owner must respond to this request.
                </p>
              )}
            </CardContent>
          </Card>
        )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {/* Order Details */}
          <Card className="rounded-2xl shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4" /> Order brief
              </CardTitle>
              <CardDescription>
                Review every requirement before accepting or publishing this
                order.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BriefRenderer
                serviceType={order.type}
                briefData={order.briefData}
                fallback={{
                  title: order.title,
                  instructions: order.instructions,
                  targetUrl: order.targetUrl ?? order.items?.[0]?.targetUrl,
                  anchorText: order.anchorText ?? order.items?.[0]?.anchorText,
                }}
              />
            </CardContent>
          </Card>

          {/* Accept Order */}
          {canAccept && (
            <Card
              id="order-action"
              className="scroll-mt-24 rounded-2xl border-primary/20 shadow-sm"
            >
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
                {cancellationPreview?.action === "DECLINE_NOW" && (
                  <Button
                    variant="outline"
                    className="ml-2"
                    onClick={() => setShowCancellationDialog(true)}
                  >
                    Decline and Refund
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {/* Submit Content */}
          {canSubmitContent && (
            <Card
              id="order-action"
              className="scroll-mt-24 rounded-2xl border-primary/20 shadow-sm"
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4" /> Submit Content
                </CardTitle>
                <CardDescription>
                  Submit your guest post content for customer review
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {latestRevision?.notes &&
                  ["REQUESTED", "CHANGES_REQUESTED"].includes(
                    latestRevision.status,
                  ) && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                      <p className="text-sm font-semibold text-amber-900">
                        Requested changes
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-amber-800">
                        {latestRevision.notes}
                      </p>
                    </div>
                  )}
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
            <Card
              id="order-action"
              className="scroll-mt-24 rounded-2xl border-primary/20 shadow-sm"
            >
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
                  href={`/dashboard/support?new=true&orderId=${encodeURIComponent(orderId)}&subject=${encodeURIComponent(`Order ${orderId.slice(0, 8)}`)}`}
                >
                  <MessageSquare className="mr-2 h-4 w-4" /> Contact Support
                </Link>
              </Button>
              {cancellationPreview?.action === "REQUEST_CANCELLATION" && (
                <Button
                  variant="outline"
                  className="w-full justify-start text-destructive"
                  onClick={() => setShowCancellationDialog(true)}
                >
                  <XCircle className="mr-2 h-4 w-4" /> Request Cancellation
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog
        open={showCancellationDialog}
        onOpenChange={setShowCancellationDialog}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {cancellationPreview?.action === "DECLINE_NOW"
                ? "Decline Order"
                : "Request Cancellation"}
            </DialogTitle>
            <DialogDescription>
              {cancellationPreview?.message}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Reason</Label>
              <Select
                value={cancellationReason}
                onValueChange={(value) =>
                  setCancellationReason(value as CancellationReasonCode)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CAPACITY_UNAVAILABLE">
                    Capacity unavailable
                  </SelectItem>
                  <SelectItem value="TOPIC_UNSUITABLE">
                    Topic unsuitable
                  </SelectItem>
                  <SelectItem value="WEBSITE_UNAVAILABLE">
                    Website unavailable
                  </SelectItem>
                  <SelectItem value="PRICING_ERROR">Pricing error</SelectItem>
                  <SelectItem value="POLICY_CONFLICT">
                    Policy conflict
                  </SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="publisher-cancellation-note">Details</Label>
              <Textarea
                id="publisher-cancellation-note"
                rows={4}
                value={cancellationNote}
                onChange={(event) => setCancellationNote(event.target.value)}
                placeholder="Explain why this order cannot continue"
                maxLength={2000}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCancellationDialog(false)}
            >
              Keep Order
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancellationMutation.mutate()}
              disabled={cancellationMutation.isPending}
            >
              {cancellationMutation.isPending
                ? "Submitting…"
                : cancellationPreview?.action === "DECLINE_NOW"
                  ? "Decline and Refund"
                  : "Send Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
