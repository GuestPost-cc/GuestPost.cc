"use client"

import { Badge, getOrderStatusPresentation } from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle,
  Clock,
  ExternalLink,
  FileText,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
} from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"
import { api } from "../../../lib/api"

// Workflow steps matching the publisher order detail page
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

// Status groups for the quick-filter bar
const STATUS_GROUPS = [
  {
    key: "active",
    label: "Active",
    statuses: [
      "SUBMITTED",
      "ACCEPTED",
      "CONTENT_REQUESTED",
      "CONTENT_CREATION",
      "CONTENT_READY",
      "CUSTOMER_REVIEW",
      "APPROVED",
    ],
  },
  { key: "published", label: "Published", statuses: ["PUBLISHED", "VERIFIED"] },
  { key: "delivered", label: "Delivered", statuses: ["DELIVERED"] },
  { key: "complete", label: "Complete", statuses: ["SETTLED", "COMPLETED"] },
  {
    key: "closed",
    label: "Closed",
    statuses: ["CANCELLED", "REFUNDED", "DISPUTED"],
  },
]

function getWorkflowStep(status: string): number {
  const idx = WORKFLOW_STEPS.findIndex((s) => s.statuses.includes(status))
  return idx === -1 ? 0 : idx
}

function isTerminal(status: string): boolean {
  return ["CANCELLED", "REFUNDED", "DISPUTED"].includes(status)
}

function getGroupForStatus(status: string): string {
  return STATUS_GROUPS.find((g) => g.statuses.includes(status))?.key ?? "active"
}

function OrderCard({ order }: { order: any }) {
  const status = order.status ?? "DRAFT"
  const p = getOrderStatusPresentation(status)
  const currentStep = getWorkflowStep(status)
  const terminal = isTerminal(status)

  return (
    <Link
      href={`/dashboard/orders/${order.id}`}
      className="group block rounded-xl border bg-card transition-all hover:shadow-md hover:border-primary/20"
    >
      <div className="p-5">
        {/* Header row: ID + status */}
        <div className="flex items-center justify-between mb-4">
          <span className="font-mono text-xs text-muted-foreground">
            #{order.id.slice(0, 8)}
          </span>
          <Badge variant={p.variant as any}>{p.label}</Badge>
        </div>

        {/* Service + customer */}
        <div className="mb-3">
          <h3 className="font-semibold leading-snug">
            {(order.items?.[0]?.serviceType ?? order.type ?? "Order").replace(
              /_/g,
              " ",
            )}
          </h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            {order.customer?.name ?? order.customer?.email ?? "—"}
          </p>
        </div>

        {/* Website + amount */}
        <div className="flex items-center justify-between text-sm mb-4">
          <span className="flex items-center gap-1 text-muted-foreground truncate max-w-[60%]">
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {order.items?.[0]?.website?.url ?? order.website?.url ?? "—"}
            </span>
          </span>
          <span className="font-semibold tabular-nums">
            $
            {Number(order.totalAmount ?? order.items?.[0]?.budget ?? 0).toFixed(
              2,
            )}
          </span>
        </div>

        {/* Progress bar */}
        {terminal ? (
          <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="font-medium capitalize">
              {status.toLowerCase()}
            </span>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              {WORKFLOW_STEPS.map((step, i) => (
                <div key={step.label} className="flex items-center flex-1">
                  <div
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-medium ${
                      i < currentStep
                        ? "bg-emerald-100 text-emerald-700"
                        : i === currentStep
                          ? "bg-primary/10 text-primary ring-2 ring-primary/30"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {i < currentStep ? <Check className="h-3 w-3" /> : i + 1}
                  </div>
                  {i < WORKFLOW_STEPS.length - 1 && (
                    <div
                      className={`h-0.5 flex-1 mx-1 ${
                        i < currentStep
                          ? "bg-emerald-300"
                          : "bg-muted-foreground/20"
                      }`}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
              {WORKFLOW_STEPS.map((step, i) => (
                <span
                  key={step.label}
                  className={
                    i === currentStep ? "font-medium text-foreground" : ""
                  }
                >
                  {step.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDistanceToNow(new Date(order.createdAt), {
              addSuffix: true,
            })}
          </span>
          <span className="flex items-center gap-0.5 font-medium text-foreground group-hover:text-primary transition-colors">
            Details <ArrowRight className="h-3 w-3" />
          </span>
        </div>
      </div>
    </Link>
  )
}

function OrderTableRow({ order }: { order: any }) {
  const status = order.status ?? "DRAFT"
  const p = getOrderStatusPresentation(status)
  const currentStep = getWorkflowStep(status)
  const terminal = isTerminal(status)

  return (
    <tr
      className="border-b transition-colors hover:bg-muted/50 cursor-pointer"
      onClick={() => (window.location.href = `/dashboard/orders/${order.id}`)}
    >
      <td className="py-3 pl-4">
        <span className="font-mono text-xs text-muted-foreground">
          #{order.id.slice(0, 8)}
        </span>
      </td>
      <td className="py-3">
        <span className="text-sm font-medium">
          {(order.items?.[0]?.serviceType ?? order.type ?? "Order").replace(
            /_/g,
            " ",
          )}
        </span>
      </td>
      <td className="py-3 text-sm text-muted-foreground">
        {order.customer?.name ?? order.customer?.email ?? "—"}
      </td>
      <td className="py-3">
        <Badge variant={p.variant as any}>{p.label}</Badge>
      </td>
      <td className="py-3">
        {terminal ? (
          <span className="text-xs text-red-600 capitalize">
            {status.toLowerCase()}
          </span>
        ) : (
          <div className="flex items-center gap-1.5">
            {WORKFLOW_STEPS.map((step, i) => (
              <div key={step.label} className="flex items-center">
                <div
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${
                    i <= currentStep
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {i < currentStep ? <Check className="h-2.5 w-2.5" /> : i + 1}
                </div>
                {i < WORKFLOW_STEPS.length - 1 && (
                  <div
                    className={`h-px w-3 mx-0.5 ${
                      i < currentStep
                        ? "bg-emerald-300"
                        : "bg-muted-foreground/20"
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </td>
      <td className="py-3 text-sm font-medium tabular-nums text-right">
        ${Number(order.totalAmount ?? order.items?.[0]?.budget ?? 0).toFixed(2)}
      </td>
      <td className="py-3 pr-4 text-right">
        <Link
          href={`/dashboard/orders/${order.id}`}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          View <ArrowRight className="h-3 w-3" />
        </Link>
      </td>
    </tr>
  )
}

function FilterBar({
  active,
  onChange,
}: {
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={() => onChange("all")}
        className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
          active === "all"
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground hover:bg-muted/80"
        }`}
      >
        All
      </button>
      {STATUS_GROUPS.map((group) => (
        <button
          key={group.key}
          onClick={() => onChange(group.key)}
          className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
            active === group.key
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          {group.label}
        </button>
      ))}
    </div>
  )
}

function StatCard({
  label,
  count,
  icon: Icon,
  color,
}: {
  label: string
  count: number
  icon: React.ElementType
  color: string
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold mt-1">{count}</p>
        </div>
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-full ${color}`}
        >
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  )
}

export default function OrdersPage() {
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid")
  const [filter, setFilter] = useState("all")

  const {
    data: orders = [],
    isLoading,
    refetch,
    error,
  } = useQuery({
    queryKey: ["publisher-orders"],
    queryFn: () => api.orders.list(),
  })

  const stats = useMemo(() => {
    const total = orders.length
    const active = orders.filter(
      (o: any) => getGroupForStatus(o.status) === "active",
    ).length
    const published = orders.filter(
      (o: any) => o.status === "PUBLISHED" || o.status === "VERIFIED",
    ).length
    const complete = orders.filter(
      (o: any) => o.status === "COMPLETED" || o.status === "SETTLED",
    ).length
    return { total, active, published, complete }
  }, [orders])

  const filteredOrders = useMemo(() => {
    if (filter === "all") return orders
    const group = STATUS_GROUPS.find((g) => g.key === filter)
    if (!group) return orders
    return orders.filter((o: any) => group.statuses.includes(o.status))
  }, [orders, filter])

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Orders</h1>
          <p className="text-sm text-muted-foreground">
            Manage your guest post orders
          </p>
        </div>
        <div className="flex flex-col items-center justify-center rounded-xl border py-16">
          <AlertCircle className="mb-3 h-10 w-10 text-destructive" />
          <p className="font-medium">Failed to load orders</p>
          <p className="text-sm text-muted-foreground mb-4">
            {(error as Error).message}
          </p>
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <RefreshCw className="h-4 w-4" /> Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Orders</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your guest post orders and content fulfillment
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border p-0.5">
          <button
            onClick={() => setViewMode("grid")}
            className={`rounded-md p-2 transition-colors ${viewMode === "grid" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            title="Grid view"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode("table")}
            className={`rounded-md p-2 transition-colors ${viewMode === "table" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            title="Table view"
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Stats row */}
      {!isLoading && orders.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Total Orders"
            count={stats.total}
            icon={FileText}
            color="bg-blue-100 text-blue-700"
          />
          <StatCard
            label="Active"
            count={stats.active}
            icon={Clock}
            color="bg-amber-100 text-amber-700"
          />
          <StatCard
            label="Published"
            count={stats.published}
            icon={CheckCircle}
            color="bg-emerald-100 text-emerald-700"
          />
          <StatCard
            label="Completed"
            count={stats.complete}
            icon={Check}
            color="bg-green-100 text-green-700"
          />
        </div>
      )}

      {/* Filter bar */}
      <FilterBar active={filter} onChange={setFilter} />

      {/* Content */}
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="rounded-xl border bg-card p-5 space-y-4 animate-pulse"
            >
              <div className="flex justify-between">
                <div className="h-3 w-20 rounded bg-muted" />
                <div className="h-5 w-16 rounded-full bg-muted" />
              </div>
              <div className="space-y-2">
                <div className="h-5 w-3/4 rounded bg-muted" />
                <div className="h-4 w-1/2 rounded bg-muted" />
              </div>
              <div className="flex justify-between">
                <div className="h-4 w-2/5 rounded bg-muted" />
                <div className="h-4 w-14 rounded bg-muted" />
              </div>
              <div className="h-8 rounded bg-muted" />
              <div className="flex justify-between">
                <div className="h-3 w-24 rounded bg-muted" />
                <div className="h-3 w-12 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredOrders.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border py-20">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
            <Search className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-lg font-medium">No orders found</p>
          <p className="text-sm text-muted-foreground mt-1">
            {filter === "all"
              ? "Orders will appear here when assigned to you"
              : `No orders in the "${STATUS_GROUPS.find((g) => g.key === filter)?.label ?? filter}" group`}
          </p>
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredOrders.map((order: any) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="py-3 pl-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Order
                </th>
                <th className="py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Service
                </th>
                <th className="py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Customer
                </th>
                <th className="py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Status
                </th>
                <th className="py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Progress
                </th>
                <th className="py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Amount
                </th>
                <th className="py-3 pr-4 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider" />
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map((order: any) => (
                <OrderTableRow key={order.id} order={order} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
