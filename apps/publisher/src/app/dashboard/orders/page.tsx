"use client"

import type { OrderResponse } from "@guestpost/api-client"
import {
  Button,
  Card,
  CardContent,
  ErrorState,
  getOrderStatusPresentation,
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
import { useQuery } from "@tanstack/react-query"
import { format, formatDistanceToNow } from "date-fns"
import {
  AlertCircle,
  ArrowRight,
  Clock3,
  ExternalLink,
  Filter,
  RefreshCw,
  Search,
} from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useMemo, useState } from "react"
import { api } from "../../../lib/api"
import {
  formatPublisherMoney,
  getOrderDueState,
  getPublisherNextAction,
  getPublisherOrderStage,
  isOpenPublisherOrder,
  orderNeedsPublisherAttention,
  PUBLISHER_ORDER_STAGE_GROUPS,
  sortOrdersByOperationalPriority,
} from "../../../lib/publisher-order-workflow"

type SortMode = "priority" | "deadline" | "newest" | "payout"
type DueFilter = "all" | "overdue" | "48h" | "7d"

function orderWebsite(order: OrderResponse) {
  return (
    order.website?.url ?? order.items[0]?.website?.url ?? "Website unavailable"
  )
}

function orderTitle(order: OrderResponse) {
  return order.title || order.type.replaceAll("_", " ").toLowerCase()
}

function dueBadgeClass(order: OrderResponse) {
  const risk = getOrderDueState(order).risk
  if (risk === "overdue") return "border-red-200 bg-red-50 text-red-700"
  if (risk === "soon") return "border-amber-200 bg-amber-50 text-amber-700"
  return "border-border bg-muted/40 text-muted-foreground"
}

function OrderMobileCard({ order }: { order: OrderResponse }) {
  const status = getOrderStatusPresentation(order.status)
  const due = getOrderDueState(order)
  const action = getPublisherNextAction(order)

  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-xs text-muted-foreground">
              #{order.id.slice(0, 8)}
            </p>
            <Link
              href={`/dashboard/orders/${order.id}`}
              className="mt-1 block truncate font-semibold capitalize hover:text-primary"
            >
              {orderTitle(order)}
            </Link>
          </div>
          <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
        </div>
        <p className="mt-3 flex items-center gap-1 truncate text-sm text-muted-foreground">
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{orderWebsite(order)}</span>
        </p>
        <div className="mt-4 flex items-center justify-between gap-3 border-y py-3 text-sm">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium ${dueBadgeClass(order)}`}
          >
            <Clock3 className="h-3 w-3" /> {due.label}
          </span>
          <span className="font-semibold tabular-nums">
            {formatPublisherMoney(order.totalAmount, order.currency)}
          </span>
        </div>
        <Button
          className="mt-4 w-full"
          variant={action.tone === "urgent" ? "default" : "outline"}
          asChild
        >
          <Link href={`/dashboard/orders/${order.id}`}>
            {action.label} <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}

function OrdersSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4, 5].map((row) => (
        <div
          key={row}
          className="flex items-center gap-4 rounded-xl border bg-background p-4"
        >
          <Skeleton className="h-10 w-10 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <Skeleton className="h-8 w-28" />
        </div>
      ))}
    </div>
  )
}

function OrdersContent() {
  const searchParams = useSearchParams()
  const initialView = searchParams.get("view") ?? "all"
  const [view, setView] = useState(initialView)
  const [query, setQuery] = useState("")
  const [website, setWebsite] = useState("all")
  const [dueFilter, setDueFilter] = useState<DueFilter>("all")
  const [sortMode, setSortMode] = useState<SortMode>("priority")

  const ordersQuery = useQuery({
    queryKey: ["publisher-orders"],
    queryFn: () => api.orders.list(),
  })
  const orders = ordersQuery.data ?? []

  const websiteOptions = useMemo(
    () =>
      [...new Set(orders.map(orderWebsite))].sort((a, b) => a.localeCompare(b)),
    [orders],
  )

  const counts = useMemo(() => {
    const result: Record<string, number> = {
      all: orders.length,
      attention: orders.filter(orderNeedsPublisherAttention).length,
    }
    for (const group of PUBLISHER_ORDER_STAGE_GROUPS) {
      result[group.key] = orders.filter((order) =>
        group.statuses.some((status) => status === order.status),
      ).length
    }
    return result
  }, [orders])

  const filteredOrders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const now = Date.now()
    const result = orders.filter((order) => {
      if (view === "attention" && !orderNeedsPublisherAttention(order))
        return false
      if (
        view !== "all" &&
        view !== "attention" &&
        getPublisherOrderStage(order.status).key !== view
      )
        return false
      if (website !== "all" && orderWebsite(order) !== website) return false

      const due = getOrderDueState(order, now)
      if (dueFilter === "overdue" && due.risk !== "overdue") return false
      if (dueFilter === "48h" && !["overdue", "soon"].includes(due.risk))
        return false
      if (
        dueFilter === "7d" &&
        due.millisecondsRemaining > 7 * 24 * 60 * 60 * 1000
      )
        return false

      if (normalizedQuery) {
        const searchable = [
          order.id,
          orderTitle(order),
          orderWebsite(order),
          order.type,
          order.status,
        ]
          .join(" ")
          .toLowerCase()
        if (!searchable.includes(normalizedQuery)) return false
      }
      return true
    })

    return result.sort((left, right) => {
      if (sortMode === "priority")
        return sortOrdersByOperationalPriority(left, right)
      if (sortMode === "deadline")
        return (
          getOrderDueState(left, now).millisecondsRemaining -
          getOrderDueState(right, now).millisecondsRemaining
        )
      if (sortMode === "payout")
        return Number(right.totalAmount ?? 0) - Number(left.totalAmount ?? 0)
      return (
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      )
    })
  }, [dueFilter, orders, query, sortMode, view, website])

  if (ordersQuery.error) {
    return (
      <ErrorState
        title="Failed to load orders"
        description={(ordersQuery.error as Error).message}
        onRetry={() => ordersQuery.refetch()}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            Order management
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">
            Fulfillment queue
          </h1>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">
            Work from the nearest deadline and keep every placement moving.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => ordersQuery.refetch()}
          disabled={ordersQuery.isFetching}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${ordersQuery.isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border bg-background p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Needs attention
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">
            {counts.attention ?? 0}
          </p>
        </div>
        <div className="rounded-2xl border bg-background p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Open orders
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">
            {orders.filter(isOpenPublisherOrder).length}
          </p>
        </div>
        <div className="rounded-2xl border bg-background p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Delivered
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">
            {counts.delivered ?? 0}
          </p>
        </div>
      </div>

      <Card className="rounded-2xl shadow-sm">
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Order stage filters"
          >
            {[
              { key: "all", label: "All" },
              { key: "attention", label: "Needs attention" },
              ...PUBLISHER_ORDER_STAGE_GROUPS,
            ].map((filter) => (
              <button
                key={filter.key}
                type="button"
                onClick={() => setView(filter.key)}
                aria-pressed={view === filter.key}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  view === filter.key
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {filter.label}
                <span className="ml-1.5 opacity-70">
                  {counts[filter.key] ?? 0}
                </span>
              </button>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(240px,1fr)_220px_180px_180px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search order, website, or topic"
                className="pl-9"
                aria-label="Search orders"
              />
            </div>
            <Select value={website} onValueChange={setWebsite}>
              <SelectTrigger aria-label="Filter by website">
                <SelectValue placeholder="All websites" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All websites</SelectItem>
                {websiteOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={dueFilter}
              onValueChange={(value) => setDueFilter(value as DueFilter)}
            >
              <SelectTrigger aria-label="Filter by deadline">
                <Filter className="mr-2 h-4 w-4" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any deadline</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="48h">Due in 48 hours</SelectItem>
                <SelectItem value="7d">Due in 7 days</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={sortMode}
              onValueChange={(value) => setSortMode(value as SortMode)}
            >
              <SelectTrigger aria-label="Sort orders">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="priority">Priority</SelectItem>
                <SelectItem value="deadline">Deadline</SelectItem>
                <SelectItem value="newest">Newest</SelectItem>
                <SelectItem value="payout">Order value</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {ordersQuery.isLoading ? (
        <OrdersSkeleton />
      ) : filteredOrders.length === 0 ? (
        <Card className="rounded-2xl border-dashed shadow-none">
          <CardContent className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Search className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="mt-4 font-semibold">No matching orders</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Clear a filter or try a different order ID, website, or topic.
            </p>
            <Button
              className="mt-4"
              variant="outline"
              onClick={() => {
                setView("all")
                setQuery("")
                setWebsite("all")
                setDueFilter("all")
              }}
            >
              Clear filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:hidden">
            {filteredOrders.map((order) => (
              <OrderMobileCard key={order.id} order={order} />
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border bg-background shadow-sm md:block">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Order</TableHead>
                  <TableHead>Website</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Deadline</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">Next action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.map((order) => {
                  const status = getOrderStatusPresentation(order.status)
                  const stage = getPublisherOrderStage(order.status)
                  const due = getOrderDueState(order)
                  const action = getPublisherNextAction(order)
                  return (
                    <TableRow key={order.id} className="group">
                      <TableCell>
                        <Link
                          href={`/dashboard/orders/${order.id}`}
                          className="block"
                        >
                          <span className="font-mono text-[11px] text-muted-foreground">
                            #{order.id.slice(0, 8)}
                          </span>
                          <span className="mt-1 block max-w-[260px] truncate text-sm font-semibold capitalize group-hover:text-primary">
                            {orderTitle(order)}
                          </span>
                          <span className="mt-0.5 block text-xs capitalize text-muted-foreground">
                            {order.type.replaceAll("_", " ").toLowerCase()}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-[220px] truncate text-sm">
                          {orderWebsite(order)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Updated{" "}
                          {formatDistanceToNow(new Date(order.updatedAt), {
                            addSuffix: true,
                          })}
                        </span>
                      </TableCell>
                      <TableCell>
                        <StatusBadge variant={status.variant}>
                          {status.label}
                        </StatusBadge>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {stage.label}
                        </p>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium ${dueBadgeClass(order)}`}
                        >
                          <Clock3 className="h-3 w-3" /> {due.label}
                        </span>
                        {due.date && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {format(due.date, "MMM d, h:mm a")}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatPublisherMoney(
                          order.totalAmount,
                          order.currency,
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant={
                            action.tone === "urgent" ? "default" : "outline"
                          }
                          asChild
                        >
                          <Link href={`/dashboard/orders/${order.id}`}>
                            {action.label}{" "}
                            <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Showing {filteredOrders.length} of {orders.length} orders
            </span>
            {orders.length >= 50 && (
              <span className="inline-flex items-center gap-1">
                <AlertCircle className="h-4 w-4" /> Showing the 50 most recent
                orders
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<OrdersSkeleton />}>
      <OrdersContent />
    </Suspense>
  )
}
