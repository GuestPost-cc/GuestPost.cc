"use client"

import type {
  AdminFinancePipelineStage,
  AdminFinanceWorkbenchAction,
  AdminFinanceWorkbenchActionType,
  AdminFinanceWorkbenchPriority,
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
  BadgeDollarSign,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  CreditCard,
  HeadphonesIcon,
  Landmark,
  LifeBuoy,
  RefreshCw,
  Scale,
  ShieldAlert,
  ShieldCheck,
  WalletCards,
} from "lucide-react"
import Link from "next/link"
import { AdminPage, AdminPageHeader } from "../../../components/admin-workspace"
import { api } from "../../../lib/api"

const actionLabels: Record<AdminFinanceWorkbenchActionType, string> = {
  RECONCILIATION: "Reconciliation",
  SUPPORT: "Support",
  PAYOUT: "Payout",
  WITHDRAWAL: "Withdrawal",
  CANCELLATION: "Cancellation",
  DISPUTE: "Dispute",
  SETTLEMENT: "Settlement",
}

const priorityPresentation: Record<
  AdminFinanceWorkbenchPriority,
  { label: string; variant: "destructive" | "warning" | "secondary" }
> = {
  CRITICAL: { label: "Critical", variant: "destructive" },
  HIGH: { label: "Urgent", variant: "warning" },
  MEDIUM: { label: "Review", variant: "secondary" },
}

const pipelineOrder: Record<string, string[]> = {
  settlements: [
    "PENDING",
    "UNDER_REVIEW",
    "CUSTOMER_APPROVED",
    "ADMIN_APPROVED",
  ],
  withdrawals: ["PENDING", "APPROVED", "PROCESSING", "FAILED"],
  payouts: ["PENDING", "PROCESSING", "FAILED"],
}

function formatMoney(value: string | null | undefined, currency = "USD") {
  if (value === null || value === undefined) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value))
}

function labelStatus(value: string) {
  return value.replaceAll("_", " ").toLowerCase()
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
    warning:
      "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    danger: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    success:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
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

function ActionRow({ item }: { item: AdminFinanceWorkbenchAction }) {
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

function PipelineColumn({
  title,
  kind,
  rows,
  href,
}: {
  title: string
  kind: "settlements" | "withdrawals" | "payouts"
  rows: AdminFinancePipelineStage[]
  href: string
}) {
  const lookup = new Map(rows.map((row) => [row.status, row]))

  return (
    <div className="rounded-xl border bg-muted/15 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">{title}</p>
        <Button variant="ghost" size="sm" className="h-7 px-2" asChild>
          <Link href={href}>Open</Link>
        </Button>
      </div>
      <div className="space-y-2.5">
        {pipelineOrder[kind].map((status) => {
          const row = lookup.get(status)
          return (
            <div key={status} className="flex items-center gap-3 text-sm">
              <span className="min-w-0 flex-1 capitalize text-muted-foreground">
                {labelStatus(status)}
              </span>
              <span className="font-semibold tabular-nums">
                {row?.count ?? 0}
              </span>
              <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">
                {formatMoney(row?.amount ?? "0")}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ActivityLabel({ action }: { action: string }) {
  return <>{action.replaceAll("_", " ").toLowerCase()}</>
}

export function FinanceWorkbench() {
  const workbench = useQuery({
    queryKey: ["admin", "finance-workbench"],
    queryFn: () => api.admin.getFinanceWorkbench(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
  })

  if (workbench.error) {
    return (
      <ErrorState
        title="We couldn't load the Finance workbench"
        description={(workbench.error as Error).message}
        onRetry={() => workbench.refetch()}
      />
    )
  }

  const data = workbench.data
  const recon = data?.reconciliation
  const revenue = data?.revenue

  return (
    <AdminPage className="space-y-7">
      <AdminPageHeader
        eyebrow="Finance workbench"
        title="Money operations"
        description="Protect publisher funds, respond to support, and move every financial decision through its audited workflow."
        icon={Landmark}
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
              onClick={() => workbench.refetch()}
              disabled={workbench.isFetching}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${workbench.isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="Ready for decision"
          value={String(data?.overview.readyForDecision ?? 0)}
          description="Settlement, withdrawal, and refund decisions"
          icon={Scale}
          tone={
            (data?.overview.readyForDecision ?? 0) > 0 ? "warning" : "success"
          }
          loading={workbench.isLoading}
        />
        <MetricCard
          label="Support needs attention"
          value={String(data?.overview.activeSupport ?? 0)}
          description={`${data?.support.overdue ?? 0} beyond the 24-hour target`}
          icon={HeadphonesIcon}
          tone={(data?.support.overdue ?? 0) > 0 ? "warning" : "default"}
          loading={workbench.isLoading}
        />
        <MetricCard
          label="Funds in flight"
          value={formatMoney(data?.overview.fundsInFlight)}
          description="Active settlements and withdrawals"
          icon={WalletCards}
          loading={workbench.isLoading}
        />
        <MetricCard
          label="Financial exceptions"
          value={String(data?.overview.financialExceptions ?? 0)}
          description="Integrity, withdrawal, and payout signals"
          icon={ShieldAlert}
          tone={
            (data?.overview.financialExceptions ?? 0) > 0 ? "danger" : "success"
          }
          loading={workbench.isLoading}
        />
        <MetricCard
          label="30-day net revenue"
          value={formatMoney(data?.overview.netRevenue30d)}
          description="Platform revenue in the current window"
          icon={CircleDollarSign}
          loading={workbench.isLoading}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card className="overflow-hidden rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
            <div>
              <CardTitle className="text-lg">Priority Finance queue</CardTitle>
              <CardDescription>
                Support and financial exceptions, prioritized on the server.
                Decisions stay in protected workspaces.
              </CardDescription>
            </div>
            <Badge variant="secondary">{data?.actionQueue.length ?? 0}</Badge>
          </CardHeader>
          <CardContent className="p-0">
            {workbench.isLoading ? (
              <ActionQueueSkeleton />
            ) : data?.actionQueue.length ? (
              data.actionQueue.map((item) => (
                <ActionRow key={`${item.type}:${item.id}`} item={item} />
              ))
            ) : (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <p className="mt-4 font-semibold">Finance queue is clear</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  New support, settlement, withdrawal, payout, and integrity
                  work will appear here automatically.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <LifeBuoy className="h-5 w-5" /> Finance Support inbox
              </CardTitle>
              <CardDescription>
                Publisher replies and platform-ticket internal coordination.
              </CardDescription>
            </div>
            <Badge
              variant={
                (data?.support.overdue ?? 0) > 0 ? "warning" : "secondary"
              }
            >
              {data?.support.active ?? 0} active
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2 px-3">
            {workbench.isLoading ? (
              [1, 2, 3, 4].map((item) => (
                <Skeleton key={item} className="h-20 w-full" />
              ))
            ) : data?.support.items.length ? (
              data.support.items.slice(0, 5).map((ticket) => (
                <Link
                  key={ticket.id}
                  href={`/dashboard/support/${ticket.id}`}
                  className="group block rounded-xl border p-3 transition-colors hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {ticket.overdue ? (
                          <Badge variant="warning">Over 24h</Badge>
                        ) : null}
                        <Badge variant="secondary">
                          {ticket.channel === "PLATFORM"
                            ? "Platform"
                            : ticket.channel === "PUBLISHER"
                              ? "Publisher"
                              : "General"}
                        </Badge>
                      </div>
                      <p className="mt-2 truncate text-sm font-semibold">
                        {ticket.subject}
                      </p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {ticket.replyMode === "INTERNAL_ONLY"
                          ? "Internal notes only"
                          : "Public reply available"}
                        {ticket.order?.title ? ` · ${ticket.order.title}` : ""}
                      </p>
                    </div>
                    <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Updated{" "}
                    {formatDistanceToNow(new Date(ticket.updatedAt), {
                      addSuffix: true,
                    })}
                  </p>
                </Link>
              ))
            ) : (
              <div className="rounded-xl border border-dashed px-4 py-10 text-center">
                <HeadphonesIcon className="mx-auto h-8 w-8 text-muted-foreground/60" />
                <p className="mt-3 text-sm font-medium">No active tickets</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  New Finance-visible support will appear here.
                </p>
              </div>
            )}
            <Button variant="outline" className="mt-3 w-full" asChild>
              <Link href="/dashboard/support">
                Open Support
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="rounded-2xl shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <BadgeDollarSign className="h-5 w-5" /> Money movement pipeline
            </CardTitle>
            <CardDescription>
              Active amounts only. Historical completed money is excluded from
              these operational stages.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            {workbench.isLoading ? (
              [1, 2, 3].map((item) => (
                <Skeleton key={item} className="h-48 w-full" />
              ))
            ) : (
              <>
                <PipelineColumn
                  title="Settlements"
                  kind="settlements"
                  rows={data?.pipeline.settlements ?? []}
                  href="/dashboard/finance?tab=settlements"
                />
                <PipelineColumn
                  title="Withdrawals"
                  kind="withdrawals"
                  rows={data?.pipeline.withdrawals ?? []}
                  href="/dashboard/finance?tab=withdrawals"
                />
                <PipelineColumn
                  title="Payout executions"
                  kind="payouts"
                  rows={data?.pipeline.payouts ?? []}
                  href="/dashboard/finance?tab=payouts"
                />
              </>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-sm">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <ShieldCheck className="h-5 w-5" /> Financial health
                </CardTitle>
                <CardDescription>
                  Integrity and publisher exposure.
                </CardDescription>
              </div>
              {recon?.available ? (
                <Badge variant={recon.ok ? "success" : "destructive"}>
                  {recon.ok ? "Reconciled" : `${recon.totalIssues} issues`}
                </Badge>
              ) : (
                <Badge variant="secondary">Check unavailable</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {workbench.isLoading ? (
              [1, 2, 3].map((item) => (
                <Skeleton key={item} className="h-16 w-full" />
              ))
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border bg-muted/15 p-3">
                    <p className="text-xs text-muted-foreground">Critical</p>
                    <p className="mt-1 text-xl font-bold tabular-nums">
                      {recon?.critical ?? 0}
                    </p>
                  </div>
                  <div className="rounded-xl border bg-muted/15 p-3">
                    <p className="text-xs text-muted-foreground">Warnings</p>
                    <p className="mt-1 text-xl font-bold tabular-nums">
                      {recon?.warning ?? 0}
                    </p>
                  </div>
                </div>
                <div className="rounded-xl border bg-muted/15 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-muted-foreground">
                      Publishers with debt
                    </span>
                    <span className="font-semibold tabular-nums">
                      {data?.publisherRisk.publishersWithDebt ?? 0}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-sm text-muted-foreground">
                      Total debt
                    </span>
                    <span className="font-semibold tabular-nums">
                      {formatMoney(data?.publisherRisk.totalDebt)}
                    </span>
                  </div>
                </div>
                <Button variant="outline" className="w-full" asChild>
                  <Link href="/dashboard/finance?tab=reconciliation">
                    Open reconciliation
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <CreditCard className="h-5 w-5" /> Revenue snapshot
              </CardTitle>
              <CardDescription>
                Current 30-day platform-revenue window.
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/dashboard/finance?tab=revenue">Revenue detail</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {workbench.isLoading ? (
              <div className="grid grid-cols-3 gap-3">
                {[1, 2, 3].map((item) => (
                  <Skeleton key={item} className="h-24 w-full" />
                ))}
              </div>
            ) : revenue?.available && revenue.current ? (
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  ["Gross", revenue.current.grossAmount],
                  ["Platform fees", revenue.current.platformFee],
                  ["Net revenue", revenue.current.netRevenue],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-xl border bg-muted/15 p-4"
                  >
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="mt-1 text-lg font-bold tabular-nums">
                      {formatMoney(value)}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
                Revenue summary is temporarily unavailable. The other Finance
                queues remain current.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Activity className="h-5 w-5" /> Recent Finance activity
            </CardTitle>
            <CardDescription>
              Sanitized financial events only—not global audit-log access.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {workbench.isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4].map((item) => (
                  <Skeleton key={item} className="h-14 w-full" />
                ))}
              </div>
            ) : data?.recentActivity.length ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {data.recentActivity.slice(0, 6).map((item) => (
                  <Link
                    key={item.id}
                    href={item.href}
                    className="flex items-start gap-3 rounded-xl border bg-muted/15 p-3 transition-colors hover:bg-muted/40"
                  >
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Activity className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium capitalize">
                        <ActivityLabel action={item.action} />
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {item.actorName} · {item.entity}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {formatDistanceToNow(new Date(item.createdAt), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                <CircleDollarSign className="h-4 w-4" />
                No recent financial activity.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminPage>
  )
}
