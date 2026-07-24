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
  Ban,
  CalendarClock,
  Check,
  CheckCircle,
  Clock,
  DollarSign,
  ExternalLink,
  FileText,
  RefreshCw,
  Route,
  Scale,
  ShieldCheck,
  User,
  Users,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import {
  AdminEmptyState,
  AdminMetricCard,
  AdminNotice,
  AdminPage,
  AdminPageHeader,
} from "../../../../components/admin-workspace"
import { api } from "../../../../lib/api"
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
  approvedByUser: { name: string | null; email?: string } | null
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

  if (sortedEvents.length === 0) {
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
                    <span className="mt-0.5 break-words text-sm text-muted-foreground">
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

const TERMINAL = ["CANCELLED", "REFUNDED"]

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()

  const [action, setAction] = useState<null | "cancel">(null)
  const [reason, setReason] = useState("")
  const [responsibility, setResponsibility] = useState("SYSTEM")
  const [confirmationOrderId, setConfirmationOrderId] = useState("")

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
    mutationFn: ({ reasonText }: { reasonText: string }) =>
      api.admin.forceCancelOrder(id, {
        reasonCode: "LEGAL_OR_SECURITY_EMERGENCY",
        note: reasonText,
        expectedVersion: order!.version,
        idempotencyKey: `admin-${id}-${order!.version}`,
        confirmationOrderId: confirmationOrderId.trim(),
        responsibility,
      }),
    onSuccess: () => {
      toast.success("Order force-cancelled")
      setAction(null)
      setReason("")
      setConfirmationOrderId("")
      refreshOrder()
    },
    onError: (e: any) => {
      toast.error(e?.message || "Action failed")
      refreshOrder()
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
    return (
      <AdminPage>
        <AdminPageHeader
          eyebrow="Role-protected order context"
          title="Order unavailable"
          description="This order may not exist, may no longer be visible in your assigned scope, or could not be loaded safely."
          icon={AlertCircle}
        />
        <Card>
          <AdminEmptyState
            title="No order context available"
            description="Return to the scoped order monitor or retry. For security, this page does not reveal whether an out-of-scope order exists."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" asChild>
                  <Link href="/dashboard/orders">Back to orders</Link>
                </Button>
                <Button onClick={() => refetch()}>Retry</Button>
              </div>
            }
          />
        </Card>
      </AdminPage>
    )
  }

  if (!order) {
    return (
      <AdminPage>
        <Card>
          <AdminEmptyState
            title="Order unavailable"
            description="The order is not available in your current role scope."
            action={
              <Button asChild>
                <Link href="/dashboard/orders">Back to orders</Link>
              </Button>
            }
          />
        </Card>
      </AdminPage>
    )
  }

  const currentStatusConfig = statusConfig[order.status] || statusConfig.DRAFT
  const currentStatusIcon = currentStatusConfig.icon

  const role = order.access.role
  const showCancel =
    order.access.canForceCancel && !TERMINAL.includes(order.status)

  const ownershipType = order.website?.ownershipType
  const isPlatformOwned = ownershipType === "PLATFORM"

  const verificationNeedsReview = ["FAILED", "MANUAL_REVIEW"].includes(
    order.activeDeliveryVersion?.verificationStatus ?? "",
  )
  const hasDispute = !!order.dispute
  const hasCancellation = !!order.cancellation

  const activeDelivery = order.activeDeliveryVersion
  const latestEvidence = activeDelivery?.evidence?.[0] ?? null
  const settlements = order.settlements?.length ? order.settlements : null
  const currentSettlement = settlements?.[0] ?? null
  const roleEyebrow =
    role === "SUPER_ADMIN"
      ? "Platform order oversight"
      : role === "OPERATIONS"
        ? "Operations order context"
        : "Financial order context"
  const routeLabel =
    order.fulfillmentChannel ??
    (order.website?.ownershipType === "PLATFORM"
      ? "PLATFORM"
      : order.website?.ownershipType === "PUBLISHER"
        ? "PUBLISHER"
        : "UNASSIGNED")
  const assignmentLabel = order.activeAssignment?.assignedToCurrentUser
    ? "Assigned to you"
    : order.access.canWorkFulfillment
      ? "Available to work"
      : "Context only"
  const nextDeadline = [
    "SETTLED",
    "COMPLETED",
    "CANCELLED",
    "REFUNDED",
  ].includes(order.status)
    ? null
    : (order.fulfillmentDueAt ?? order.autoAcceptAt)

  return (
    <AdminPage>
      <AdminPageHeader
        title={`Order #${order.id.slice(0, 8)}`}
        description={`${order.title || order.type.replaceAll("_", " ").toLowerCase()} · Created ${format(new Date(order.createdAt), "PPp")}`}
        eyebrow={roleEyebrow}
        icon={FileText}
        badges={<StatusBadge status={order.status} />}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/orders">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Orders
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          label="Fulfillment route"
          value={
            routeLabel === "PLATFORM"
              ? "Platform"
              : routeLabel === "PUBLISHER"
                ? "Publisher"
                : "Unassigned"
          }
          description={order.website?.url || "Website unavailable"}
          icon={Route}
          tone="info"
        />
        <AdminMetricCard
          label="Customer"
          value={order.customer?.name || "Unnamed"}
          description={order.organization?.name || "Individual account"}
          icon={User}
        />
        {order.access.canViewFinancials ? (
          <AdminMetricCard
            label="Order amount"
            value={
              order.amount == null
                ? "—"
                : `${order.currency} ${Number(order.amount).toFixed(2)}`
            }
            description={`Payment: ${order.paymentStatus.replaceAll("_", " ").toLowerCase()}`}
            icon={DollarSign}
            tone="success"
          />
        ) : (
          <AdminMetricCard
            label="Operations access"
            value={assignmentLabel}
            description="Derived from assignment and exception scope"
            icon={Users}
            tone={order.access.canWorkFulfillment ? "success" : "neutral"}
          />
        )}
        <AdminMetricCard
          label="Next deadline"
          value={nextDeadline ? format(new Date(nextDeadline), "PP") : "None"}
          description={
            nextDeadline
              ? formatDistanceToNow(new Date(nextDeadline), { addSuffix: true })
              : "No active lifecycle deadline"
          }
          icon={CalendarClock}
          tone={nextDeadline ? "warning" : "neutral"}
        />
      </div>

      {hasDispute ? (
        <AdminNotice title="Dispute is the active decision path" tone="danger">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <p>
              Settlement and normal fulfillment decisions should remain paused
              until the dispute is resolved in its audited workspace.
            </p>
            {order.access.canManageDispute ? (
              <Button variant="outline" size="sm" className="shrink-0" asChild>
                <Link href="/dashboard/disputes">
                  <Scale className="mr-2 h-4 w-4" /> Manage dispute
                </Link>
              </Button>
            ) : null}
          </div>
        </AdminNotice>
      ) : hasCancellation ? (
        <AdminNotice
          title="Cancellation request needs coordinated review"
          tone="warning"
        >
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <p>
              Continue this decision in Cancellations so responsibility,
              approval, and refund effects stay in one audit trail.
            </p>
            <Button variant="outline" size="sm" className="shrink-0" asChild>
              <Link href="/dashboard/cancellations">Review cancellation</Link>
            </Button>
          </div>
        </AdminNotice>
      ) : verificationNeedsReview ? (
        <AdminNotice
          title="Delivery verification needs attention"
          tone="warning"
        >
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <p>
              {order.access.canReviewDelivery
                ? "Review the evidence before progressing this order."
                : "Verification blocks the money flow. Review the evidence below and coordinate with Operations."}
            </p>
            {order.access.canReviewDelivery ? (
              <Button variant="outline" size="sm" className="shrink-0" asChild>
                <Link href="/dashboard/verification/delivery">
                  <ShieldCheck className="mr-2 h-4 w-4" /> Review evidence
                </Link>
              </Button>
            ) : null}
          </div>
        </AdminNotice>
      ) : order.access.canWorkFulfillment ? (
        <AdminNotice
          title="Fulfillment workspace is the next action"
          tone="info"
        >
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <p>
              Use the protected fulfillment workspace to claim or progress the
              order; this page remains the complete lifecycle context.
            </p>
            <Button size="sm" className="shrink-0" asChild>
              <Link href={`/dashboard/fulfillment/${order.id}`}>
                Open fulfillment
              </Link>
            </Button>
          </div>
        </AdminNotice>
      ) : role === "FINANCE" && currentSettlement ? (
        <AdminNotice
          title="Settlement evidence is ready for financial review"
          tone="info"
        >
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <p>
              Inspect verification, approvals, and publisher amounts here, then
              complete the decision in Settlement Review.
            </p>
            <Button size="sm" className="shrink-0" asChild>
              <Link href="/dashboard/finance/settlement-review">
                Open settlement review
              </Link>
            </Button>
          </div>
        </AdminNotice>
      ) : (
        <AdminNotice title="Lifecycle context is current" tone="success">
          No protected intervention is required from your role. Use the timeline
          and evidence below to understand the order’s current state.
        </AdminNotice>
      )}

      {showCancel ? (
        <div className="flex flex-col justify-between gap-3 rounded-xl border border-red-200/80 bg-red-50/30 p-4 sm:flex-row sm:items-center dark:border-red-900 dark:bg-red-950/10">
          <div>
            <p className="text-sm font-semibold">Emergency intervention</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Force cancellation is a Super Admin break-glass action. Normal
              cancellation and dispute workflows should be used first.
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            className="shrink-0"
            onClick={() => {
              setAction("cancel")
              setReason("")
              setConfirmationOrderId("")
            }}
          >
            <Ban className="mr-2 h-4 w-4" /> Force cancel
          </Button>
        </div>
      ) : null}

      {/* ── Progress Bar ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lifecycle progress</CardTitle>
          <CardDescription>
            Current stage and completed order milestones
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto pb-6">
          <OrderLifecycleProgress status={order.status} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div>
              <CardTitle className="text-base">
                Lifecycle integrity report
              </CardTitle>
              <CardDescription>
                Server-derived routing, evidence, assignment, audit, and
                financial consistency checks
              </CardDescription>
            </div>
            <Badge
              variant={
                order.integrity.state === "HEALTHY"
                  ? "success"
                  : order.integrity.state === "BLOCKED"
                    ? "destructive"
                    : "warning"
              }
            >
              {order.integrity.state.toLowerCase()}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {order.integrity.checks.map((check) => (
              <div key={check.key} className="rounded-xl border p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium">{check.label}</p>
                  <Badge
                    variant={
                      check.status === "PASS"
                        ? "success"
                        : check.status === "FAIL"
                          ? "destructive"
                          : check.status === "WARN"
                            ? "warning"
                            : "secondary"
                    }
                  >
                    {check.status.replaceAll("_", " ").toLowerCase()}
                  </Badge>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {check.message}
                </p>
              </div>
            ))}
          </div>
          <div className="grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Canonical stage</p>
              <p className="mt-1 text-sm font-medium">
                {order.lifecycle.stageLabel ?? "Exception path"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Order version</p>
              <p className="mt-1 font-mono text-sm font-medium">
                v{order.version}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Payment status</p>
              <p className="mt-1 text-sm font-medium">
                {order.paymentStatus.replaceAll("_", " ").toLowerCase()}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Assignment</p>
              <p className="mt-1 text-sm font-medium">
                {order.activeAssignment
                  ? `${order.activeAssignment.status.replaceAll("_", " ").toLowerCase()} · ${formatDateTime(order.activeAssignment.assignedAt)}`
                  : "No active assignment"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {/* ── Customer Info Card ────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <User className="h-4 w-4" /> Customer &amp; organization
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
                  {order.customer.email ? (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Email</p>
                      <p className="break-all text-sm font-medium">
                        {order.customer.email}
                      </p>
                    </div>
                  ) : null}
                  {order.customer.userType ? (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">User Type</p>
                      <p className="text-sm font-medium capitalize">
                        {order.customer.userType.toLowerCase()}
                      </p>
                    </div>
                  ) : null}
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
                  {!order.customer.email && !order.customer.userType ? (
                    <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
                      Direct customer identifiers are protected by your current
                      role policy.
                    </p>
                  ) : null}
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
                    {order.website.managedBy.email ? (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Email</p>
                        <p className="break-all text-sm font-medium">
                          {order.website.managedBy.email}
                        </p>
                      </div>
                    ) : null}
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
                  {order.website.publisher.email ? (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Email</p>
                      <p className="break-all text-sm font-medium">
                        {order.website.publisher.email}
                      </p>
                    </div>
                  ) : null}
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
                {order.access.canViewFinancials ? (
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">
                      Amount + Currency
                    </p>
                    <p className="font-mono font-medium">
                      {order.amount != null
                        ? `${order.currency} ${Number(order.amount).toFixed(2)}`
                        : "—"}
                    </p>
                  </div>
                ) : null}
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

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Order items &amp; content state
              </CardTitle>
              <CardDescription>
                Complete item routing, anchor requirements, and revision summary
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {order.items?.length ? (
                <div className="space-y-3">
                  {order.items.map((item, index) => (
                    <div key={item.id} className="rounded-xl border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold">
                          Item {index + 1}
                        </p>
                        <Badge variant="outline">
                          {item.website?.url || "Website unavailable"}
                        </Badge>
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="text-xs text-muted-foreground">
                            Target URL
                          </p>
                          {item.targetUrl ? (
                            <a
                              href={item.targetUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-1 inline-flex items-center gap-1 break-all text-sm font-medium text-primary hover:underline"
                            >
                              {item.targetUrl}
                              <ExternalLink className="h-3 w-3 shrink-0" />
                            </a>
                          ) : (
                            <p className="mt-1 text-sm text-muted-foreground">
                              Not provided
                            </p>
                          )}
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">
                            Anchor text
                          </p>
                          <p className="mt-1 text-sm font-medium">
                            {item.anchorText || "Not provided"}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No order items are linked to this order.
                </p>
              )}

              <div className="grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground">
                    Content record
                  </p>
                  <p className="mt-1 text-sm font-medium">
                    {order.content?.status.replaceAll("_", " ").toLowerCase() ||
                      "Not created"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Brief</p>
                  <p className="mt-1 text-sm font-medium">
                    {order.content?.hasBrief ? "Recorded" : "Not recorded"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Deliverable</p>
                  <p className="mt-1 text-sm font-medium">
                    {order.content?.hasDeliverable
                      ? "Recorded"
                      : "Not recorded"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Revisions</p>
                  <p className="mt-1 text-sm font-medium">
                    {order.revisions?.length ?? 0} recorded
                  </p>
                </div>
              </div>
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
                            className="flex min-w-0 flex-wrap items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-red-700"
                          >
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                            <span className="font-medium capitalize">
                              {ff.type.replace(/_/g, " ")}
                            </span>
                            {ff.details && (
                              <span className="min-w-0 break-all text-red-600">
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
            setConfirmationOrderId("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force-cancel order</DialogTitle>
            <DialogDescription>
              Cancels the order and refunds any captured payment. Use only for a
              verified emergency; normal refunds go through Cancellations or
              Disputes.
            </DialogDescription>
          </DialogHeader>
          <AdminNotice title="Break-glass action" tone="danger">
            The exact order ID and a meaningful audit reason are required. The
            server will also reject stale order versions and unauthorized roles.
          </AdminNotice>
          <div className="space-y-2">
            <Label htmlFor="force-cancel-reason">Audit reason</Label>
            <Textarea
              id="force-cancel-reason"
              placeholder="Describe the verified legal, security, or platform emergency..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              maxLength={1000}
            />
            <p className="text-xs text-muted-foreground">
              Minimum 20 characters · {reason.trim().length}/1000
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="force-cancel-responsibility">Responsibility</Label>
            <Select value={responsibility} onValueChange={setResponsibility}>
              <SelectTrigger id="force-cancel-responsibility">
                <SelectValue placeholder="Who is responsible?" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CUSTOMER">Customer</SelectItem>
                <SelectItem value="PUBLISHER">Publisher</SelectItem>
                <SelectItem value="PLATFORM">Platform</SelectItem>
                <SelectItem value="SHARED">Shared</SelectItem>
                <SelectItem value="SYSTEM">System</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="force-cancel-confirmation">
              Type the complete order ID to confirm
            </Label>
            <Input
              id="force-cancel-confirmation"
              value={confirmationOrderId}
              onChange={(event) => setConfirmationOrderId(event.target.value)}
              placeholder={order.id}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAction(null)
                setReason("")
                setConfirmationOrderId("")
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                intervene.isPending ||
                reason.trim().length < 20 ||
                confirmationOrderId.trim() !== order.id
              }
              onClick={() =>
                action && intervene.mutate({ reasonText: reason.trim() })
              }
            >
              {intervene.isPending ? "Working..." : "Force Cancel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
