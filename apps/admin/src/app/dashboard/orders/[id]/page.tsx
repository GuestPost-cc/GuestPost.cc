"use client"

import type {
  AdminOrderDetailResponse,
  AdminOrderTimelineEvent,
} from "@guestpost/api-client"
import type { OrderStatus } from "@guestpost/shared"
import {
  Badge,
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
  getOrderStatusPresentation,
  Skeleton,
  Textarea,
  StatusBadge as UIStatusBadge,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format, formatDistanceToNow } from "date-fns"
import {
  AlertCircle,
  ArrowLeft,
  Ban,
  Check,
  CheckCircle,
  Clock,
  DollarSign,
  ExternalLink,
  FileText,
  RefreshCw,
  Scale,
  ShieldCheck,
  User,
  Users,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"
import { getOrderBadgeVariant } from "../../../../lib/order-status-badge-variant"

// ─── Status presentation ─────────────────────────────────────────────────────

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
  DRAFT: { icon: FileText, description: "Order is in draft state" },
  PENDING_PAYMENT: { icon: Clock, description: "Awaiting payment" },
  PAID: { icon: CheckCircle, description: "Payment received" },
  SUBMITTED: { icon: CheckCircle, description: "Order submitted" },
  ACCEPTED: { icon: CheckCircle, description: "Order accepted" },
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

// ─── Types ──────────────────────────────────────────────────────────────────

type TimelineEvent = AdminOrderTimelineEvent

function eventDetail(event: TimelineEvent): string | null {
  const m = (event.metadata ?? {}) as Record<string, any>
  if (event.message?.trim()) return event.message.trim()
  const parts: string[] = []
  const url = m.publishedUrl ?? m.url
  if (url) parts.push(`Published at ${url}`)
  if (m.reason) parts.push(`Reason: ${m.reason}`)
  if (m.notes) parts.push(String(m.notes))
  if (m.newStatus)
    parts.push(
      `Status → ${String(m.newStatus).replace(/_/g, " ").toLowerCase()}`,
    )
  if (typeof m.amount === "number")
    parts.push(`Amount: $${m.amount.toLocaleString()}`)
  if (typeof m.publisherAmount === "number")
    parts.push(`Publisher payout: $${m.publisherAmount.toLocaleString()}`)
  if (m.version != null && url == null) parts.push(`Revision v${m.version}`)
  if (m.assignedTo) parts.push(`Assigned to ${m.assignedTo}`)
  if (m.adminName) parts.push(`By ${m.adminName}`)
  if (m.action)
    parts.push(`Action: ${String(m.action).replace(/_/g, " ").toLowerCase()}`)
  return parts.length ? parts.join(" · ") : null
}

const SYSTEM_APPROVER_LABELS: Record<string, string> = {
  SYSTEM_AUTO_APPROVE: "System auto-approval",
  SYSTEM_AUTO_RELEASE: "System auto-release",
}

function approvalActorLabel(approval: {
  type: string
  approvedBy: string
  approvedByUser: { name: string | null; email: string } | null
}): string {
  return (
    approval.approvedByUser?.name ||
    approval.approvedByUser?.email ||
    SYSTEM_APPROVER_LABELS[approval.approvedBy] ||
    (approval.type === "CUSTOMER" ? "Customer" : "Admin")
  )
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Time unavailable"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Time unavailable" : format(date, "PPp")
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function OrderTimeline({ events }: { events: TimelineEvent[] }) {
  const sortedEvents = [...events].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
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
                <Icon
                  className={`h-3 w-3 ${isLatest ? "text-primary-foreground" : "text-muted-foreground"}`}
                />
              </div>
              <div className="flex flex-col">
                <span className="font-medium">
                  {eventLabels[event.eventType] ||
                    event.eventType
                      .replace(/_/g, " ")
                      .toLowerCase()
                      .replace(/\b\w/g, (c) => c.toUpperCase())}
                </span>
                {(() => {
                  const detail = eventDetail(event)
                  return detail ? (
                    <span className="mt-0.5 text-sm text-muted-foreground break-words">
                      {detail}
                    </span>
                  ) : null
                })()}
                <span
                  className="mt-0.5 text-xs text-muted-foreground"
                  title={format(new Date(event.createdAt), "PPpp")}
                >
                  {formatDistanceToNow(new Date(event.createdAt), {
                    addSuffix: true,
                  })}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
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

const PROGRESS_STEPS = [
  { label: "Payment", statuses: ["DRAFT", "PENDING_PAYMENT", "PAID"] },
  {
    label: "Content",
    statuses: [
      "SUBMITTED",
      "ACCEPTED",
      "CONTENT_REQUESTED",
      "CONTENT_CREATION",
      "CONTENT_READY",
    ],
  },
  { label: "Review", statuses: ["CUSTOMER_REVIEW", "APPROVED"] },
  { label: "Published", statuses: ["PUBLISHED"] },
  { label: "Verified", statuses: ["VERIFIED"] },
  { label: "Delivered", statuses: ["DELIVERED"] },
  { label: "Complete", statuses: ["SETTLED", "COMPLETED"] },
]

function OrderProgress({ status }: { status: string }) {
  if (
    status === "CANCELLED" ||
    status === "REFUNDED" ||
    status === "DISPUTED"
  ) {
    const map: Record<string, { text: string; cls: string }> = {
      CANCELLED: {
        text: "This order was cancelled.",
        cls: "bg-gray-100 text-gray-700",
      },
      REFUNDED: {
        text: "This order was refunded.",
        cls: "bg-orange-100 text-orange-700",
      },
      DISPUTED: {
        text: "A dispute is open — settlement to the publisher is paused while we review.",
        cls: "bg-red-100 text-red-700",
      },
    }
    const m = map[status]
    return (
      <div className={`rounded-lg px-4 py-3 text-sm font-medium ${m.cls}`}>
        {m.text}
      </div>
    )
  }

  let current = PROGRESS_STEPS.findIndex((s) => s.statuses.includes(status))
  if (current === -1) current = 0

  return (
    <div className="flex items-center">
      {PROGRESS_STEPS.map((step, i) => {
        const done = i < current
        const active = i === current
        return (
          <div
            key={step.label}
            className="flex flex-1 items-center last:flex-none"
          >
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                  done
                    ? "bg-primary text-primary-foreground"
                    : active
                      ? "bg-primary/15 text-primary ring-2 ring-primary"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {done ? <CheckCircle className="h-4 w-4" /> : i + 1}
              </div>
              <span
                className={`text-[11px] ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}
              >
                {step.label}
              </span>
            </div>
            {i < PROGRESS_STEPS.length - 1 && (
              <div
                className={`mx-1 h-0.5 flex-1 ${done ? "bg-primary" : "bg-muted"}`}
              />
            )}
          </div>
        )
      })}
    </div>
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
          <Card>
            <CardContent className="pt-6">
              <Skeleton className="h-32 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <Skeleton className="h-48 w-full" />
            </CardContent>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6">
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <Skeleton className="h-48 w-full" />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ──────────────────────────────────────────────────────────────

const CANCELLABLE = [
  "DRAFT",
  "PENDING_PAYMENT",
  "PAID",
  "SUBMITTED",
  "ACCEPTED",
  "CONTENT_REQUESTED",
  "CONTENT_CREATION",
  "CONTENT_READY",
  "CUSTOMER_REVIEW",
  "APPROVED",
]

const REFUNDABLE = [
  "PAID",
  "SUBMITTED",
  "ACCEPTED",
  "CONTENT_REQUESTED",
  "CONTENT_CREATION",
  "CONTENT_READY",
  "CUSTOMER_REVIEW",
  "APPROVED",
  "PUBLISHED",
  "VERIFIED",
  "DELIVERED",
  "SETTLED",
  "DISPUTED",
]

const TERMINAL = ["COMPLETED", "CANCELLED", "REFUNDED"]

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const router = useRouter()

  const isSuperAdmin = user?.staffRole === "SUPER_ADMIN"
  const canRefund =
    user?.staffRole === "SUPER_ADMIN" || user?.staffRole === "FINANCE"

  const [action, setAction] = useState<null | "cancel" | "refund">(null)
  const [reason, setReason] = useState("")

  const {
    data: order,
    isLoading,
    error,
    refetch,
  } = useQuery<AdminOrderDetailResponse>({
    queryKey: ["admin", "order", id],
    queryFn: () => api.admin.getOrderById(id),
  })

  const refreshOrder = () => {
    queryClient.invalidateQueries({ queryKey: ["admin", "order", id] })
    queryClient.invalidateQueries({ queryKey: ["admin", "orders"] })
  }

  const intervene = useMutation({
    mutationFn: ({
      kind,
      reasonText,
    }: {
      kind: "cancel" | "refund"
      reasonText: string
    }) =>
      kind === "cancel"
        ? api.admin.forceCancelOrder(id, reasonText)
        : api.admin.refundOrder(id, reasonText),
    onSuccess: (_d, vars) => {
      toast.success(
        vars.kind === "cancel" ? "Order force-cancelled" : "Order refunded",
      )
      setAction(null)
      setReason("")
      refreshOrder()
    },
    onError: (e: any) => toast.error(e?.message || "Action failed"),
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
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <h2 className="mt-4 text-xl font-semibold">Failed to load order</h2>
        <p className="mt-2 text-muted-foreground">{(error as Error).message}</p>
        <Button className="mt-4" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <h2 className="mt-4 text-xl font-semibold">Order Not Found</h2>
        <p className="mt-2 text-muted-foreground">
          The order you&apos;re looking for doesn&apos;t exist.
        </p>
        <Button className="mt-4" asChild>
          <Link href="/dashboard/orders">View All Orders</Link>
        </Button>
      </div>
    )
  }

  const currentStatusConfig = statusConfig[order.status] || statusConfig.DRAFT
  const currentStatusIcon = currentStatusConfig.icon

  const showCancel = isSuperAdmin && CANCELLABLE.includes(order.status)
  const showRefund =
    canRefund &&
    REFUNDABLE.includes(order.status) &&
    !TERMINAL.includes(order.status)

  const ownershipType = order.website?.ownershipType
  const isPlatformOwned = ownershipType === "PLATFORM"

  const showVerificationLink = ["PUBLISHED", "VERIFIED"].includes(order.status)
  const hasDispute = !!order.dispute

  const activeDelivery = order.activeDeliveryVersion
  const latestEvidence = activeDelivery?.evidence?.[0] ?? null
  const settlements = order.settlements?.length ? order.settlements : null

  return (
    <div className="space-y-6">
      {/* ── Navigation Header ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/dashboard/orders">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">
                Order #{order.id.slice(0, 8)}
              </h1>
              <StatusBadge status={order.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              Created {format(new Date(order.createdAt), "PPp")}
            </p>
          </div>
        </div>
      </div>

      {/* ── Action Buttons Bar ────────────────────────────────────────────── */}
      {(showCancel || showRefund || showVerificationLink || hasDispute) && (
        <div className="flex flex-wrap items-center gap-2">
          {showCancel && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setAction("cancel")
                setReason("")
              }}
            >
              <Ban className="mr-2 h-4 w-4" />
              Force Cancel
            </Button>
          )}
          {showRefund && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setAction("refund")
                setReason("")
              }}
            >
              <DollarSign className="mr-2 h-4 w-4" />
              Refund
            </Button>
          )}
          {showVerificationLink && (
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/verification/delivery">
                <ShieldCheck className="mr-2 h-4 w-4" />
                View in Verification Queue
              </Link>
            </Button>
          )}
          {hasDispute && (
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/disputes">
                <Scale className="mr-2 h-4 w-4" />
                Manage Dispute
              </Link>
            </Button>
          )}
        </div>
      )}

      {/* ── Progress Bar ──────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="pt-6">
          <OrderProgress status={order.status} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {/* ── Customer Info Card ────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <User className="h-4 w-4" /> Customer Info
              </CardTitle>
            </CardHeader>
            <CardContent>
              {order.customer ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Name</p>
                    <p className="text-sm font-medium">
                      {order.customer.name || "—"}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Email</p>
                    <p className="text-sm font-medium">
                      {order.customer.email}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">User Type</p>
                    <p className="text-sm font-medium capitalize">
                      {order.customer.userType.toLowerCase()}
                    </p>
                  </div>
                  {order.organization?.name && (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        Organization
                      </p>
                      <p className="text-sm font-medium">
                        {order.organization.name}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No customer data
                </p>
              )}
            </CardContent>
          </Card>

          {/* ── Publisher / Ops Staff Card ────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4" />{" "}
                {isPlatformOwned ? "Assigned Ops Staff" : "Publisher"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isPlatformOwned ? (
                order.website?.managedBy ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Name</p>
                      <p className="text-sm font-medium">
                        {order.website.managedBy.name || "—"}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Email</p>
                      <p className="text-sm font-medium">
                        {order.website.managedBy.email}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No ops staff assigned
                  </p>
                )
              ) : order.website?.publisher ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Name</p>
                    <p className="text-sm font-medium">
                      {order.website.publisher.name || "—"}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Email</p>
                    <p className="text-sm font-medium">
                      {order.website.publisher.email || "—"}
                    </p>
                  </div>
                  {order.website.publisher.tier && (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Tier</p>
                      <p className="text-sm font-medium">
                        {order.website.publisher.tier}
                      </p>
                    </div>
                  )}
                  {order.website.publisher.profile?.trustScore != null && (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        Trust Score
                      </p>
                      <p className="text-sm font-medium">
                        {order.website.publisher.profile.trustScore}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No publisher data
                </p>
              )}
            </CardContent>
          </Card>

          {/* ── Order Details Card ────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Order Details</CardTitle>
              <CardDescription>
                Service and content requirements
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Service Type</p>
                  <p className="font-medium capitalize">
                    {order.type.replace(/_/g, " ").toLowerCase()}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">
                    Amount + Currency
                  </p>
                  <p className="font-medium font-mono">
                    {order.amount != null
                      ? `${order.currency} ${Number(order.amount).toFixed(2)}`
                      : "—"}
                  </p>
                </div>
                {order.title && (
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Title</p>
                    <p className="font-medium">{order.title}</p>
                  </div>
                )}
                {order.items?.[0]?.targetUrl && (
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Target URL</p>
                    <a
                      href={order.items[0].targetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 break-all text-sm font-medium text-primary hover:underline"
                    >
                      {order.items[0].targetUrl}
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  </div>
                )}
                {order.items?.[0]?.anchorText && (
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Anchor Text</p>
                    <p className="font-medium">{order.items[0].anchorText}</p>
                  </div>
                )}
                {order.website?.url && (
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Website URL</p>
                    <a
                      href={order.website.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 break-all text-sm font-medium text-primary hover:underline"
                    >
                      {order.website.url}
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  </div>
                )}
              </div>

              {order.verifyMethod && (
                <div className="flex items-center gap-2">
                  <p className="text-sm text-muted-foreground">
                    Verify Method:
                  </p>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      order.verifyMethod === "AUTO"
                        ? "bg-emerald-100 text-emerald-700"
                        : order.verifyMethod === "MANUAL_ADMIN"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {order.verifyMethod === "AUTO"
                      ? "Auto"
                      : order.verifyMethod === "MANUAL_ADMIN"
                        ? "Admin"
                        : "Customer"}
                  </span>
                </div>
              )}

              {order.instructions && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Instructions</p>
                  <p className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">
                    {order.instructions}
                  </p>
                </div>
              )}

              {order.autoAcceptAt && (
                <div className="flex items-center gap-2 text-sm">
                  <Clock className="h-4 w-4 text-blue-600" />
                  <span>
                    Auto-accept at {format(new Date(order.autoAcceptAt), "PPp")}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Delivery Verification Card ────────────────────────────────── */}
          {activeDelivery && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="h-5 w-5 text-green-600" /> Delivery
                  Verification
                </CardTitle>
                <CardDescription>
                  {order.verifyMethod === "AUTO"
                    ? "Independently verified by the platform."
                    : order.verifyMethod === "MANUAL_ADMIN"
                      ? "Manually verified by an admin."
                      : "Verified by customer confirmation."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Status:</span>
                  <Badge
                    variant={
                      activeDelivery.verificationStatus === "VERIFIED"
                        ? "success"
                        : activeDelivery.verificationStatus === "FAILED"
                          ? "destructive"
                          : "warning"
                    }
                  >
                    {activeDelivery.verificationStatus.replace(/_/g, " ")}
                  </Badge>
                  {order.verifyMethod && (
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        order.verifyMethod === "AUTO"
                          ? "bg-emerald-100 text-emerald-700"
                          : order.verifyMethod === "MANUAL_ADMIN"
                            ? "bg-blue-100 text-blue-700"
                            : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {order.verifyMethod === "AUTO"
                        ? "Auto"
                        : order.verifyMethod === "MANUAL_ADMIN"
                          ? "Admin"
                          : "Customer"}
                    </span>
                  )}
                </div>

                {activeDelivery.publishedUrl && (
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">
                      Published URL
                    </p>
                    <a
                      href={activeDelivery.publishedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 break-all text-sm font-medium text-primary hover:underline"
                    >
                      {activeDelivery.publishedUrl}
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  </div>
                )}

                {latestEvidence && (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {[
                      [
                        "URL Reachable",
                        latestEvidence.httpStatus >= 200 &&
                          latestEvidence.httpStatus < 400,
                      ],
                      ["Link Found", latestEvidence.linkFound],
                      ["Target URL Matched", latestEvidence.targetUrlMatched],
                      ["Anchor Verified", latestEvidence.anchorFound],
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
                          {label}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {activeDelivery.adminVerifiedBy && (
                  <div className="space-y-1 text-sm">
                    <p className="text-muted-foreground">Admin verified by</p>
                    <p className="font-medium">
                      {activeDelivery.adminVerifiedBy.name || "Unknown"}
                    </p>
                  </div>
                )}

                {activeDelivery.adminOverrideReason && (
                  <div className="space-y-1 text-sm">
                    <p className="text-muted-foreground">
                      Admin override reason
                    </p>
                    <p className="rounded-md border bg-muted/30 px-2 py-1">
                      {activeDelivery.adminOverrideReason}
                    </p>
                  </div>
                )}

                {activeDelivery.adminVerifiedNotes && (
                  <div className="space-y-1 text-sm">
                    <p className="text-muted-foreground">Admin notes</p>
                    <p className="rounded-md border bg-muted/30 px-2 py-1">
                      {activeDelivery.adminVerifiedNotes}
                    </p>
                  </div>
                )}

                {activeDelivery.fraudFlags &&
                  activeDelivery.fraudFlags.length > 0 && (
                    <div className="space-y-1 text-sm">
                      <p className="text-muted-foreground">Fraud flags</p>
                      <div className="space-y-1">
                        {activeDelivery.fraudFlags.map((ff: any) => (
                          <div
                            key={ff.id}
                            className="flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-red-700"
                          >
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                            <span className="font-medium capitalize">
                              {ff.type.replace(/_/g, " ")}
                            </span>
                            {ff.details && (
                              <span className="text-red-600">
                                {typeof ff.details === "string"
                                  ? ff.details
                                  : JSON.stringify(ff.details)}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                {activeDelivery.screenshotUrl && (
                  <a
                    href={activeDelivery.screenshotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    View screenshot
                  </a>
                )}

                {latestEvidence?.checkedAt && (
                  <p className="text-xs text-muted-foreground">
                    Verified {formatDateTime(latestEvidence.checkedAt)}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Settlement Card ───────────────────────────────────────────── */}
          {settlements?.map((s) => (
            <Card key={s.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <DollarSign className="h-4 w-4" /> Settlement
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Status:</span>
                  <Badge
                    variant={getOrderBadgeVariant(
                      s.status as unknown as OrderStatus,
                    )}
                  >
                    {s.status.replace(/_/g, " ")}
                  </Badge>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Gross Amount
                    </p>
                    <p className="text-sm font-medium font-mono">
                      {order.currency} {Number(s.grossAmount).toFixed(2)}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Platform Fee
                    </p>
                    <p className="text-sm font-medium font-mono">
                      {order.currency} {Number(s.platformFee).toFixed(2)}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Publisher Amount
                    </p>
                    <p className="text-sm font-medium font-mono">
                      {order.currency} {Number(s.publisherAmount).toFixed(2)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    Release Policy:
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      s.releasePolicy === "AUTO"
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {s.releasePolicy}
                  </span>
                </div>

                {s.reviewEndsAt && (
                  <div className="flex items-center gap-2 text-sm">
                    <Clock className="h-4 w-4 text-blue-600" />
                    <span>
                      Review ends at {format(new Date(s.reviewEndsAt), "PPp")}
                      {["PENDING", "UNDER_REVIEW"].includes(s.status) &&
                        (() => {
                          const remaining = Math.ceil(
                            (new Date(s.reviewEndsAt).getTime() - Date.now()) /
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

                {s.approvals && s.approvals.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Approvals</p>
                    <div className="space-y-2">
                      {s.approvals.map((a) => (
                        <div
                          key={a.id}
                          className="flex items-center justify-between rounded-lg border p-2 text-sm"
                        >
                          <div className="flex items-center gap-2">
                            <CheckCircle className="h-4 w-4 text-green-600" />
                            <span className="font-medium capitalize">
                              {a.type.replace(/_/g, " ").toLowerCase()}
                            </span>
                          </div>
                          <div className="text-right text-xs text-muted-foreground">
                            <p>{approvalActorLabel(a)}</p>
                            <p className="capitalize">
                              {a.roleAtTime.replace(/_/g, " ").toLowerCase()}
                            </p>
                            <p>{formatDateTime(a.approvedAt)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* ── Right sidebar ──────────────────────────────────────────────── */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Order Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-full ${VARIANT_CIRCLE_BG[getOrderStatusPresentation(order.status as OrderStatus).variant]}`}
                >
                  {(() => {
                    const Icon = currentStatusIcon
                    return Icon ? <Icon className="h-6 w-6" /> : null
                  })()}
                </div>
                <div>
                  <p className="font-medium">
                    {currentStatusConfig.description}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Updated{" "}
                    {formatDistanceToNow(new Date(order.updatedAt), {
                      addSuffix: true,
                    })}
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

      {/* ── Cancel / Refund Dialog ────────────────────────────────────────── */}
      <Dialog
        open={!!action}
        onOpenChange={(o) => {
          if (!o) {
            setAction(null)
            setReason("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action === "cancel" ? "Force-cancel order" : "Refund order"}
            </DialogTitle>
            <DialogDescription>
              {action === "cancel"
                ? "Cancels the order and refunds any captured payment. Use only for stuck or erroneous orders."
                : "Refunds the customer. If a settlement was already released, the publisher is clawed back."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Reason (recorded in the audit trail)..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={1000}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAction(null)
                setReason("")
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={intervene.isPending || reason.trim().length < 3}
              onClick={() =>
                action &&
                intervene.mutate({ kind: action, reasonText: reason.trim() })
              }
            >
              {intervene.isPending
                ? "Working..."
                : action === "cancel"
                  ? "Force Cancel"
                  : "Refund"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
