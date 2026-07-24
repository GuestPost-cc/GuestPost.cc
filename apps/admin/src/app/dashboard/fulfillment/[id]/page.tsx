"use client"

import type {
  CancellationReasonCode,
  OperationsOrderDetail,
} from "@guestpost/api-client"
import { type OrderStatus } from "@guestpost/shared"
import {
  Badge,
  Button,
  Card,
  CardContent,
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
  Separator,
  Skeleton,
  Textarea,
  StatusBadge as UIStatusBadge,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format, formatDistanceToNowStrict, isPast } from "date-fns"
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  Link2,
  MessageSquare,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Upload,
  UserPlus,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  AdminPage,
  AdminPageHeader,
} from "../../../../components/admin-workspace"
import { api } from "../../../../lib/api"
import { ForbiddenPage, useRequireRole } from "../../../../lib/use-require-role"

const cancellationReasons: Array<{
  value: CancellationReasonCode
  label: string
}> = [
  { value: "CAPACITY_UNAVAILABLE", label: "Capacity unavailable" },
  { value: "TOPIC_UNSUITABLE", label: "Topic unsuitable" },
  { value: "WEBSITE_UNAVAILABLE", label: "Website unavailable" },
  { value: "PRICING_ERROR", label: "Pricing error" },
  { value: "POLICY_CONFLICT", label: "Policy conflict" },
  { value: "MISSED_DEADLINE", label: "Missed deadline" },
  { value: "QUALITY_FAILURE", label: "Quality issue" },
  { value: "LEGAL_OR_SECURITY_EMERGENCY", label: "Legal or security issue" },
  { value: "OTHER", label: "Other" },
]

const activeCancellationStatuses = new Set([
  "REQUESTED",
  "UNDER_REVIEW",
  "PENDING_FINANCE",
  "ESCALATED",
  "APPROVED",
])

const eventLabels: Record<string, string> = {
  ORDER_CREATED: "Order created",
  PAYMENT_RECEIVED: "Payment received",
  ASSIGNED: "Writer assigned",
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
  VERIFIED_MANUAL: "Manually verified by admin",
  AUTO_ACCEPTED: "Auto-accepted (review window expired)",
  REVIEW_REMINDER: "Review reminder sent",
  VERIFICATION_ESCALATED: "Verification escalated",
  DISPUTE_OPENED: "Dispute opened",
  DISPUTE_RESOLVED: "Dispute resolved",
  FORCE_CANCELLED: "Force cancelled by admin",
  REFUND_ISSUED: "Refund issued by admin",
  SETTLEMENT_CREATED: "Settlement created",
  ORDER_CANCELLED: "Order cancelled",
  PAYMENT_CAPTURED: "Payment captured",
  PAYMENT_SUBMITTED: "Payment submitted",
  ORDER_ACCEPTED: "Order accepted",
  CONTENT_MARKED_READY: "Content marked ready",
  CONTENT_SUBMITTED_FOR_REVIEW: "Content submitted for review",
  REVISION_REQUESTED: "Revision requested",
  PUBLICATION_MARKED: "Publication marked",
  DELIVERY_CONFIRMED: "Delivery confirmed",
  ITEM_ADDED: "Item added",
  ITEM_REMOVED: "Item removed",
}

const eventIcons = {
  ORDER_CREATED: FileText,
  PAYMENT_RECEIVED: Check,
  ASSIGNED: UserPlus,
  CONTENT_SUBMITTED: FileText,
  CONTENT_APPROVED: Check,
  PUBLISHED: Check,
  VERIFIED: CheckCircle2,
  UNDER_REVIEW: Clock3,
  DELIVERED: CheckCircle2,
  SETTLED: CheckCircle2,
  COMPLETED: CheckCircle2,
  CANCELLED: XCircle,
  REFUNDED: RefreshCw,
  DISPUTED: AlertCircle,
  REJECTED: XCircle,
  VERIFIED_AUTO: CheckCircle2,
  VERIFIED_MANUAL: CheckCircle2,
  AUTO_ACCEPTED: CheckCircle2,
  REVIEW_REMINDER: MessageSquare,
  VERIFICATION_ESCALATED: AlertCircle,
  DISPUTE_OPENED: AlertCircle,
  DISPUTE_RESOLVED: ShieldCheck,
  FORCE_CANCELLED: XCircle,
  REFUND_ISSUED: RefreshCw,
  SETTLEMENT_CREATED: CheckCircle2,
  ORDER_CANCELLED: XCircle,
  PAYMENT_CAPTURED: Check,
  PAYMENT_SUBMITTED: Check,
  ORDER_ACCEPTED: Check,
  CONTENT_MARKED_READY: FileText,
  CONTENT_SUBMITTED_FOR_REVIEW: FileText,
  REVISION_REQUESTED: MessageSquare,
  PUBLICATION_MARKED: CheckCircle2,
  DELIVERY_CONFIRMED: CheckCircle2,
  ITEM_ADDED: FileText,
  ITEM_REMOVED: FileText,
}

function formatMoney(value: string | number | null, currency: string): string {
  if (value == null) return "—"
  const amount = typeof value === "string" ? Number(value) : value
  if (!Number.isFinite(amount)) return "—"
  return `${currency} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Time unavailable"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Time unavailable" : format(date, "PPp")
}

function eventDetail(event: {
  message?: string | null
  metadata?: Record<string, unknown> | null
  eventType: string
}): string | null {
  if (event.message?.trim()) return event.message.trim()

  const m = (event.metadata ?? {}) as Record<string, unknown>
  const parts: string[] = []
  const url = m.publishedUrl ?? m.url

  if (url) parts.push(`Published at ${String(url)}`)
  if (m.reason) parts.push(`Reason: ${String(m.reason)}`)
  if (m.notes) parts.push(String(m.notes))
  if (m.newStatus)
    parts.push(
      `Status → ${String(m.newStatus).replace(/_/g, " ").toLowerCase()}`,
    )
  if (typeof m.amount === "number") {
    parts.push(`Amount: $${m.amount.toLocaleString()}`)
  }
  if (m.assignedTo) parts.push(`Assigned to ${String(m.assignedTo)}`)
  if (m.adminName) parts.push(`By ${String(m.adminName)}`)
  if (m.version != null) parts.push(`Revision v${m.version}`)
  if (m.action)
    parts.push(`Action: ${String(m.action).replace(/_/g, " ").toLowerCase()}`)
  return parts.length ? parts.join(" · ") : null
}

function StatusBadge({ status }: { status: string }) {
  const p = getOrderStatusPresentation(status as OrderStatus)
  return <UIStatusBadge variant={p.variant}>{p.label}</UIStatusBadge>
}

function OrderTimeline({
  events,
}: {
  events: OperationsOrderDetail["events"]
}) {
  const sortedEvents = [...events].sort(
    (left, right) =>
      (Number.isNaN(new Date(right.createdAt).getTime())
        ? 0
        : new Date(right.createdAt).getTime()) -
      (Number.isNaN(new Date(left.createdAt).getTime())
        ? 0
        : new Date(left.createdAt).getTime()),
  )

  if (!sortedEvents.length) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No timeline events are visible for your role yet.
      </p>
    )
  }

  return (
    <div className="relative">
      <div className="absolute left-4 top-0 h-full w-px bg-border" />
      <div className="space-y-6">
        {sortedEvents.map((event, index) => {
          const isLatest = index === 0
          const iconKey = event.eventType
          const iconEntry =
            event.eventType in eventIcons
              ? (eventIcons as Record<string, typeof Check>)[iconKey]
              : Check
          const detail = eventDetail(event)
          const createdAt = new Date(event.createdAt)
          const createdAtLabel = Number.isNaN(createdAt.getTime())
            ? "Time unavailable"
            : formatDateTime(event.createdAt)
          const distanceLabel = Number.isNaN(createdAt.getTime())
            ? "Time unavailable"
            : formatDistanceToNowStrict(createdAt, { addSuffix: true })

          return (
            <div key={event.id} className="relative pl-10">
              <div
                className={`absolute left-2.5 top-1 flex h-5 w-5 items-center justify-center rounded-full ${
                  isLatest ? "bg-primary" : "bg-muted"
                }`}
              >
                {(() => {
                  const Icon = iconEntry
                  return (
                    <Icon
                      className={`h-3 w-3 ${
                        isLatest
                          ? "text-primary-foreground"
                          : "text-muted-foreground"
                      }`}
                    />
                  )
                })()}
              </div>
              <div className="flex flex-col">
                <span className="font-medium">
                  {eventLabels[event.eventType] ||
                    event.eventType
                      .replace(/_/g, " ")
                      .toLowerCase()
                      .replace(/\b\w/g, (c) => c.toUpperCase())}
                </span>
                {detail ? (
                  <span className="mt-0.5 break-words text-sm text-muted-foreground">
                    {detail}
                  </span>
                ) : null}
                <span
                  className="mt-0.5 text-xs text-muted-foreground"
                  title={createdAtLabel}
                >
                  {distanceLabel}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function formatBrief(brief: Record<string, unknown> | null) {
  if (!brief) return []
  return Object.entries(brief).filter(
    ([, value]) => value !== null && value !== undefined && value !== "",
  )
}

function OrderArticleVersions({
  articles,
}: {
  articles: OperationsOrderDetail["articleVersions"]
}) {
  if (articles.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Article versions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {articles.map((article) => {
          const timestamp = new Date(article.createdAt)
          return (
            <section
              key={article.id}
              className="overflow-hidden rounded-lg border"
            >
              <header className="flex flex-wrap items-start justify-between gap-3 bg-muted/40 px-3 py-2">
                <div>
                  <p className="text-sm font-semibold">
                    {article.purpose === "SOURCE_ARTICLE"
                      ? "Customer source article"
                      : "Operations submission"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Version {article.version} · {article.wordCount} words
                  </p>
                </div>
                <time className="text-xs text-muted-foreground">
                  {Number.isNaN(timestamp.getTime())
                    ? "Time unavailable"
                    : timestamp.toLocaleString()}
                </time>
              </header>
              {article.title && (
                <p className="border-b px-3 py-2 text-sm font-medium">
                  {article.title}
                </p>
              )}
              <div className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-3 text-sm leading-6">
                {article.body}
              </div>
            </section>
          )
        })}
      </CardContent>
    </Card>
  )
}

function OrderContext({ order }: { order: OperationsOrderDetail }) {
  const brief = formatBrief(order.briefData)
  const item = order.items[0]
  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="text-xs font-medium uppercase text-muted-foreground">
          Website
        </div>
        <div className="mt-1 font-medium">
          {order.website?.domain ?? order.website?.url ?? "Not set"}
        </div>
      </div>
      <div>
        <div className="text-xs font-medium uppercase text-muted-foreground">
          Service
        </div>
        <div className="mt-1 capitalize">
          {order.type.replaceAll("_", " ").toLowerCase()}
        </div>
      </div>
      {(item?.targetUrl || order.targetUrl) && (
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Target URL
          </div>
          <a
            href={item?.targetUrl ?? order.targetUrl ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block break-all text-primary hover:underline"
          >
            {item?.targetUrl ?? order.targetUrl}
          </a>
        </div>
      )}
      {(item?.anchorText || order.anchorText) && (
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Anchor text
          </div>
          <div className="mt-1">{item?.anchorText ?? order.anchorText}</div>
        </div>
      )}
      {order.instructions && (
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Instructions
          </div>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
            {order.instructions}
          </p>
        </div>
      )}
      {brief.map(([key, value]) => (
        <div key={key}>
          <div className="text-xs font-medium uppercase text-muted-foreground">
            {key.replaceAll("_", " ")}
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </div>
        </div>
      ))}
    </div>
  )
}

function CancellationDialog({
  order,
  open,
  onOpenChange,
}: {
  order: OperationsOrderDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState<CancellationReasonCode>(
    "CAPACITY_UNAVAILABLE",
  )
  const [note, setNote] = useState("")
  const preview = useQuery({
    queryKey: ["platform-cancellation-preview", order.id, order.version],
    queryFn: () => api.admin.previewPlatformCancellation(order.id),
    enabled: open,
    retry: false,
  })
  const cancel = useMutation({
    mutationFn: async () => {
      if (!preview.data) throw new Error("Cancellation policy unavailable")
      const data = {
        reasonCode: reason,
        note: note.trim() || undefined,
        expectedVersion: order.version,
        idempotencyKey: `operations-${order.id}-${order.version}`,
      }
      if (preview.data.action === "DECLINE_NOW") {
        return api.admin.declinePlatformOrder(order.id, data)
      }
      if (preview.data.action === "REQUEST_CANCELLATION") {
        return api.admin.requestPlatformCancellation(order.id, data)
      }
      throw new Error(preview.data.message)
    },
    onSuccess: async () => {
      toast.success(
        preview.data?.action === "DECLINE_NOW"
          ? "Order declined"
          : "Cancellation request created",
      )
      onOpenChange(false)
      await queryClient.invalidateQueries({
        queryKey: ["operations-order", order.id],
      })
      await queryClient.invalidateQueries({ queryKey: ["operations-inbox"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancellation</DialogTitle>
          <DialogDescription>
            {preview.isLoading
              ? "Checking cancellation policy..."
              : (preview.data?.message ?? preview.error?.message)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Reason</Label>
            <Select
              value={reason}
              onValueChange={(value) =>
                setReason(value as CancellationReasonCode)
              }
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {cancellationReasons.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="cancellation-note">Note</Label>
            <Textarea
              id="cancellation-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
              rows={4}
              className="mt-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep order
          </Button>
          <Button
            variant="destructive"
            onClick={() => cancel.mutate()}
            disabled={
              preview.isLoading ||
              cancel.isPending ||
              !preview.data ||
              !["DECLINE_NOW", "REQUEST_CANCELLATION"].includes(
                preview.data.action,
              )
            }
          >
            {cancel.isPending ? "Submitting..." : "Continue cancellation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function FulfillmentOrderPage() {
  const { allowed, loading } = useRequireRole("SUPER_ADMIN", "OPERATIONS")
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Operations or Super Admin" />
  return <FulfillmentOrderPageInner />
}

function FulfillmentOrderPageInner() {
  const params = useParams<{ id: string }>()
  const orderId = params.id
  const queryClient = useQueryClient()
  const [content, setContent] = useState("")
  const [contentDirty, setContentDirty] = useState(false)
  const [publishedUrl, setPublishedUrl] = useState("")
  const [articleTitle, setArticleTitle] = useState("")
  const [deliveryNotes, setDeliveryNotes] = useState("")
  const [cancelOpen, setCancelOpen] = useState(false)

  const query = useQuery({
    queryKey: ["operations-order", orderId],
    queryFn: () => api.admin.operationsOrder(orderId),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const order = query.data

  useEffect(() => {
    if (!order || contentDirty) return
    setContent(order.contentOrder?.brief ?? "")
  }, [order, contentDirty])

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: ["operations-order", orderId],
    })
    await queryClient.invalidateQueries({ queryKey: ["operations-inbox"] })
  }

  const claim = useMutation({
    mutationFn: () => api.admin.claimOrder(orderId),
    onSuccess: async () => {
      toast.success("Order claimed")
      await refresh()
    },
    onError: async (error: Error) => {
      toast.error(error.message)
      await refresh()
    },
  })
  const accept = useMutation({
    mutationFn: () => api.admin.acceptPlatformOrder(orderId),
    onSuccess: async () => {
      toast.success("Order accepted")
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const saveDraft = useMutation({
    mutationFn: () => api.admin.savePlatformContent(orderId, content.trim()),
    onSuccess: async () => {
      setContentDirty(false)
      toast.success("Draft saved")
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const submitReview = useMutation({
    mutationFn: () =>
      api.admin.submitPlatformContentForReview(orderId, content.trim()),
    onSuccess: async () => {
      setContentDirty(false)
      toast.success("Content sent for customer review")
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const publish = useMutation({
    mutationFn: () =>
      api.admin.submitPlatformDelivery(orderId, {
        publishedUrl: publishedUrl.trim(),
        articleTitle: articleTitle.trim() || undefined,
        notes: deliveryNotes.trim() || undefined,
      }),
    onSuccess: async () => {
      toast.success("Publication submitted for verification")
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const respondCancellation = useMutation({
    mutationFn: ({
      requestId,
      action,
    }: {
      requestId: string
      action: "ACCEPT" | "CONTEST"
    }) => api.admin.respondToPlatformCancellation(orderId, requestId, action),
    onSuccess: async () => {
      toast.success("Cancellation response recorded")
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const activeCancellation = useMemo(
    () =>
      order?.cancellationRequests.find((request) =>
        activeCancellationStatuses.has(request.status),
      ) ?? null,
    [order],
  )
  const latestRevision = order?.revisions[0] ?? null

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-20 w-full" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Skeleton className="h-[520px] w-full" />
          <Skeleton className="h-[420px] w-full" />
        </div>
      </div>
    )
  }
  if (query.error || !order) {
    return (
      <ErrorState
        title="Fulfillment order unavailable"
        description={query.error?.message ?? "Order not found"}
        onRetry={() => query.refetch()}
      />
    )
  }

  const dueDate = order.fulfillmentDueAt
    ? new Date(order.fulfillmentDueAt)
    : null
  const blocked = Boolean(activeCancellation)
  const contentStatus = [
    "ACCEPTED",
    "CONTENT_REQUESTED",
    "CONTENT_CREATION",
    "CONTENT_READY",
  ].includes(order.status)

  return (
    <AdminPage>
      <AdminPageHeader
        title={order.title || order.type.replaceAll("_", " ")}
        description={`${order.id}${
          dueDate
            ? ` · ${isPast(dueDate) ? "Overdue" : "Due"} ${formatDistanceToNowStrict(dueDate)}`
            : ""
        }`}
        eyebrow="Fulfillment order"
        icon={Upload}
        badges={
          <>
            <StatusBadge status={order.status} />
            <Badge variant="secondary">Platform fulfilled</Badge>
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/fulfillment">
                <ArrowLeft className="h-4 w-4" />
                Fulfillment
              </Link>
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
              title="Refresh order"
            >
              <RefreshCw
                className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`}
              />
            </Button>
            {order.access.canProgress && !blocked && (
              <Button variant="outline" onClick={() => setCancelOpen(true)}>
                <XCircle className="h-4 w-4" />
                Cancellation
              </Button>
            )}
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lifecycle progress</CardTitle>
          <p className="text-sm text-muted-foreground">
            Canonical stage map and current progress checkpoint
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto pb-6">
          <OrderLifecycleProgress status={order.status} />
        </CardContent>
      </Card>

      {activeCancellation && (
        <div className="border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 text-destructive" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">Cancellation in progress</div>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeCancellation.note ||
                  activeCancellation.reasonCode.replaceAll("_", " ")}
              </p>
              {activeCancellation.requesterType === "CUSTOMER" &&
                activeCancellation.status === "REQUESTED" &&
                order.access.canProgress && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() =>
                        respondCancellation.mutate({
                          requestId: activeCancellation.id,
                          action: "ACCEPT",
                        })
                      }
                    >
                      Accept cancellation
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        respondCancellation.mutate({
                          requestId: activeCancellation.id,
                          action: "CONTEST",
                        })
                      }
                    >
                      Contest
                    </Button>
                  </div>
                )}
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <FileText className="h-5 w-5" />
                Current task
              </CardTitle>
            </CardHeader>
            <CardContent>
              {order.access.claimable ? (
                <div className="py-8 text-center">
                  <UserPlus className="mx-auto h-10 w-10 text-muted-foreground" />
                  <h2 className="mt-4 text-lg font-semibold">
                    Available to claim
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Claiming gives you exclusive fulfillment access to this
                    order.
                  </p>
                  <Button
                    className="mt-5"
                    onClick={() => claim.mutate()}
                    disabled={claim.isPending}
                  >
                    <UserPlus className="h-4 w-4" />
                    {claim.isPending ? "Claiming..." : "Claim & start"}
                  </Button>
                </div>
              ) : order.status === "SUBMITTED" ? (
                <div className="py-8 text-center">
                  <Clock3 className="mx-auto h-10 w-10 text-muted-foreground" />
                  <h2 className="mt-4 text-lg font-semibold">
                    Accept the order
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    The fulfillment due date starts when the order is accepted.
                  </p>
                  <Button
                    className="mt-5"
                    onClick={() => accept.mutate()}
                    disabled={
                      accept.isPending || blocked || !order.access.canProgress
                    }
                  >
                    <Check className="h-4 w-4" />
                    {accept.isPending ? "Accepting..." : "Accept order"}
                  </Button>
                </div>
              ) : contentStatus ? (
                <div className="space-y-4">
                  {order.status === "CONTENT_REQUESTED" && latestRevision && (
                    <div className="border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                      <div className="flex items-center gap-2 font-semibold">
                        <MessageSquare className="h-4 w-4" />
                        Revision requested
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm">
                        {latestRevision.notes ||
                          "The customer requested changes."}
                      </p>
                    </div>
                  )}
                  <div>
                    <Label htmlFor="content-draft">Article content</Label>
                    <Textarea
                      id="content-draft"
                      value={content}
                      onChange={(event) => {
                        setContent(event.target.value)
                        setContentDirty(true)
                      }}
                      rows={18}
                      maxLength={200_000}
                      disabled={!order.access.canProgress || blocked}
                      className="mt-1 font-mono text-sm"
                    />
                    <div className="mt-1 text-right text-xs text-muted-foreground">
                      {content.length.toLocaleString()} / 200,000
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => saveDraft.mutate()}
                      disabled={
                        !content.trim() ||
                        saveDraft.isPending ||
                        blocked ||
                        !order.access.canProgress
                      }
                    >
                      <Save className="h-4 w-4" />
                      {saveDraft.isPending ? "Saving..." : "Save draft"}
                    </Button>
                    <Button
                      onClick={() => submitReview.mutate()}
                      disabled={
                        !content.trim() ||
                        submitReview.isPending ||
                        blocked ||
                        !order.access.canProgress
                      }
                    >
                      <Send className="h-4 w-4" />
                      {submitReview.isPending
                        ? "Submitting..."
                        : "Send for review"}
                    </Button>
                  </div>
                </div>
              ) : order.status === "CUSTOMER_REVIEW" ? (
                <div className="py-8 text-center">
                  <Clock3 className="mx-auto h-10 w-10 text-muted-foreground" />
                  <h2 className="mt-4 text-lg font-semibold">
                    Waiting on customer
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    The customer can approve the content or request another
                    revision.
                  </p>
                  {order.contentOrder?.brief && (
                    <div className="mt-6 max-h-72 overflow-auto border bg-muted/30 p-4 text-left text-sm whitespace-pre-wrap">
                      {order.contentOrder.brief}
                    </div>
                  )}
                </div>
              ) : order.status === "APPROVED" ? (
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="published-url">Published URL</Label>
                    <Input
                      id="published-url"
                      type="url"
                      value={publishedUrl}
                      onChange={(event) => setPublishedUrl(event.target.value)}
                      placeholder="https://example.com/article"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="article-title">Article title</Label>
                    <Input
                      id="article-title"
                      value={articleTitle}
                      onChange={(event) => setArticleTitle(event.target.value)}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="delivery-notes">Delivery notes</Label>
                    <Textarea
                      id="delivery-notes"
                      value={deliveryNotes}
                      onChange={(event) => setDeliveryNotes(event.target.value)}
                      rows={4}
                      className="mt-1"
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      onClick={() => publish.mutate()}
                      disabled={
                        !publishedUrl.trim() ||
                        publish.isPending ||
                        blocked ||
                        !order.access.canProgress
                      }
                    >
                      <Upload className="h-4 w-4" />
                      {publish.isPending
                        ? "Submitting..."
                        : "Submit publication"}
                    </Button>
                  </div>
                </div>
              ) : ["PUBLISHED", "VERIFIED", "DELIVERED"].includes(
                  order.status,
                ) ? (
                <div className="py-8 text-center">
                  <ShieldCheck className="mx-auto h-10 w-10 text-primary" />
                  <h2 className="mt-4 text-lg font-semibold">
                    {order.activeDeliveryVersion?.verificationStatus ===
                    "VERIFIED"
                      ? "Publication verified"
                      : "Verification in progress"}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {order.activeDeliveryVersion?.verificationFailureReason ||
                      "Automated checks are validating the delivered placement."}
                  </p>
                  {order.activeDeliveryVersion?.publishedUrl && (
                    <Button variant="outline" className="mt-5" asChild>
                      <a
                        href={order.activeDeliveryVersion.publishedUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="h-4 w-4" />
                        Open publication
                      </a>
                    </Button>
                  )}
                  {["FAILED", "MANUAL_REVIEW"].includes(
                    order.activeDeliveryVersion?.verificationStatus ?? "",
                  ) && (
                    <Button className="mt-5 ml-2" asChild>
                      <Link href="/dashboard/verification/delivery">
                        Review verification
                      </Link>
                    </Button>
                  )}
                </div>
              ) : (
                <div className="py-8 text-center">
                  <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
                  <h2 className="mt-4 text-lg font-semibold">
                    Fulfillment complete
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    This platform order is retained as read-only fulfillment
                    history.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <OrderTimeline events={order.events} />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Order brief</CardTitle>
            </CardHeader>
            <CardContent>
              <OrderContext order={order} />
            </CardContent>
          </Card>

          <OrderArticleVersions articles={order.articleVersions ?? []} />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Order metadata</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {order.amount !== undefined && order.currency !== undefined && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Order value</span>
                  <span>{formatMoney(order.amount, order.currency)}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Status</span>
                <StatusBadge status={order.status} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Customer</span>
                <span>{order.customer?.name ?? "Unknown"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Organization</span>
                <span>{order.organization?.name ?? "Unknown"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Accepted</span>
                <span>{formatDateTime(order.acceptedAt)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Created</span>
                <span>{formatDateTime(order.createdAt)}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tracking</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Assigned</span>
                <span>
                  {order.fulfillmentAssignments[0]?.status ?? "Available"}
                </span>
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Accepted</span>
                <span>
                  {order.acceptedAt
                    ? format(new Date(order.acceptedAt), "MMM d, p")
                    : "Not yet"}
                </span>
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Due</span>
                <span>
                  {dueDate ? format(dueDate, "MMM d, yyyy, p") : "Not set"}
                </span>
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Revisions</span>
                <span>{order.revisions.length}</span>
              </div>
            </CardContent>
          </Card>

          {order.activeDeliveryVersion && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Link2 className="h-4 w-4" />
                  Delivery proof
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Badge variant="outline">
                  {order.activeDeliveryVersion.verificationStatus.replaceAll(
                    "_",
                    " ",
                  )}
                </Badge>
                <a
                  href={order.activeDeliveryVersion.publishedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block break-all text-primary hover:underline"
                >
                  {order.activeDeliveryVersion.publishedUrl}
                </a>
                <div className="text-muted-foreground">
                  {order.activeDeliveryVersion.evidence.length} verification
                  checks
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <CancellationDialog
        order={order}
        open={cancelOpen}
        onOpenChange={setCancelOpen}
      />
    </AdminPage>
  )
}
