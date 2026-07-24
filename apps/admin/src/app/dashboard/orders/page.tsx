"use client"

import type { AdminOrderFocus, AdminOrderResponse } from "@guestpost/api-client"
import type { OrderStatus } from "@guestpost/shared"
import { ORDER_STATUS_LABELS } from "@guestpost/shared"
import {
  Badge,
  Button,
  Card,
  CardContent,
  cn,
  getOrderStatusPresentation,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import { format, formatDistanceToNow, isPast } from "date-fns"
import type { LucideIcon } from "lucide-react"
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  Eye,
  History,
  RefreshCw,
  Scale,
  Search,
  ShieldCheck,
  ShoppingCart,
  WalletCards,
} from "lucide-react"
import Link from "next/link"
import { useDeferredValue, useEffect, useMemo, useState } from "react"
import {
  AdminEmptyState,
  AdminFilterBar,
  AdminPage,
  AdminPageHeader,
} from "../../../components/admin-workspace"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { getOrderBadgeVariant } from "../../../lib/order-status-badge-variant"

type StaffRole = "SUPER_ADMIN" | "OPERATIONS" | "FINANCE"
type ChannelFilter = "all" | "PUBLISHER" | "PLATFORM"

const PAGE_SIZE = 20
const CLOSED_STATUSES = new Set([
  "SETTLED",
  "COMPLETED",
  "CANCELLED",
  "REFUNDED",
])
const ACTIVE_SETTLEMENT_STATUSES = new Set([
  "PENDING",
  "UNDER_REVIEW",
  "CUSTOMER_APPROVED",
])

const ROLE_COPY: Record<
  StaffRole,
  { eyebrow: string; title: string; description: string }
> = {
  SUPER_ADMIN: {
    eyebrow: "Platform order control",
    title: "Order control center",
    description:
      "Monitor every order, prioritize cross-team exceptions, and move high-impact decisions into their protected workflows.",
  },
  OPERATIONS: {
    eyebrow: "Assigned and contextual work",
    title: "Order monitor",
    description:
      "Review only orders assigned or claimable to you, plus orders visible through your Support, dispute, cancellation, or verification work.",
  },
  FINANCE: {
    eyebrow: "Financial order context",
    title: "Order financial monitor",
    description:
      "Find the order context behind settlements, refunds, disputes, and publisher money decisions without entering fulfillment controls.",
  },
}

const FOCUS_COPY: Record<
  StaffRole,
  Record<
    AdminOrderFocus,
    { label: string; description: string; icon: LucideIcon; tone: string }
  >
> = {
  SUPER_ADMIN: {
    all: {
      label: "All orders",
      description: "Complete platform scope",
      icon: ShoppingCart,
      tone: "text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300",
    },
    attention: {
      label: "Needs attention",
      description: "Cross-team exceptions",
      icon: AlertTriangle,
      tone: "text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300",
    },
    active: {
      label: "Active",
      description: "In-flight lifecycle",
      icon: Activity,
      tone: "text-violet-700 bg-violet-100 dark:bg-violet-950 dark:text-violet-300",
    },
    completed: {
      label: "Closed",
      description: "Finished or ended",
      icon: History,
      tone: "text-emerald-700 bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300",
    },
  },
  OPERATIONS: {
    all: {
      label: "Visible to me",
      description: "Assignment-safe scope",
      icon: ClipboardList,
      tone: "text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300",
    },
    attention: {
      label: "Needs attention",
      description: "Operational exceptions",
      icon: AlertTriangle,
      tone: "text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300",
    },
    active: {
      label: "Active work",
      description: "In progress or review",
      icon: Activity,
      tone: "text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300",
    },
    completed: {
      label: "History",
      description: "Delivered or closed",
      icon: History,
      tone: "text-emerald-700 bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300",
    },
  },
  FINANCE: {
    all: {
      label: "Order context",
      description: "Complete finance scope",
      icon: WalletCards,
      tone: "text-emerald-700 bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300",
    },
    attention: {
      label: "Needs attention",
      description: "Money decisions and risk",
      icon: AlertTriangle,
      tone: "text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300",
    },
    active: {
      label: "Funds in flow",
      description: "Active order lifecycle",
      icon: CircleDollarSign,
      tone: "text-emerald-700 bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300",
    },
    completed: {
      label: "Closed context",
      description: "Released, cancelled, or refunded",
      icon: History,
      tone: "text-zinc-700 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-300",
    },
  },
}

function formatMoney(order: AdminOrderResponse) {
  if (order.amount == null) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: order.currency,
  }).format(Number(order.amount))
}

function orderChannel(order: AdminOrderResponse) {
  return order.fulfillmentChannel ?? order.website?.ownershipType ?? null
}

function workflowSignal(order: AdminOrderResponse, role: StaffRole) {
  if (
    order.dispute &&
    ["OPEN", "UNDER_REVIEW"].includes(order.dispute.status)
  ) {
    return { label: "Dispute open", variant: "destructive" as const }
  }
  if (order.cancellation) {
    return {
      label:
        order.cancellation.status === "PENDING_FINANCE"
          ? "Finance approval"
          : `Cancellation ${order.cancellation.status.replaceAll("_", " ").toLowerCase()}`,
      variant: "warning" as const,
    }
  }
  if (
    order.activeDelivery &&
    ["FAILED", "MANUAL_REVIEW"].includes(
      order.activeDelivery.verificationStatus,
    )
  ) {
    return { label: "Verification review", variant: "warning" as const }
  }
  if (
    role !== "OPERATIONS" &&
    order.settlement &&
    ACTIVE_SETTLEMENT_STATUSES.has(order.settlement.status)
  ) {
    return {
      label: `Settlement ${order.settlement.status.replaceAll("_", " ").toLowerCase()}`,
      variant: "info" as const,
    }
  }
  if (
    order.fulfillmentDueAt &&
    !CLOSED_STATUSES.has(order.status) &&
    isPast(new Date(order.fulfillmentDueAt))
  ) {
    return { label: "Fulfillment overdue", variant: "destructive" as const }
  }
  if (role === "OPERATIONS" && order.activeAssignment?.assignedToCurrentUser) {
    return { label: "Assigned to you", variant: "info" as const }
  }
  if (
    role === "OPERATIONS" &&
    orderChannel(order) === "PLATFORM" &&
    !order.activeAssignment &&
    !CLOSED_STATUSES.has(order.status)
  ) {
    return { label: "Available to claim", variant: "success" as const }
  }
  return null
}

function nextStep(order: AdminOrderResponse, role: StaffRole) {
  if (order.dispute) return "Review the dispute case"
  if (order.cancellation?.status === "PENDING_FINANCE") {
    return role === "OPERATIONS"
      ? "Finance decision pending"
      : "Review cancellation funding"
  }
  if (order.cancellation) return "Review cancellation case"
  if (
    order.activeDelivery &&
    ["FAILED", "MANUAL_REVIEW"].includes(
      order.activeDelivery.verificationStatus,
    )
  ) {
    return role === "FINANCE"
      ? "Verification blocks settlement"
      : "Review delivery evidence"
  }
  if (role === "FINANCE" && order.settlement) {
    return `Settlement ${order.settlement.status.replaceAll("_", " ").toLowerCase()}`
  }
  const labels: Partial<Record<OrderStatus, string>> = {
    DRAFT: "Awaiting customer submission",
    PENDING_PAYMENT: "Awaiting payment",
    PAID: "Payment received",
    SUBMITTED: "Ready for fulfillment",
    ACCEPTED: "Fulfillment accepted",
    CONTENT_REQUESTED: "Content requested",
    CONTENT_CREATION: "Content in progress",
    CONTENT_READY: "Ready for customer review",
    CUSTOMER_REVIEW: "Awaiting customer review",
    APPROVED: "Ready to publish",
    PUBLISHED: "Awaiting verification",
    VERIFIED: "Ready for delivery",
    DELIVERED: "Review or settlement window",
    SETTLED: "Settlement complete",
    COMPLETED: "Order complete",
    CANCELLED: "Order cancelled",
    REFUNDED: "Refund complete",
    DISPUTED: "Dispute in progress",
  }
  return labels[order.status] ?? "Review order context"
}

function workflowDestination(order: AdminOrderResponse, role: StaffRole) {
  if (order.dispute) {
    return { href: "/dashboard/disputes", label: "Dispute queue", icon: Scale }
  }
  if (order.cancellation) {
    return {
      href: "/dashboard/cancellations",
      label: "Cancellation queue",
      icon: AlertTriangle,
    }
  }
  if (
    role !== "FINANCE" &&
    order.activeDelivery &&
    ["FAILED", "MANUAL_REVIEW"].includes(
      order.activeDelivery.verificationStatus,
    )
  ) {
    return {
      href: "/dashboard/verification/delivery",
      label: "Verification",
      icon: ShieldCheck,
    }
  }
  if (
    role === "FINANCE" &&
    order.settlement &&
    ACTIVE_SETTLEMENT_STATUSES.has(order.settlement.status)
  ) {
    return {
      href: "/dashboard/finance/settlement-review",
      label: "Evidence review",
      icon: WalletCards,
    }
  }
  if (
    role === "OPERATIONS" &&
    orderChannel(order) === "PLATFORM" &&
    !CLOSED_STATUSES.has(order.status) &&
    (order.activeAssignment?.assignedToCurrentUser || !order.activeAssignment)
  ) {
    return {
      href: `/dashboard/fulfillment/${order.id}`,
      label: "Work fulfillment",
      icon: ClipboardList,
    }
  }
  return null
}

function FocusCard({
  focus,
  current,
  value,
  role,
  onSelect,
}: {
  focus: AdminOrderFocus
  current: AdminOrderFocus
  value: number
  role: StaffRole
  onSelect: (focus: AdminOrderFocus) => void
}) {
  const copy = FOCUS_COPY[role][focus]
  const Icon = copy.icon
  const selected = focus === current
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(focus)}
      className={cn(
        "min-w-0 rounded-2xl border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/40",
        selected && "border-primary ring-2 ring-primary/15",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">
            {copy.label}
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {copy.description}
          </p>
        </div>
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
            copy.tone,
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
      </div>
    </button>
  )
}

function OrderActions({
  order,
  role,
}: {
  order: AdminOrderResponse
  role: StaffRole
}) {
  const destination = workflowDestination(order, role)
  const DestinationIcon = destination?.icon
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {destination && DestinationIcon ? (
        <Button size="sm" asChild>
          <Link href={destination.href}>
            <DestinationIcon className="mr-1.5 h-3.5 w-3.5" />
            {destination.label}
          </Link>
        </Button>
      ) : null}
      <Button size="sm" variant={destination ? "outline" : "default"} asChild>
        <Link href={`/dashboard/orders/${order.id}`}>
          <Eye className="mr-1.5 h-3.5 w-3.5" />
          Details
        </Link>
      </Button>
    </div>
  )
}

function OrderIdentity({ order }: { order: AdminOrderResponse }) {
  return (
    <div className="min-w-0">
      <p className="max-w-64 truncate font-semibold">
        {order.title || order.type.replaceAll("_", " ").toLowerCase()}
      </p>
      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
        #{order.id.slice(0, 8)}
      </p>
      <p className="mt-1 text-xs capitalize text-muted-foreground">
        {order.type.replaceAll("_", " ").toLowerCase()}
      </p>
    </div>
  )
}

function CustomerContext({
  order,
  role,
}: {
  order: AdminOrderResponse
  role: StaffRole
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium">
        {order.customer?.name || "Customer name unavailable"}
      </p>
      <p className="truncate text-xs text-muted-foreground">
        {role === "SUPER_ADMIN" && order.customer?.email
          ? order.customer.email
          : order.organization?.name || "Organization unavailable"}
      </p>
    </div>
  )
}

function PlacementContext({ order }: { order: AdminOrderResponse }) {
  const channel = orderChannel(order)
  return (
    <div className="min-w-0 space-y-1">
      <Badge variant={channel === "PLATFORM" ? "info" : "secondary"}>
        {channel === "PLATFORM" ? "Platform fulfilled" : "Publisher fulfilled"}
      </Badge>
      <p className="max-w-56 truncate text-xs text-muted-foreground">
        {order.website?.name || order.website?.url || "Website unavailable"}
      </p>
    </div>
  )
}

function WorkflowContext({
  order,
  role,
}: {
  order: AdminOrderResponse
  role: StaffRole
}) {
  const presentation = getOrderStatusPresentation(order.status)
  const signal = workflowSignal(order, role)
  return (
    <div className="space-y-1.5">
      <Badge variant={getOrderBadgeVariant(order.status)}>
        {presentation.label}
      </Badge>
      {signal ? <Badge variant={signal.variant}>{signal.label}</Badge> : null}
      <p className="text-xs leading-5 text-muted-foreground">
        {nextStep(order, role)}
      </p>
    </div>
  )
}

function DeadlineContext({ order }: { order: AdminOrderResponse }) {
  const deadline = order.fulfillmentDueAt || order.autoAcceptAt
  if (!deadline) {
    return (
      <span className="text-sm text-muted-foreground">No active deadline</span>
    )
  }
  const date = new Date(deadline)
  const overdue = isPast(date) && !CLOSED_STATUSES.has(order.status)
  return (
    <div>
      <p className={cn("text-sm font-medium", overdue && "text-destructive")}>
        {overdue ? "Overdue " : ""}
        {formatDistanceToNow(date, { addSuffix: true })}
      </p>
      <p className="text-xs text-muted-foreground">{format(date, "PPp")}</p>
    </div>
  )
}

function MobileOrderCard({
  order,
  role,
}: {
  order: AdminOrderResponse
  role: StaffRole
}) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-4 p-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <OrderIdentity order={order} />
          {role !== "OPERATIONS" ? (
            <span className="shrink-0 text-sm font-semibold tabular-nums">
              {formatMoney(order)}
            </span>
          ) : null}
        </div>
        <WorkflowContext order={order} role={role} />
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/35 p-3">
          <div className="min-w-0">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Customer
            </p>
            <CustomerContext order={order} role={role} />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Routing
            </p>
            <PlacementContext order={order} />
          </div>
        </div>
        <div className="flex items-end justify-between gap-3">
          <DeadlineContext order={order} />
          <OrderActions order={order} role={role} />
        </div>
      </CardContent>
    </Card>
  )
}

export default function OrdersPage() {
  const { user } = useAuth()
  const role = (user?.staffRole ?? "SUPER_ADMIN") as StaffRole
  const copy = ROLE_COPY[role]
  const [search, setSearch] = useState("")
  const deferredSearch = useDeferredValue(search.trim())
  const [status, setStatus] = useState<OrderStatus | "all">("all")
  const [channel, setChannel] = useState<ChannelFilter>("all")
  const [focus, setFocus] = useState<AdminOrderFocus>("all")
  const [page, setPage] = useState(1)

  const query = useQuery({
    queryKey: ["admin", "orders", deferredSearch, status, channel, focus, page],
    queryFn: () =>
      api.admin.listOrders({
        search: deferredSearch || undefined,
        status,
        channel,
        focus,
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      }),
    placeholderData: (previous) => previous,
  })

  const orders = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const summary = query.data?.summary ?? {
    total: 0,
    attention: 0,
    active: 0,
    completed: 0,
  }
  const activeFilterCount =
    Number(Boolean(search)) +
    Number(status !== "all") +
    Number(channel !== "all") +
    Number(focus !== "all")

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const clearFilters = () => {
    setSearch("")
    setStatus("all")
    setChannel("all")
    setFocus("all")
    setPage(1)
  }

  const focusValues: Record<AdminOrderFocus, number> = useMemo(
    () => ({
      all: summary.total,
      attention: summary.attention,
      active: summary.active,
      completed: summary.completed,
    }),
    [summary],
  )

  return (
    <AdminPage>
      <AdminPageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        description={copy.description}
        icon={ShoppingCart}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw
              className={cn("mr-2 h-4 w-4", query.isFetching && "animate-spin")}
            />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(["all", "attention", "active", "completed"] as const).map((item) => (
          <FocusCard
            key={item}
            focus={item}
            current={focus}
            value={focusValues[item]}
            role={role}
            onSelect={(value) => {
              setFocus(value)
              setPage(1)
            }}
          />
        ))}
      </div>

      <AdminFilterBar
        activeCount={activeFilterCount}
        resultCount={total}
        resultLabel={total === 1 ? "order" : "orders"}
        onClear={clearFilters}
      >
        <div className="min-w-0 flex-1 lg:max-w-xl">
          <label
            htmlFor="order-search"
            className="mb-1.5 block text-xs font-medium text-muted-foreground"
          >
            Search visible order data
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="order-search"
              placeholder={
                role === "SUPER_ADMIN"
                  ? "Order ID, title, customer, email, organization, or website"
                  : "Order ID, title, customer, organization, or website"
              }
              value={search}
              maxLength={200}
              onChange={(event) => {
                setSearch(event.target.value)
                setPage(1)
              }}
              className="bg-background pl-9"
            />
          </div>
        </div>
        <div className="w-full sm:w-56">
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Order status
          </label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as OrderStatus | "all")
              setPage(1)
            }}
          >
            <SelectTrigger className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-full sm:w-56">
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Fulfillment route
          </label>
          <Select
            value={channel}
            onValueChange={(value) => {
              setChannel(value as ChannelFilter)
              setPage(1)
            }}
          >
            <SelectTrigger className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All routes</SelectItem>
              <SelectItem value="PLATFORM">Platform fulfilled</SelectItem>
              <SelectItem value="PUBLISHER">Publisher fulfilled</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </AdminFilterBar>

      {query.isError ? (
        <Card>
          <AdminEmptyState
            title="Orders could not be loaded"
            description={
              query.error instanceof Error
                ? query.error.message
                : "The scoped order query failed."
            }
            action={
              <Button variant="outline" onClick={() => query.refetch()}>
                Try again
              </Button>
            }
          />
        </Card>
      ) : query.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-2xl" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <Card>
          <AdminEmptyState
            title="No orders found"
            description="No order in your authorized scope matches the current workflow filters."
            action={
              activeFilterCount > 0 ? (
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2 2xl:hidden">
            {orders.map((order) => (
              <MobileOrderCard key={order.id} order={order} role={role} />
            ))}
          </div>

          <Card className="hidden min-w-0 overflow-hidden 2xl:block">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Routing</TableHead>
                      <TableHead>Workflow</TableHead>
                      <TableHead>Deadline</TableHead>
                      {role !== "OPERATIONS" ? (
                        <TableHead>Amount</TableHead>
                      ) : null}
                      <TableHead>Updated</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((order) => (
                      <TableRow key={order.id} className="align-top">
                        <TableCell>
                          <OrderIdentity order={order} />
                        </TableCell>
                        <TableCell>
                          <CustomerContext order={order} role={role} />
                        </TableCell>
                        <TableCell>
                          <PlacementContext order={order} />
                        </TableCell>
                        <TableCell className="min-w-48">
                          <WorkflowContext order={order} role={role} />
                        </TableCell>
                        <TableCell className="min-w-40">
                          <DeadlineContext order={order} />
                        </TableCell>
                        {role !== "OPERATIONS" ? (
                          <TableCell className="font-semibold tabular-nums">
                            {formatMoney(order)}
                          </TableCell>
                        ) : null}
                        <TableCell className="min-w-32 text-sm text-muted-foreground">
                          {formatDistanceToNow(new Date(order.updatedAt), {
                            addSuffix: true,
                          })}
                        </TableCell>
                        <TableCell>
                          <OrderActions order={order} role={role} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {totalPages > 1 ? (
        <div className="flex flex-col items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 sm:flex-row">
          <p className="text-sm text-muted-foreground">
            Showing {(page - 1) * PAGE_SIZE + 1}–
            {Math.min(page * PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || query.isFetching}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <ChevronLeft className="mr-1 h-4 w-4" /> Previous
            </Button>
            <span className="min-w-24 text-center text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || query.isFetching}
              onClick={() =>
                setPage((value) => Math.min(totalPages, value + 1))
              }
            >
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {orders.length > 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ArrowRight className="h-3.5 w-3.5" />
          High-impact actions remain inside the order’s protected detail or
          dedicated dispute, cancellation, verification, fulfillment, and
          finance workflow.
        </p>
      ) : null}
    </AdminPage>
  )
}
