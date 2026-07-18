"use client"

import type { OrderResponse } from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  getOrderStatusPresentation,
  Skeleton,
  StatusBadge,
} from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import type { LucideIcon } from "lucide-react"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  Inbox,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  WalletCards,
} from "lucide-react"
import Link from "next/link"
import { api } from "../../lib/api"
import { useAuth } from "../../lib/auth"
import {
  formatPublisherMoney,
  getOrderDueState,
  getPublisherNextAction,
  isOpenPublisherOrder,
  orderNeedsPublisherAttention,
  sortOrdersByOperationalPriority,
} from "../../lib/publisher-order-workflow"

function MetricCard({
  label,
  value,
  description,
  icon: Icon,
  tone = "default",
  loading,
}: {
  label: string
  value: string
  description: string
  icon: LucideIcon
  tone?: "default" | "warning" | "success"
  loading?: boolean
}) {
  const toneClass = {
    default: "bg-primary/10 text-primary",
    warning: "bg-amber-100 text-amber-700",
    success: "bg-emerald-100 text-emerald-700",
  }[tone]

  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted-foreground">{label}</p>
            {loading ? (
              <Skeleton className="mt-2 h-8 w-24" />
            ) : (
              <p className="mt-1 text-2xl font-bold tracking-tight tabular-nums">
                {value}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${toneClass}`}
          >
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function DueLabel({ order }: { order: OrderResponse }) {
  const due = getOrderDueState(order)
  const className =
    due.risk === "overdue"
      ? "text-red-700 bg-red-50 border-red-200"
      : due.risk === "soon"
        ? "text-amber-700 bg-amber-50 border-amber-200"
        : "text-muted-foreground bg-muted/50"

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium ${className}`}
    >
      <Clock3 className="h-3 w-3" />
      {due.label}
    </span>
  )
}

function OrderWorkRow({ order }: { order: OrderResponse }) {
  const presentation = getOrderStatusPresentation(order.status)
  const nextAction = getPublisherNextAction(order)
  const website =
    order.website?.url ?? order.items[0]?.website?.url ?? "Website unavailable"
  const service = order.type.replaceAll("_", " ").toLowerCase()

  return (
    <Link
      href={`/dashboard/orders/${order.id}`}
      className="group grid gap-4 border-b px-5 py-4 transition-colors last:border-b-0 hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            #{order.id.slice(0, 8)}
          </span>
          <StatusBadge variant={presentation.variant}>
            {presentation.label}
          </StatusBadge>
          <DueLabel order={order} />
        </div>
        <p className="mt-2 truncate text-sm font-semibold capitalize">
          {order.title || service}
        </p>
        <p className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
          <ExternalLink className="h-3 w-3 shrink-0" />
          <span className="truncate">{website}</span>
          <span aria-hidden="true">·</span>
          <span className="capitalize">{service}</span>
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 sm:justify-end">
        <div className="text-left sm:text-right">
          <p className="text-sm font-semibold tabular-nums">
            {formatPublisherMoney(order.totalAmount, order.currency)}
          </p>
          <p className="text-[11px] text-muted-foreground">Order value</p>
        </div>
        <span className="inline-flex min-w-36 items-center justify-end gap-1 text-sm font-semibold text-primary">
          {nextAction.label}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  )
}

function QueueSkeleton() {
  return (
    <div className="divide-y">
      {[1, 2, 3, 4].map((item) => (
        <div key={item} className="flex items-center justify-between gap-4 p-5">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
          <Skeleton className="h-9 w-32" />
        </div>
      ))}
    </div>
  )
}

export default function DashboardPage() {
  const { user } = useAuth()
  const balanceQuery = useQuery({
    queryKey: ["publisher-balance", user?.publisherId],
    queryFn: () => api.publisherPayouts.getBalance(),
    enabled: Boolean(user?.publisherId),
  })
  const ordersQuery = useQuery({
    queryKey: ["publisher-orders"],
    queryFn: () => api.orders.list(),
  })

  const orders = ordersQuery.data ?? []
  const ordered = [...orders].sort(sortOrdersByOperationalPriority)
  const attentionOrders = ordered.filter(orderNeedsPublisherAttention)
  const inProgressOrders = ordered.filter(
    (order) =>
      isOpenPublisherOrder(order) && !orderNeedsPublisherAttention(order),
  )
  const dueSoon = orders.filter((order) => {
    const due = getOrderDueState(order)
    return due.risk === "soon" || due.risk === "overdue"
  }).length
  const balance = balanceQuery.data
  const firstName = user?.name?.trim().split(/\s+/)[0]

  const retry = () => {
    ordersQuery.refetch()
    balanceQuery.refetch()
  }

  if (ordersQuery.error) {
    return (
      <ErrorState
        title="We couldn't load your work queue"
        description={(ordersQuery.error as Error).message}
        onRetry={retry}
      />
    )
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Sparkles className="h-4 w-4" />
            Publisher workbench
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            {firstName ? `Welcome back, ${firstName}` : "Your work queue"}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Review the orders that need attention, protect your deadlines, and
            track what you have earned.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={retry}
          disabled={ordersQuery.isFetching || balanceQuery.isFetching}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${ordersQuery.isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Needs attention"
          value={String(attentionOrders.length)}
          description="Orders waiting on you"
          icon={Inbox}
          tone={attentionOrders.length > 0 ? "warning" : "success"}
          loading={ordersQuery.isLoading}
        />
        <MetricCard
          label="Due soon"
          value={String(dueSoon)}
          description="Overdue or due within 48 hours"
          icon={AlertTriangle}
          tone={dueSoon > 0 ? "warning" : "success"}
          loading={ordersQuery.isLoading}
        />
        <MetricCard
          label="Withdrawable funds"
          value={formatPublisherMoney(balance?.withdrawableBalance)}
          description="Available to withdraw now"
          icon={WalletCards}
          tone="success"
          loading={balanceQuery.isLoading}
        />
        <MetricCard
          label="Lifetime earnings"
          value={formatPublisherMoney(balance?.lifetimeEarnings)}
          description="Total publisher earnings"
          icon={CircleDollarSign}
          loading={balanceQuery.isLoading}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="overflow-hidden rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-start justify-between gap-4 border-b bg-background">
            <div>
              <CardTitle className="text-lg">Needs your attention</CardTitle>
              <CardDescription>
                Sorted by urgency and fulfillment deadline.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/orders?view=attention">
                View orders <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {ordersQuery.isLoading ? (
              <QueueSkeleton />
            ) : attentionOrders.length > 0 ? (
              attentionOrders
                .slice(0, 6)
                .map((order) => <OrderWorkRow key={order.id} order={order} />)
            ) : (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <p className="mt-4 font-semibold">You're all caught up</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  New orders, revisions, and publishing tasks will appear here.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="rounded-2xl shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <WalletCards className="h-4 w-4" /> Earnings snapshot
              </CardTitle>
              <CardDescription>
                Read-only balance summary from your publisher account.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-xl bg-foreground p-4 text-background">
                <p className="text-xs font-medium text-background/70">
                  Available now
                </p>
                <p className="mt-1 text-2xl font-bold tabular-nums">
                  {formatPublisherMoney(balance?.withdrawableBalance)}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border p-3">
                  <p className="text-xs text-muted-foreground">Pending</p>
                  <p className="mt-1 font-semibold tabular-nums">
                    {formatPublisherMoney(balance?.pendingBalance)}
                  </p>
                </div>
                <div className="rounded-xl border p-3">
                  <p className="text-xs text-muted-foreground">Lifetime</p>
                  <p className="mt-1 font-semibold tabular-nums">
                    {formatPublisherMoney(balance?.lifetimeEarnings)}
                  </p>
                </div>
              </div>
              {balanceQuery.error && (
                <p className="text-sm text-destructive">
                  Balance data is temporarily unavailable.
                </p>
              )}
              <Button className="w-full" asChild>
                <Link href="/dashboard/earnings">Manage earnings</Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="rounded-2xl shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4" /> Workflow protection
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                Order actions are validated against the latest server status.
              </p>
              <p>
                Funds remain pending until delivery and settlement requirements
                are met.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="overflow-hidden rounded-2xl shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
          <div>
            <CardTitle className="text-lg">In progress</CardTitle>
            <CardDescription>
              Orders currently moving through review, verification, or
              settlement.
            </CardDescription>
          </div>
          <Badge variant="secondary">{inProgressOrders.length}</Badge>
        </CardHeader>
        <CardContent className="p-0">
          {ordersQuery.isLoading ? (
            <QueueSkeleton />
          ) : inProgressOrders.length > 0 ? (
            inProgressOrders
              .slice(0, 5)
              .map((order) => <OrderWorkRow key={order.id} order={order} />)
          ) : (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              No orders are currently in progress.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
