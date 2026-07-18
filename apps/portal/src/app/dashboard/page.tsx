"use client"

import type { OrderResponse } from "@guestpost/api-client"
import type { CampaignStatus } from "@guestpost/database"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  getCampaignStatusPresentation,
  getOrderStatusPresentation,
  Skeleton,
  StatusBadge,
} from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import type { LucideIcon } from "lucide-react"
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Inbox,
  Megaphone,
  RefreshCw,
  ShoppingBag,
  Sparkles,
  Store,
  Wallet,
} from "lucide-react"
import Link from "next/link"
import { api } from "../../lib/api"
import { useAuth } from "../../lib/auth"
import {
  CUSTOMER_ACTIVE_STATUSES,
  CUSTOMER_RESULT_STATUSES,
  formatCustomerMoney,
  getCustomerNextAction,
  getCustomerOrderDeadline,
  orderNeedsCustomerAttention,
  sortCustomerOrdersByPriority,
} from "../../lib/customer-order-workflow"

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

function DeadlineBadge({ order }: { order: OrderResponse }) {
  const deadline = getCustomerOrderDeadline(order)
  const className =
    deadline.risk === "overdue"
      ? "border-red-200 bg-red-50 text-red-700"
      : deadline.risk === "soon"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-border bg-muted/50 text-muted-foreground"

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium ${className}`}
      title={deadline.kind}
    >
      <Clock3 className="h-3 w-3" />
      {deadline.label}
    </span>
  )
}

function OrderWorkRow({
  order,
  user,
}: {
  order: OrderResponse
  user: { id: string; customerRole: "OWNER" | "MEMBER" | null }
}) {
  const presentation = getOrderStatusPresentation(order.status)
  const nextAction = getCustomerNextAction(order, user)
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
          <DeadlineBadge order={order} />
        </div>
        <p className="mt-2 truncate text-sm font-semibold capitalize">
          {order.title || service}
        </p>
        <p className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
          <ExternalLink className="h-3 w-3 shrink-0" />
          <span className="truncate">{website}</span>
          {order.campaign && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{order.campaign.name}</span>
            </>
          )}
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 sm:justify-end">
        <div className="text-left sm:text-right">
          <p className="text-sm font-semibold tabular-nums">
            {formatCustomerMoney(order.totalAmount, order.currency)}
          </p>
          <p className="text-[11px] text-muted-foreground capitalize">
            {service}
          </p>
        </div>
        <span
          className={`inline-flex min-w-36 items-center justify-end gap-1 text-sm font-semibold ${
            nextAction.tone === "urgent" ? "text-amber-700" : "text-primary"
          }`}
        >
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
  const customer = user

  const workbenchQuery = useQuery({
    queryKey: ["customer-workbench", customer?.id, customer?.organizationId],
    enabled: Boolean(customer?.organizationId),
    queryFn: async () => {
      const [attention, active, results, wallet, campaigns] = await Promise.all(
        [
          api.orders.listPaginated({
            needsAction: true,
            sort: "priority",
            take: 8,
          }),
          api.orders.listPaginated({
            statuses: CUSTOMER_ACTIVE_STATUSES,
            sort: "priority",
            take: 12,
          }),
          api.orders.listPaginated({
            statuses: CUSTOMER_RESULT_STATUSES,
            take: 1,
          }),
          api.billing.getWallet(),
          api.campaigns.listCampaignsPaginated({ take: 5, skip: 0 }),
        ],
      )
      return { attention, active, results, wallet, campaigns }
    },
  })

  if (!customer) return null

  const data = workbenchQuery.data
  const orderedActive = [...(data?.active.items ?? [])].sort((left, right) =>
    sortCustomerOrdersByPriority(left, right, customer),
  )
  const attentionOrders = (data?.attention.items ?? []).filter((order) =>
    orderNeedsCustomerAttention(order, customer),
  )
  const attentionIds = new Set(attentionOrders.map((order) => order.id))
  const inProgressOrders = orderedActive
    .filter((order) => !attentionIds.has(order.id))
    .slice(0, 6)
  const wallet = data?.wallet
  const campaigns = data?.campaigns.items ?? []
  const firstName = customer.name?.trim().split(/\s+/)[0]

  if (workbenchQuery.error) {
    return (
      <ErrorState
        title="We couldn't load your work queue"
        description={(workbenchQuery.error as Error).message}
        onRetry={() => workbenchQuery.refetch()}
      />
    )
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Sparkles className="h-4 w-4" />
            Customer workbench
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            {firstName ? `Welcome back, ${firstName}` : "Your work queue"}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Handle the orders that need you, track active placements, and keep
            your campaign funds ready.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" asChild>
            <Link href="/dashboard/reports">
              <BarChart3 className="mr-2 h-4 w-4" />
              View reports
            </Link>
          </Button>
          <Button asChild>
            <Link href="/dashboard/marketplace">
              <Store className="mr-2 h-4 w-4" />
              Browse marketplace
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Needs your action"
          value={String(data?.attention.total ?? 0)}
          description="Payments, reviews, or confirmations"
          icon={Inbox}
          tone={(data?.attention.total ?? 0) > 0 ? "warning" : "success"}
          loading={workbenchQuery.isLoading}
        />
        <MetricCard
          label="Active orders"
          value={String(data?.active.total ?? 0)}
          description="Placements currently in progress"
          icon={ShoppingBag}
          loading={workbenchQuery.isLoading}
        />
        <MetricCard
          label="Wallet balance"
          value={formatCustomerMoney(
            wallet?.availableBalance,
            wallet?.currency ?? "USD",
          )}
          description={
            customer.customerRole === "OWNER"
              ? "Available for new orders"
              : "Organization funds available"
          }
          icon={Wallet}
          loading={workbenchQuery.isLoading}
        />
        <MetricCard
          label="Published placements"
          value={String(data?.results.total ?? 0)}
          description="Published through completed results"
          icon={CheckCircle2}
          tone="success"
          loading={workbenchQuery.isLoading}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.75fr)]">
        <Card className="overflow-hidden rounded-2xl shadow-sm">
          <CardHeader className="border-b">
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Inbox className="h-5 w-5 text-amber-600" />
                  Needs your attention
                </CardTitle>
                <CardDescription>
                  The highest-priority customer actions across your orders.
                </CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/dashboard/orders?view=attention">
                  View queue
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          {workbenchQuery.isLoading ? (
            <QueueSkeleton />
          ) : attentionOrders.length ? (
            attentionOrders.map((order) => (
              <OrderWorkRow key={order.id} order={order} user={customer} />
            ))
          ) : (
            <CardContent className="flex min-h-56 flex-col items-center justify-center text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <p className="mt-4 font-semibold">You're all caught up</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                New payment, review, delivery, and cancellation actions will
                appear here.
              </p>
            </CardContent>
          )}
        </Card>

        <div className="space-y-6">
          <Card className="rounded-2xl shadow-sm">
            <CardHeader>
              <CardTitle className="text-base">Wallet snapshot</CardTitle>
              <CardDescription>
                Organization funds used for marketplace orders.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-xl border bg-muted/30 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Available now
                </p>
                <p className="mt-1 text-2xl font-bold tabular-nums">
                  {formatCustomerMoney(
                    wallet?.availableBalance,
                    wallet?.currency ?? "USD",
                  )}
                </p>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Reserved</span>
                <span className="font-semibold tabular-nums">
                  {formatCustomerMoney(
                    wallet?.reservedBalance,
                    wallet?.currency ?? "USD",
                  )}
                </span>
              </div>
              {customer.customerRole === "OWNER" ? (
                <Button className="w-full" variant="outline" asChild>
                  <Link href="/dashboard/billing">Manage billing</Link>
                </Button>
              ) : (
                <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                  Organization owners manage deposits and billing settings.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-2xl shadow-sm">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base">Active campaigns</CardTitle>
                  <CardDescription>
                    Keep related placements together.
                  </CardDescription>
                </div>
                <Megaphone className="h-5 w-5 text-primary" />
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {campaigns.length ? (
                campaigns.map((campaign) => {
                  const presentation = getCampaignStatusPresentation(
                    campaign.status as CampaignStatus,
                  )
                  return (
                    <Link
                      key={campaign.id}
                      href={`/dashboard/campaigns/${campaign.id}`}
                      className="flex items-center justify-between gap-3 rounded-xl border p-3 transition-colors hover:bg-muted/40"
                    >
                      <span className="min-w-0 truncate text-sm font-medium">
                        {campaign.name}
                      </span>
                      <StatusBadge variant={presentation.variant}>
                        {presentation.label}
                      </StatusBadge>
                    </Link>
                  )
                })
              ) : (
                <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No campaigns yet.
                </p>
              )}
              <Button variant="ghost" className="w-full" asChild>
                <Link href="/dashboard/campaigns">
                  Manage campaigns
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="overflow-hidden rounded-2xl shadow-sm">
        <CardHeader className="border-b">
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>Orders in progress</CardTitle>
              <CardDescription>
                Follow fulfillment without digging through reports.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => workbenchQuery.refetch()}
              disabled={workbenchQuery.isFetching}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${workbenchQuery.isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>
        </CardHeader>
        {workbenchQuery.isLoading ? (
          <QueueSkeleton />
        ) : inProgressOrders.length ? (
          inProgressOrders.map((order) => (
            <OrderWorkRow key={order.id} order={order} user={customer} />
          ))
        ) : (
          <CardContent className="py-10 text-center">
            <p className="font-medium">No other orders in progress</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Browse the marketplace when you're ready for another placement.
            </p>
            <Button className="mt-4" asChild>
              <Link href="/dashboard/marketplace">
                <Store className="mr-2 h-4 w-4" />
                Browse marketplace
              </Link>
            </Button>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
