"use client"

import type {
  AdminCommandCenterAction,
  AdminCommandCenterPriority,
} from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  Skeleton,
} from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import type { LucideIcon } from "lucide-react"
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  Clock3,
  FileWarning,
  HeadphonesIcon,
  Landmark,
  ListChecks,
  RefreshCw,
  Scale,
  ShieldAlert,
  ShieldCheck,
  ShoppingCart,
  UserRoundCog,
} from "lucide-react"
import Link from "next/link"
import { AdminPage, AdminPageHeader } from "../../../components/admin-workspace"
import { api } from "../../../lib/api"

const actionLabels: Record<AdminCommandCenterAction["type"], string> = {
  RECONCILIATION: "Reconciliation",
  CANCELLATION: "Cancellation",
  DISPUTE: "Dispute",
  DELIVERY_VERIFICATION: "Delivery verification",
  FULFILLMENT: "Fulfillment",
  SETTLEMENT: "Settlement",
  WITHDRAWAL: "Withdrawal",
  SUPPORT: "Support",
}

const priorityPresentation: Record<
  AdminCommandCenterPriority,
  { label: string; variant: "destructive" | "warning" | "secondary" }
> = {
  CRITICAL: { label: "Critical", variant: "destructive" },
  HIGH: { label: "Urgent", variant: "warning" },
  MEDIUM: { label: "Review", variant: "secondary" },
}

function formatMoney(value: string, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value))
}

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
  tone?: "default" | "warning" | "danger" | "success"
  loading?: boolean
}) {
  const toneClass = {
    default: "bg-primary/10 text-primary",
    warning: "bg-amber-100 text-amber-700",
    danger: "bg-red-100 text-red-700",
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

function ActionQueueSkeleton() {
  return (
    <div className="divide-y">
      {[1, 2, 3, 4, 5].map((item) => (
        <div key={item} className="space-y-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-28" />
          </div>
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  )
}

function ActionRow({ item }: { item: AdminCommandCenterAction }) {
  const priority = priorityPresentation[item.priority]
  const timing = item.deadlineAt ?? item.createdAt

  return (
    <Link
      href={item.href}
      className="group grid gap-4 border-b px-5 py-4 transition-colors last:border-b-0 hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={priority.variant}>{priority.label}</Badge>
          <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {actionLabels[item.type]}
          </span>
          <span className="text-xs font-medium text-muted-foreground">
            {item.owner}
          </span>
        </div>
        <p className="mt-2 truncate text-sm font-semibold">{item.title}</p>
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {item.description}
        </p>
      </div>
      <div className="flex items-center justify-between gap-5 sm:justify-end">
        <div className="text-left sm:text-right">
          {item.amount && item.currency ? (
            <p className="text-sm font-semibold tabular-nums">
              {formatMoney(item.amount, item.currency)}
            </p>
          ) : null}
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground sm:justify-end">
            <Clock3 className="h-3 w-3" />
            {formatDistanceToNow(new Date(timing), { addSuffix: true })}
          </p>
        </div>
        <span className="inline-flex items-center gap-1 text-sm font-semibold text-primary">
          Review
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  )
}

function HealthRow({
  href,
  label,
  value,
  icon: Icon,
  urgent = false,
}: {
  href: string
  label: string
  value: number
  icon: LucideIcon
  urgent?: boolean
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-muted"
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
          urgent && value > 0
            ? "bg-amber-100 text-amber-700"
            : "bg-muted text-muted-foreground"
        }`}
      >
        <Icon className="h-4 w-4" />
      </div>
      <span className="min-w-0 flex-1 text-sm font-medium">{label}</span>
      <span
        className={`text-sm font-bold tabular-nums ${
          urgent && value > 0 ? "text-amber-700" : "text-foreground"
        }`}
      >
        {value}
      </span>
    </Link>
  )
}

function prettifyAction(action: string) {
  return action.replaceAll("_", " ").toLowerCase()
}

export function SuperAdminCommandCenter() {
  const commandCenter = useQuery({
    queryKey: ["admin", "command-center"],
    queryFn: () => api.admin.getCommandCenter(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
  })

  if (commandCenter.error) {
    return (
      <ErrorState
        title="We couldn't load the command center"
        description={(commandCenter.error as Error).message}
        onRetry={() => commandCenter.refetch()}
      />
    )
  }

  const data = commandCenter.data
  const lifecycleTotal =
    data?.lifecycle.reduce((total, stage) => total + stage.count, 0) ?? 0
  const reconciliation = data?.finance.reconciliation

  return (
    <AdminPage className="space-y-7">
      <AdminPageHeader
        eyebrow="Super Admin command center"
        title="Platform oversight"
        description="Review platform exceptions, protect operational deadlines, and keep financial and governance risks visible."
        icon={ShieldCheck}
        actions={
          <>
            {data?.generatedAt ? (
              <span className="hidden text-xs text-muted-foreground md:inline">
                Updated{" "}
                {formatDistanceToNow(new Date(data.generatedAt), {
                  addSuffix: true,
                })}
              </span>
            ) : null}
            <Button
              variant="outline"
              onClick={() => commandCenter.refetch()}
              disabled={commandCenter.isFetching}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${commandCenter.isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Needs action"
          value={String(data?.overview.needsAction ?? 0)}
          description="Exceptions across platform teams"
          icon={ListChecks}
          tone={(data?.overview.needsAction ?? 0) > 0 ? "warning" : "success"}
          loading={commandCenter.isLoading}
        />
        <MetricCard
          label="Orders in flight"
          value={String(data?.overview.activeOrders ?? 0)}
          description="All non-terminal orders"
          icon={ShoppingCart}
          loading={commandCenter.isLoading}
        />
        <MetricCard
          label="Financial exceptions"
          value={String(data?.overview.financeExceptions ?? 0)}
          description="Integrity, payout, and withdrawal issues"
          icon={ShieldAlert}
          tone={
            (data?.overview.financeExceptions ?? 0) > 0 ? "danger" : "success"
          }
          loading={commandCenter.isLoading}
        />
        <MetricCard
          label="Verification issues"
          value={String(data?.overview.verificationIssues ?? 0)}
          description="Failed or manual-review deliveries"
          icon={ClipboardCheck}
          tone={
            (data?.overview.verificationIssues ?? 0) > 0 ? "warning" : "success"
          }
          loading={commandCenter.isLoading}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="overflow-hidden rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
            <div>
              <CardTitle className="text-lg">Priority action queue</CardTitle>
              <CardDescription>
                Server-prioritized exceptions. Decisions remain in their
                protected workspaces.
              </CardDescription>
            </div>
            <Badge variant="secondary">{data?.overview.needsAction ?? 0}</Badge>
          </CardHeader>
          <CardContent className="p-0">
            {commandCenter.isLoading ? (
              <ActionQueueSkeleton />
            ) : data?.actionQueue.length ? (
              data.actionQueue.map((item) => (
                <ActionRow key={`${item.type}:${item.id}`} item={item} />
              ))
            ) : (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <p className="mt-4 font-semibold">No platform exceptions</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  New operational, financial, and support risks will appear here
                  automatically.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4" /> Platform health
            </CardTitle>
            <CardDescription>
              Cross-team workload requiring supervision.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 px-3">
            {commandCenter.isLoading ? (
              <div className="space-y-3 px-2 pb-3">
                {[1, 2, 3, 4, 5, 6].map((item) => (
                  <Skeleton key={item} className="h-11 w-full" />
                ))}
              </div>
            ) : (
              <>
                <HealthRow
                  href="/dashboard/fulfillment"
                  label="Unassigned fulfillment"
                  value={data?.health.unassignedFulfillment ?? 0}
                  icon={UserRoundCog}
                  urgent
                />
                <HealthRow
                  href="/dashboard/fulfillment"
                  label="Overdue fulfillment"
                  value={data?.health.overdueFulfillment ?? 0}
                  icon={Clock3}
                  urgent
                />
                <HealthRow
                  href="/dashboard/disputes"
                  label="Active disputes"
                  value={data?.health.activeDisputes ?? 0}
                  icon={Scale}
                  urgent
                />
                <HealthRow
                  href="/dashboard/cancellations"
                  label="Active cancellations"
                  value={data?.health.activeCancellations ?? 0}
                  icon={FileWarning}
                  urgent
                />
                <HealthRow
                  href="/dashboard/support"
                  label="Unassigned support"
                  value={data?.health.unassignedSupport ?? 0}
                  icon={HeadphonesIcon}
                  urgent
                />
                <HealthRow
                  href="/dashboard/verification"
                  label="Domain verification"
                  value={data?.health.domainVerificationIssues ?? 0}
                  icon={ShieldCheck}
                />
                <HealthRow
                  href="/dashboard/marketplace"
                  label="Listings awaiting review"
                  value={data?.health.marketplacePendingReview ?? 0}
                  icon={ClipboardCheck}
                />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="rounded-2xl shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShoppingCart className="h-4 w-4" /> Order lifecycle pulse
            </CardTitle>
            <CardDescription>
              Exact order counts grouped into understandable workflow stages.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {commandCenter.isLoading
              ? [1, 2, 3, 4, 5, 6].map((item) => (
                  <Skeleton key={item} className="h-9 w-full" />
                ))
              : data?.lifecycle.map((stage) => {
                  const width =
                    lifecycleTotal > 0
                      ? Math.max((stage.count / lifecycleTotal) * 100, 2)
                      : 0
                  return (
                    <div key={stage.key}>
                      <div className="mb-1.5 flex items-center justify-between gap-4 text-sm">
                        <span className="font-medium">{stage.label}</span>
                        <span className="font-semibold tabular-nums">
                          {stage.count}
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-[width]"
                          style={{ width: `${width}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/orders">
                Open all orders <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Landmark className="h-4 w-4" /> Financial oversight
              </CardTitle>
              <CardDescription>
                Read-only platform totals and exception state.
              </CardDescription>
            </div>
            {reconciliation?.available ? (
              <Badge variant={reconciliation.ok ? "success" : "destructive"}>
                {reconciliation.ok
                  ? "Reconciled"
                  : `${reconciliation.totalIssues} issues`}
              </Badge>
            ) : (
              <Badge variant="secondary">Check unavailable</Badge>
            )}
          </CardHeader>
          <CardContent>
            {commandCenter.isLoading ? (
              <div className="grid grid-cols-2 gap-4">
                {[1, 2, 3, 4, 5, 6].map((item) => (
                  <Skeleton key={item} className="h-20 w-full" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border bg-muted/20 p-4">
                  <p className="text-xs text-muted-foreground">Platform GMV</p>
                  <p className="mt-1 text-lg font-bold tabular-nums">
                    {formatMoney(
                      data?.finance.gmv ?? "0",
                      data?.finance.currency,
                    )}
                  </p>
                </div>
                <div className="rounded-xl border bg-muted/20 p-4">
                  <p className="text-xs text-muted-foreground">Net revenue</p>
                  <p className="mt-1 text-lg font-bold tabular-nums">
                    {formatMoney(
                      data?.finance.netRevenue ?? "0",
                      data?.finance.currency,
                    )}
                  </p>
                </div>
                <div className="rounded-xl border bg-muted/20 p-4">
                  <p className="text-xs text-muted-foreground">Settlements</p>
                  <p className="mt-1 text-lg font-bold tabular-nums">
                    {data?.finance.settlementsInReview ?? 0}
                  </p>
                  <p className="text-[11px] text-muted-foreground">In review</p>
                </div>
                <div className="rounded-xl border bg-muted/20 p-4">
                  <p className="text-xs text-muted-foreground">Withdrawals</p>
                  <p className="mt-1 text-lg font-bold tabular-nums">
                    {data?.finance.withdrawalsPending ?? 0}
                  </p>
                  <p className="text-[11px] text-muted-foreground">Pending</p>
                </div>
                <div className="rounded-xl border bg-muted/20 p-4">
                  <p className="text-xs text-muted-foreground">
                    Failed withdrawals
                  </p>
                  <p className="mt-1 text-lg font-bold tabular-nums">
                    {data?.finance.failedWithdrawals ?? 0}
                  </p>
                </div>
                <div className="rounded-xl border bg-muted/20 p-4">
                  <p className="text-xs text-muted-foreground">
                    Failed payouts
                  </p>
                  <p className="mt-1 text-lg font-bold tabular-nums">
                    {data?.finance.failedPayouts ?? 0}
                  </p>
                </div>
              </div>
            )}
            <Button className="mt-4" variant="outline" size="sm" asChild>
              <Link href="/dashboard/finance">
                Open Finance <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4" /> Recent audited activity
            </CardTitle>
            <CardDescription>
              Sanitized governance events from the immutable audit trail.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard/audit-logs">View audit logs</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {commandCenter.isLoading ? (
            <div className="grid gap-3 md:grid-cols-2">
              {[1, 2, 3, 4].map((item) => (
                <Skeleton key={item} className="h-16 w-full" />
              ))}
            </div>
          ) : data?.recentActivity.length ? (
            <div className="grid gap-2 md:grid-cols-2">
              {data.recentActivity.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-3 rounded-xl border bg-muted/20 p-3"
                >
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Activity className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium capitalize">
                      {prettifyAction(item.action)}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {item.actorName} · {item.entity}
                      {item.entityId ? ` #${item.entityId.slice(0, 8)}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {formatDistanceToNow(new Date(item.createdAt), {
                      addSuffix: true,
                    })}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              <CircleDollarSign className="h-4 w-4" />
              No audited activity is available yet.
            </div>
          )}
        </CardContent>
      </Card>
    </AdminPage>
  )
}
