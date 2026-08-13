"use client"

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
  downloadCsv,
  Input,
  Label,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  CreditCard,
  DollarSign,
  Eye,
  RefreshCw,
  Scale,
  ShieldAlert,
  Users,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"
import { toast } from "sonner"
import { AdminPage, AdminPageHeader } from "../../../components/admin-workspace"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { ForbiddenPage, useRequireRole } from "../../../lib/use-require-role"
import { RevenuePanel } from "./_revenue-panel"

const TABS = [
  "settlements",
  "withdrawals",
  "payouts",
  "reconciliation",
  "revenue",
] as const
type Tab = (typeof TABS)[number]

const PAGE_SIZE = 20
const RECOVERABLE_PAYOUT_CLAIM_STAGES = new Set([
  "PROVIDER_SEND_CLAIMED",
  "BANK_PAYOUT_SEND_CLAIMED",
  "BANK_PAYOUT_RESUME_CLAIMED",
])
const EXPIRED_PAYOUT_CLAIM_STAGES = new Set([
  "PROVIDER_SEND_CLAIM_EXPIRED",
  "BANK_PAYOUT_CLAIM_EXPIRED",
])
const CANCELLATION_RECOVERY_LEASE_MS = 15 * 60 * 1000

function canResumeCancellation(execution: {
  stage: string
  errorMessage: string | null
  updatedAt: string
}) {
  if (execution.stage !== "CANCEL_REQUESTED") return false
  if (execution.errorMessage) return true
  const updatedAt = Date.parse(execution.updatedAt)
  return (
    Number.isFinite(updatedAt) &&
    Date.now() - updatedAt >= CANCELLATION_RECOVERY_LEASE_MS
  )
}

function payoutProviderFor(withdrawal: {
  method?: string
  payoutMethod?: { type?: string } | null
}) {
  const method = withdrawal.method ?? withdrawal.payoutMethod?.type
  if (method === "bank_transfer") return "manual"
  if (method === "wise") return "wise"
  if (method === "stripe_connect") return "stripe_connect"
  return null
}

function payoutProviderLabel(provider: string | null) {
  if (provider === "stripe_connect") return "Stripe Connect"
  if (provider === "wise") return "Wise"
  if (provider === "manual") return "Manual bank"
  return "Unavailable"
}

function localDateTimeValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "PENDING"
      ? "warning"
      : status === "UNDER_REVIEW"
        ? "secondary"
        : status === "APPROVED"
          ? "info"
          : status === "PROCESSING"
            ? "secondary"
            : status === "COMPLETED" || status === "PAID"
              ? "success"
              : "destructive"
  return <Badge variant={variant as any}>{status}</Badge>
}

function LoadingRows() {
  return (
    <div className="p-6 space-y-3">
      {[...Array(5)].map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  )
}

function ErrorBlock({
  label,
  onRetry,
}: {
  label: string
  onRetry: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <AlertCircle className="h-10 w-10 text-destructive" />
      <p className="text-muted-foreground">{label}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="mr-2 h-3 w-3" /> Retry
      </Button>
    </div>
  )
}

function EmptyBlock({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <DollarSign className="h-10 w-10 text-muted-foreground" />
      <p className="text-muted-foreground">{label}</p>
    </div>
  )
}

function PaginationBar({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
}: {
  page: number
  totalPages: number
  total: number
  pageSize: number
  onPageChange: (p: number) => void
}) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 border-t">
      <span className="text-sm text-muted-foreground">
        Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)}{" "}
        of {total}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </Button>
        <span className="text-sm text-muted-foreground min-w-[80px] text-center">
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

const MODULE_DEFS = [
  {
    key: "walletDrift",
    label: "Wallet Drift",
    description: "Compares cached customer wallet balances with ledger totals.",
    icon: DollarSign,
  },
  {
    key: "publisherDrift",
    label: "Publisher Balance Drift",
    description: "Compares publisher balances with settlement ledger credits.",
    icon: Users,
  },
  {
    key: "settlementDrift",
    label: "Settlement and Revenue Integrity",
    description:
      "Validates publisher settlements and platform revenue by fulfillment route.",
    icon: Scale,
  },
  {
    key: "orderPaymentRecon",
    label: "Order Payment Reconciliation",
    description: "Matches paid orders to wallet purchase transactions.",
    icon: CreditCard,
  },
  {
    key: "refundRecon",
    label: "Refund Reconciliation",
    description: "Matches refund states, ledger entries, and money reversals.",
    icon: RefreshCw,
  },
  {
    key: "stuckFinancialOrders",
    label: "Stuck Financial Orders",
    description:
      "Finds paid or delivered orders missing their next money record.",
    icon: AlertCircle,
  },
  {
    key: "stuckPayouts",
    label: "Stuck Payouts",
    description: "Finds stale, orphaned, or duplicate payout executions.",
    icon: XCircle,
  },
] as const

const SETTLEMENT_GROUPS = [
  { key: "amount", label: "Amount Integrity" },
  { key: "sync", label: "Ledger Synchronisation" },
  { key: "completeness", label: "Completeness" },
] as const

function SeverityDot({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        severity === "critical"
          ? "bg-red-500"
          : severity === "warning"
            ? "bg-amber-500"
            : "bg-blue-500"
      }`}
    />
  )
}

function ModuleCard({
  label,
  description,
  icon: Icon,
  counts,
  onClick,
}: {
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  counts: { critical: number; warning: number; info: number }
  onClick: () => void
}) {
  const total = counts.critical + counts.warning + counts.info
  const topSeverity =
    total === 0 ? "ok" : counts.critical > 0 ? "critical" : "warning"
  const borderColor =
    topSeverity === "ok"
      ? "border-emerald-500/30"
      : topSeverity === "critical"
        ? "border-red-500/30"
        : "border-amber-500/30"

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col gap-2 rounded-lg border ${borderColor} bg-surface-1 p-4 text-left transition-all duration-200 hover:bg-card/80`}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{label}</span>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      {total === 0 ? (
        <span className="text-xs text-emerald-500">All clear</span>
      ) : (
        <div className="flex flex-wrap gap-2">
          {counts.critical > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-red-500">
              <SeverityDot severity="critical" />
              {counts.critical} critical
            </span>
          )}
          {counts.warning > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-500">
              <SeverityDot severity="warning" />
              {counts.warning} warning
            </span>
          )}
          {counts.info > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-blue-500">
              {counts.info} info
            </span>
          )}
        </div>
      )}
    </button>
  )
}

function ReconciliationDashboard({
  recon,
  isLoading,
  isFetching,
  error,
  onRefresh,
}: {
  recon: any
  isLoading: boolean
  isFetching: boolean
  error: Error | null
  onRefresh: () => void
}) {
  const [detailModule, setDetailModule] = useState<string | null>(null)
  const [detailGroup, setDetailGroup] = useState<string | null>(null)
  const [settlementExpanded, setSettlementExpanded] = useState(false)

  if (isLoading) return <LoadingRows />
  if (error)
    return (
      <ErrorBlock label="Reconciliation failed to run" onRetry={onRefresh} />
    )
  if (!recon) return null

  const moduleCounts = MODULE_DEFS.map((def) => {
    const rows: any[] = recon[def.key] ?? []
    return {
      key: def.key,
      critical: rows.filter((r: any) => r.severity === "critical").length,
      warning: rows.filter((r: any) => r.severity === "warning").length,
      info: rows.filter((r: any) => r.severity === "info").length,
    }
  })

  const hasIssues = moduleCounts.some(
    (m) => m.critical + m.warning + m.info > 0,
  )

  const detailRows: any[] = detailModule
    ? (recon[detailModule] ?? []).filter(
        (r: any) =>
          !detailGroup ||
          detailModule !== "settlementDrift" ||
          r.group === detailGroup,
      )
    : []

  return (
    <div className="space-y-6">
      <Card className="border-blue-500/20 bg-blue-500/5">
        <CardHeader>
          <CardTitle className="text-base">How reconciliation works</CardTitle>
          <CardDescription className="leading-6">
            This is a read-only integrity scan. It recomputes balances from
            immutable ledger records, matches payments and refunds to orders,
            and checks the final financial record by route: publisher orders
            require one active settlement, while platform-handled orders require
            unreversed platform revenue whose gross equals both the order value
            and the fee plus net-revenue split. A finding never changes money
            automatically; staff must inspect the linked entity and use an
            approved correction workflow.
          </CardDescription>
        </CardHeader>
      </Card>
      {/* ── Status bar ── */}
      <Card className="border-border/50">
        <CardContent className="flex items-center justify-between p-4">
          <div className="flex items-center gap-4">
            {hasIssues ? (
              <ShieldAlert className="h-8 w-8 shrink-0 text-red-500" />
            ) : (
              <CheckCircle2 className="h-8 w-8 shrink-0 text-emerald-500" />
            )}
            <div>
              <p
                className={`text-sm font-semibold ${
                  hasIssues ? "text-red-500" : "text-emerald-500"
                }`}
              >
                {hasIssues
                  ? "Issues detected — review before processing payouts"
                  : "All checks passed"}
              </p>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {hasIssues && (
                  <>
                    {moduleCounts.reduce((s, m) => s + m.critical, 0) > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <SeverityDot severity="critical" />
                        {moduleCounts.reduce((s, m) => s + m.critical, 0)}{" "}
                        critical
                      </span>
                    )}
                    {moduleCounts.reduce((s, m) => s + m.warning, 0) > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <SeverityDot severity="warning" />
                        {moduleCounts.reduce((s, m) => s + m.warning, 0)}{" "}
                        warning
                      </span>
                    )}
                    {moduleCounts.reduce((s, m) => s + m.info, 0) > 0 && (
                      <span className="inline-flex items-center gap-1">
                        {moduleCounts.reduce((s, m) => s + m.info, 0)} info
                      </span>
                    )}
                    <span className="text-border/50">|</span>
                  </>
                )}
                <span>v{recon.version}</span>
                <span className="text-border/50">|</span>
                <span>{recon.scanDurationMs}ms</span>
                <span className="text-border/50">|</span>
                <span>
                  Ran {format(new Date(recon.ranAt), "MMM d, yyyy h:mm a")}
                </span>
              </div>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isFetching}
          >
            <RefreshCw
              className={`mr-2 h-3 w-3 ${isFetching ? "animate-spin" : ""}`}
            />
            {isFetching ? "Running..." : "Run Now"}
          </Button>
        </CardContent>
      </Card>

      {/* ── Stats chips ── */}
      <div className="flex flex-wrap gap-3">
        {[
          { label: "Wallets", value: recon.stats?.checkedWallets },
          { label: "Settlements", value: recon.stats?.checkedSettlements },
          { label: "Orders", value: recon.stats?.checkedOrders },
          { label: "Transactions", value: recon.stats?.checkedTransactions },
          { label: "Publishers", value: recon.stats?.checkedPublishers },
        ].map(
          (s) =>
            s.value !== undefined && (
              <Badge key={s.label} variant="secondary" className="text-xs">
                {s.label}: {s.value}
              </Badge>
            ),
        )}
      </div>

      {/* ── Module cards grid ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {MODULE_DEFS.map((def, i) => {
          const counts = moduleCounts[i]
          return (
            <ModuleCard
              key={def.key}
              label={def.label}
              description={def.description}
              icon={def.icon}
              counts={counts}
              onClick={() => {
                setDetailModule(def.key)
                setDetailGroup(null)
                if (def.key === "settlementDrift") setSettlementExpanded(true)
              }}
            />
          )
        })}
      </div>

      {/* ── Settlement Integrity sub-groups ── */}
      {settlementExpanded && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">
            Settlement Integrity Groups
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {SETTLEMENT_GROUPS.map((g) => {
              const groupRows: any[] =
                recon.settlementDrift?.filter((r: any) => r.group === g.key) ??
                []
              const c = {
                critical: groupRows.filter(
                  (r: any) => r.severity === "critical",
                ).length,
                warning: groupRows.filter((r: any) => r.severity === "warning")
                  .length,
                info: groupRows.filter((r: any) => r.severity === "info")
                  .length,
              }
              return (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => {
                    setDetailModule("settlementDrift")
                    setDetailGroup(g.key)
                  }}
                  className="flex items-center justify-between rounded-lg border border-border/50 bg-surface-1 p-3 text-left transition-all duration-200 hover:bg-card/80"
                >
                  <span className="text-sm">{g.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.critical + c.warning + c.info === 0
                      ? "OK"
                      : `${c.critical + c.warning + c.info} issue${c.critical + c.warning + c.info !== 1 ? "s" : ""}`}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Detail dialog ── */}
      <Dialog
        open={!!detailModule}
        onOpenChange={(open) => {
          if (!open) {
            setDetailModule(null)
            setDetailGroup(null)
          }
        }}
      >
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {MODULE_DEFS.find((d) => d.key === detailModule)?.label ??
                "Details"}
              {detailGroup && detailModule === "settlementDrift" && (
                <Badge variant="secondary" className="ml-2 text-xs">
                  {SETTLEMENT_GROUPS.find((g) => g.key === detailGroup)
                    ?.label ?? detailGroup}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {detailRows.length} issue
              {detailRows.length !== 1 ? "s" : ""} found
            </DialogDescription>
          </DialogHeader>
          {detailRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No issues
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Entity</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Expected</TableHead>
                    <TableHead>Actual</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detailRows.map((row: any, i: number) => (
                    <TableRow key={row.id ?? `drift-${detailModule}-${i}`}>
                      <TableCell>
                        <SeverityDot severity={row.severity} />
                      </TableCell>
                      <TableCell className="font-mono text-xs max-w-[120px] truncate">
                        {row.entityId?.slice(0, 12)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className="font-mono text-[10px]"
                        >
                          {row.code}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular-nums text-xs">
                        {row.amount ?? "-"}
                      </TableCell>
                      <TableCell className="tabular-nums text-xs">
                        {row.metadata?.expectedAmount ??
                          row.metadata?.expectedStatus ??
                          "-"}
                      </TableCell>
                      <TableCell className="tabular-nums text-xs">
                        {row.metadata?.actualAmount ??
                          row.metadata?.actualStatus ??
                          "-"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-md">
                        <p>{row.message}</p>
                        <p className="mt-1 text-[10px]">
                          Detected{" "}
                          {row.detectedAt
                            ? format(new Date(row.detectedAt), "PPpp")
                            : "time unavailable"}
                        </p>
                      </TableCell>
                      <TableCell>
                        {row.action?.type === "order" ? (
                          <Button variant="outline" size="sm" asChild>
                            <Link href={`/dashboard/orders/${row.action.id}`}>
                              Inspect
                              <ArrowRight className="ml-1 h-3 w-3" />
                            </Link>
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Review {row.entityType}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TabNav({
  tabs,
  active,
  onChange,
  badges,
}: {
  tabs: readonly Tab[]
  active: Tab
  onChange: (tab: Tab) => void
  badges?: Partial<Record<Tab, number>>
}) {
  return (
    <div className="flex gap-6 overflow-x-auto border-b">
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab}
          onClick={() => onChange(tab)}
          className={`relative pb-2.5 text-sm font-medium capitalize transition-colors ${
            active === tab
              ? "text-foreground after:absolute after:bottom-0 after:left-0 after:h-0.5 after:w-full after:bg-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {tab === "payouts" ? "Payouts" : tab}
          {badges?.[tab] !== undefined && badges[tab]! > 0 && (
            <Badge
              variant="secondary"
              className="ml-1.5 px-1.5 py-0 text-[10px]"
            >
              {badges[tab]}
            </Badge>
          )}
        </button>
      ))}
    </div>
  )
}

export default function FinancePage() {
  const { allowed, loading } = useRequireRole("SUPER_ADMIN", "FINANCE")
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Finance or Super Admin" />
  return (
    <Suspense fallback={<Skeleton className="h-72 w-full" />}>
      <FinancePageInner />
    </Suspense>
  )
}

function FinancePageInner() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedTab = searchParams.get("tab")
  const activeTab: Tab = TABS.includes(requestedTab as Tab)
    ? (requestedTab as Tab)
    : "settlements"
  const [settlementPage, setSettlementPage] = useState(1)
  const [withdrawalPage, setWithdrawalPage] = useState(1)
  const [payoutPage, setPayoutPage] = useState(1)
  const queryClient = useQueryClient()

  const setActiveTab = (tab: Tab) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set("tab", tab)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }

  const workbenchQ = useQuery({
    queryKey: ["admin", "finance-workbench"],
    queryFn: () => api.admin.getFinanceWorkbench(),
    staleTime: 30_000,
    retry: 1,
  })

  const settlementsQ = useQuery({
    queryKey: ["settlements", settlementPage],
    queryFn: () =>
      api.admin.listSettlements(PAGE_SIZE, (settlementPage - 1) * PAGE_SIZE),
  })
  const withdrawalsQ = useQuery({
    queryKey: ["withdrawals", withdrawalPage],
    queryFn: () =>
      api.admin.listWithdrawals(PAGE_SIZE, (withdrawalPage - 1) * PAGE_SIZE),
  })
  const payoutsQ = useQuery({
    queryKey: ["withdrawals", "payouts", payoutPage],
    queryFn: () =>
      api.admin.listWithdrawals(PAGE_SIZE, (payoutPage - 1) * PAGE_SIZE, [
        "APPROVED",
        "PROCESSING",
        "FAILED",
      ]),
    enabled: activeTab === "payouts",
  })
  const reconciliationQ = useQuery({
    queryKey: ["reconciliation"],
    queryFn: () => api.admin.getReconciliation(),
    enabled: activeTab === "reconciliation",
  })

  const invalidateWithdrawals = () =>
    queryClient.invalidateQueries({ queryKey: ["withdrawals"] })

  const { user } = useAuth()
  const isSuperAdmin = user?.staffRole === "SUPER_ADMIN"

  const [approveTarget, setApproveTarget] = useState<string | null>(null)
  const [approveReason, setApproveReason] = useState("")
  const [forceApproval, setForceApproval] = useState(false)
  const [withdrawalRejectTarget, setWithdrawalRejectTarget] = useState<
    string | null
  >(null)
  const [withdrawalDecisionMode, setWithdrawalDecisionMode] = useState<
    "reject" | "abandon"
  >("reject")
  const [withdrawalRejectReason, setWithdrawalRejectReason] = useState("")
  const [withdrawalApprovalTarget, setWithdrawalApprovalTarget] = useState<{
    id: string
    amountLabel: string
    publicReference: string
    publisherLabel: string
  } | null>(null)

  const settlementEligibilityQ = useQuery({
    queryKey: ["settlement-eligibility", approveTarget],
    queryFn: () => api.admin.getSettlementEligibility(approveTarget!),
    enabled: approveTarget !== null,
  })

  const approveSettlement = useMutation({
    mutationFn: ({
      id,
      reason,
      force,
    }: {
      id: string
      reason: string
      force: boolean
    }) =>
      force
        ? api.admin.forceApproveSettlement(id, reason)
        : api.admin.approveSettlement(id, reason),
    onSuccess: (_data, variables) => {
      toast.success(
        forceApproval
          ? "Customer approval recorded by Super Admin"
          : "Settlement approved and released",
      )
      setApproveTarget(null)
      setApproveReason("")
      setForceApproval(false)
      queryClient.invalidateQueries({ queryKey: ["settlements"] })
      queryClient.invalidateQueries({
        queryKey: ["settlement-eligibility", variables.id],
      })
    },
    onError: (e: any) =>
      toast.error(e?.message ?? "Failed to approve settlement"),
  })

  const approveWithdrawal = useMutation({
    mutationFn: (id: string) => api.admin.approveWithdrawal(id),
    onSuccess: () => {
      toast.success("Withdrawal approved")
      setWithdrawalApprovalTarget(null)
      invalidateWithdrawals()
    },
    onError: (e: any) =>
      toast.error(e?.message ?? "Failed to approve withdrawal"),
  })

  const rejectWithdrawal = useMutation({
    mutationFn: ({
      id,
      reason,
      mode,
    }: {
      id: string
      reason: string
      mode: "reject" | "abandon"
    }) =>
      mode === "abandon"
        ? api.admin.abandonApprovedWithdrawal(id, reason)
        : api.admin.rejectWithdrawal(id, reason),
    onSuccess: (_data, variables) => {
      toast.success(
        variables.mode === "abandon"
          ? "Approved withdrawal safely abandoned"
          : "Withdrawal rejected",
      )
      setWithdrawalRejectTarget(null)
      setWithdrawalRejectReason("")
      invalidateWithdrawals()
    },
    onError: (e: any) =>
      toast.error(e?.message ?? "Failed to reject withdrawal"),
  })

  const [payoutExecutionTarget, setPayoutExecutionTarget] = useState<{
    id: string
    provider: string
    providerLabel: string
    amountLabel: string
    publicReference: string
    payoutMethodLabel: string
    confirmationToken: string
  } | null>(null)
  const [payoutExecutionReason, setPayoutExecutionReason] = useState("")
  const [payoutExecutionConfirmation, setPayoutExecutionConfirmation] =
    useState("")
  const executePayout = useMutation({
    mutationFn: ({
      id,
      provider,
      reason,
    }: {
      id: string
      provider: string
      reason: string
    }) => api.admin.executePayout(id, provider, reason),
    onSuccess: () => {
      toast.success("Payout execution started")
      setPayoutExecutionTarget(null)
      setPayoutExecutionReason("")
      setPayoutExecutionConfirmation("")
      invalidateWithdrawals()
    },
    onError: (e: any) => toast.error(e?.message ?? "Payout execution failed"),
  })

  // Executions drill-down
  const [executionsFor, setExecutionsFor] = useState<string | null>(null)
  const [manualCompletionTarget, setManualCompletionTarget] = useState<{
    withdrawalId: string
    withdrawalPublicReference: string
    publisherId: string
    publisherLabel: string
    amountLabel: string
    executionId: string
    executionCreatedAt: string
  } | null>(null)
  const [manualBankReference, setManualBankReference] = useState("")
  const [manualPaidAt, setManualPaidAt] = useState("")
  const [manualCompletionReason, setManualCompletionReason] = useState("")
  const [manualCompletionConfirmation, setManualCompletionConfirmation] =
    useState("")
  const resetManualCompletion = () => {
    setManualCompletionTarget(null)
    setManualBankReference("")
    setManualPaidAt("")
    setManualCompletionReason("")
    setManualCompletionConfirmation("")
  }
  const [executionActionTarget, setExecutionActionTarget] = useState<{
    action: "retry" | "cancel"
    id: string
    label: string
    providerLabel: string
    amountLabel: string
    stage: string
    evidence: string
    confirmationToken: "RETRY" | "CANCEL"
  } | null>(null)
  const [executionActionReason, setExecutionActionReason] = useState("")
  const [executionActionConfirmation, setExecutionActionConfirmation] =
    useState("")
  const executionsQ = useQuery({
    queryKey: ["executions", executionsFor],
    queryFn: () => api.admin.getWithdrawalExecutions(executionsFor!),
    enabled: !!executionsFor,
  })
  const retryExecution = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.admin.retryPayoutExecution(id, reason),
    onSuccess: () => {
      toast.success("Retry started")
      setExecutionActionTarget(null)
      setExecutionActionReason("")
      setExecutionActionConfirmation("")
      queryClient.invalidateQueries({ queryKey: ["executions"] })
      invalidateWithdrawals()
    },
    onError: (e: any) => toast.error(e?.message ?? "Retry failed"),
  })
  const cancelExecution = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.admin.cancelPayoutExecution(id, reason),
    onSuccess: () => {
      toast.success("Cancellation command completed")
      setExecutionActionTarget(null)
      setExecutionActionReason("")
      setExecutionActionConfirmation("")
      queryClient.invalidateQueries({ queryKey: ["executions"] })
      invalidateWithdrawals()
    },
    onError: (e: any) =>
      toast.error(e?.message ?? "Cancellation recovery failed"),
  })
  const completeManualWithdrawal = useMutation({
    mutationFn: () => {
      if (!manualCompletionTarget) {
        throw new Error("Manual payout execution is required")
      }
      if (
        manualCompletionConfirmation !==
        manualCompletionTarget.withdrawalPublicReference
      ) {
        throw new Error("Exact withdrawal reference confirmation is required")
      }
      const parsedPaidAt = new Date(manualPaidAt)
      if (!Number.isFinite(parsedPaidAt.getTime())) {
        throw new Error("A valid payment timestamp is required")
      }
      return api.admin.completeManualWithdrawal(
        manualCompletionTarget.withdrawalId,
        {
          withdrawalPublicReference:
            manualCompletionTarget.withdrawalPublicReference,
          executionId: manualCompletionTarget.executionId,
          bankReference: manualBankReference.trim(),
          paidAt: parsedPaidAt.toISOString(),
          reason: manualCompletionReason.trim(),
        },
      )
    },
    onSuccess: () => {
      toast.success("Manual bank payment evidence recorded")
      resetManualCompletion()
      queryClient.invalidateQueries({ queryKey: ["executions"] })
      invalidateWithdrawals()
    },
    onError: (e: any) =>
      toast.error(e?.message ?? "Manual payment completion failed"),
  })

  // Decrypt dialog
  const [decryptTarget, setDecryptTarget] = useState<string | null>(null)
  const [decryptReason, setDecryptReason] = useState("")
  const [decrypted, setDecrypted] = useState<Record<string, unknown> | null>(
    null,
  )
  const decryptMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.admin.decryptPayoutMethod(id, reason),
    onSuccess: (data) => setDecrypted(data.details),
    onError: (e: any) =>
      toast.error(
        e?.message ??
          "Decrypt denied — requires FINANCIAL_DATA_DECRYPT permission",
      ),
  })
  const closeDecrypt = () => {
    setDecryptTarget(null)
    setDecryptReason("")
    setDecrypted(null)
  }

  const settlements = settlementsQ.data?.items ?? []
  const settlementTotal = settlementsQ.data?.total ?? 0
  const settlementPages = Math.max(1, Math.ceil(settlementTotal / PAGE_SIZE))

  const withdrawals = withdrawalsQ.data?.items ?? []
  const withdrawalTotal = withdrawalsQ.data?.total ?? 0
  const withdrawalPages = Math.max(1, Math.ceil(withdrawalTotal / PAGE_SIZE))

  const payable = payoutsQ.data?.items ?? []
  const payoutTotal = payoutsQ.data?.total ?? 0
  const payoutPages = Math.max(1, Math.ceil(payoutTotal / PAGE_SIZE))
  const recon = reconciliationQ.data
  const exactPayoutWork =
    workbenchQ.data?.pipeline.withdrawals
      .filter((row) =>
        ["APPROVED", "PROCESSING", "FAILED"].includes(row.status),
      )
      .reduce((total, row) => total + row.count, 0) ?? 0

  return (
    <AdminPage>
      <AdminPageHeader
        title="Finance center"
        description="Review evidence, approve eligible funds, execute payouts, and investigate financial integrity."
        eyebrow="Financial operations"
        icon={DollarSign}
        actions={
          <Button variant="outline" asChild>
            <Link href="/dashboard">
              Finance workbench
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        }
      />

      <TabNav
        tabs={TABS}
        active={activeTab}
        onChange={setActiveTab}
        badges={{
          settlements: workbenchQ.data?.decisions.settlementsReady,
          withdrawals: workbenchQ.data?.decisions.withdrawalsEligible,
          payouts: exactPayoutWork,
          reconciliation: workbenchQ.data?.reconciliation.totalIssues,
        }}
      />

      {activeTab === "settlements" && (
        <Card>
          <div className="flex justify-end border-b px-4 py-2">
            <Button
              variant="outline"
              size="sm"
              disabled={settlements.length === 0}
              onClick={() =>
                downloadCsv(
                  `settlements-${new Date().toISOString().slice(0, 10)}.csv`,
                  [
                    "id",
                    "orderId",
                    "publisher",
                    "grossAmount",
                    "releasePolicy",
                    "status",
                    "createdAt",
                  ],
                  settlements.map((s: any) => [
                    s.id,
                    s.orderId,
                    s.publisher?.name ?? s.publisherId,
                    Number(s.grossAmount ?? s.amount ?? 0).toFixed(2),
                    s.releasePolicy ?? "",
                    s.status,
                    s.createdAt,
                  ]),
                )
              }
            >
              Export CSV
            </Button>
          </div>
          <CardContent className="p-0">
            {settlementsQ.isLoading ? (
              <LoadingRows />
            ) : settlementsQ.error ? (
              <ErrorBlock
                label="Failed to load settlements"
                onRetry={() => settlementsQ.refetch()}
              />
            ) : settlements.length === 0 ? (
              <EmptyBlock label="No settlements found" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Publisher</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Release</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Review Window</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {settlements.map((s: any) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">
                        {s.orderId?.slice(0, 8)}
                      </TableCell>
                      <TableCell>
                        {s.publisher?.name || s.publisher?.email || "—"}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        ${Number(s.grossAmount || s.amount || 0).toFixed(2)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            s.releasePolicy === "AUTO" ? "success" : "warning"
                          }
                        >
                          {s.releasePolicy ?? "—"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={s.status} />
                      </TableCell>
                      <TableCell className="text-sm">
                        {s.reviewEndsAt &&
                        ["PENDING", "UNDER_REVIEW"].includes(s.status) ? (
                          <span className="tabular-nums">
                            {(() => {
                              const remaining = Math.ceil(
                                (new Date(s.reviewEndsAt).getTime() -
                                  Date.now()) /
                                  (1000 * 60 * 60 * 24),
                              )
                              if (remaining <= 0)
                                return (
                                  <span className="text-amber-600">
                                    Due now
                                  </span>
                                )
                              if (remaining === 1)
                                return (
                                  <span className="text-amber-600">1 day</span>
                                )
                              return `${remaining} days`
                            })()}
                          </span>
                        ) : s.reviewEndsAt ? (
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(s.reviewEndsAt), "MMM d")}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {s.createdAt
                          ? format(new Date(s.createdAt), "MMM d, yyyy")
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {(s.status === "CUSTOMER_APPROVED" ||
                          (isSuperAdmin &&
                            (s.status === "PENDING" ||
                              s.status === "UNDER_REVIEW"))) && (
                          <Button
                            size="sm"
                            onClick={() => {
                              setApproveTarget(s.id)
                              setApproveReason("")
                              setForceApproval(s.status !== "CUSTOMER_APPROVED")
                            }}
                          >
                            {s.status === "CUSTOMER_APPROVED"
                              ? "Approve"
                              : "Force customer approval"}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
          <PaginationBar
            page={settlementPage}
            totalPages={settlementPages}
            total={settlementTotal}
            pageSize={PAGE_SIZE}
            onPageChange={setSettlementPage}
          />
        </Card>
      )}

      {activeTab === "withdrawals" && (
        <Card>
          <div className="flex justify-end border-b px-4 py-2">
            <Button
              variant="outline"
              size="sm"
              disabled={withdrawals.length === 0}
              onClick={() =>
                downloadCsv(
                  `withdrawals-${new Date().toISOString().slice(0, 10)}.csv`,
                  ["id", "publisher", "amount", "status", "createdAt"],
                  withdrawals.map((w: any) => [
                    w.id,
                    w.publisher?.name ?? w.publisherId,
                    Number(w.amount ?? 0).toFixed(2),
                    w.status,
                    w.createdAt,
                  ]),
                )
              }
            >
              Export CSV
            </Button>
          </div>
          <CardContent className="p-0">
            {withdrawalsQ.isLoading ? (
              <LoadingRows />
            ) : withdrawalsQ.error ? (
              <ErrorBlock
                label="Failed to load withdrawals"
                onRetry={() => withdrawalsQ.refetch()}
              />
            ) : withdrawals.length === 0 ? (
              <EmptyBlock label="No withdrawals found" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Publisher</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Hold</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {withdrawals.map((w: any) => {
                    const isOnHold =
                      w.availableAt && new Date(w.availableAt) > new Date()
                    return (
                      <TableRow key={w.id}>
                        <TableCell>
                          {w.publisher?.name || w.publisher?.email || "—"}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          <div>
                            ${Number(w.netAmount ?? w.amount ?? 0).toFixed(2)}{" "}
                            net
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {w.publicReference ?? "legacy"} · fee $
                            {Number(w.payoutFee ?? 0).toFixed(2)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={w.status} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          <span className="flex items-center gap-2">
                            {w.payoutMethod?.label ?? "—"}
                            {w.payoutMethod?.id && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-1"
                                title="View banking details (audited)"
                                onClick={() =>
                                  setDecryptTarget(w.payoutMethod.id)
                                }
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>
                          {w.availableAt ? (
                            <span
                              className={`inline-flex items-center gap-1 text-xs whitespace-nowrap ${
                                isOnHold
                                  ? "text-amber-600 dark:text-amber-400"
                                  : "text-muted-foreground"
                              }`}
                            >
                              <Clock className="h-3 w-3" />
                              {w.publisher?.tier ?? "TRUSTED"} tier
                              {isOnHold ? (
                                <>
                                  {" "}
                                  until{" "}
                                  {format(
                                    new Date(w.availableAt),
                                    "MMM d, h:mm a",
                                  )}
                                </>
                              ) : (
                                <> expired</>
                              )}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {w.createdAt
                            ? format(new Date(w.createdAt), "MMM d, yyyy")
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {w.status === "PENDING" && (
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                onClick={() =>
                                  setWithdrawalApprovalTarget({
                                    id: w.id,
                                    amountLabel: `$${Number(
                                      w.netAmount ?? w.amount ?? 0,
                                    ).toFixed(2)} net`,
                                    publicReference: w.publicReference ?? w.id,
                                    publisherLabel:
                                      w.publisher?.name ||
                                      w.publisher?.email ||
                                      w.publisherId,
                                  })
                                }
                                disabled={
                                  approveWithdrawal.isPending || !!isOnHold
                                }
                                title={
                                  isOnHold
                                    ? `Hold until ${format(new Date(w.availableAt), "MMM d, yyyy h:mm a")}`
                                    : "Approve withdrawal"
                                }
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setWithdrawalRejectTarget(w.id)
                                  setWithdrawalDecisionMode("reject")
                                  setWithdrawalRejectReason("")
                                }}
                                disabled={rejectWithdrawal.isPending}
                              >
                                Reject
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
          <PaginationBar
            page={withdrawalPage}
            totalPages={withdrawalPages}
            total={withdrawalTotal}
            pageSize={PAGE_SIZE}
            onPageChange={setWithdrawalPage}
          />
        </Card>
      )}

      {activeTab === "payouts" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Approved Withdrawals — Ready to Pay
            </CardTitle>
            <CardDescription>
              Provider routing comes from the stored payout method. Manual bank
              executions stay Processing until bank evidence is recorded.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {payoutsQ.isLoading ? (
              <LoadingRows />
            ) : payoutsQ.error ? (
              <ErrorBlock
                label="Failed to load payout queue"
                onRetry={() => payoutsQ.refetch()}
              />
            ) : payable.length === 0 ? (
              <EmptyBlock label="No approved withdrawals waiting for payout" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Publisher</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payable.map((w: any) => (
                    <TableRow key={w.id}>
                      <TableCell>
                        {w.publisher?.name || w.publisher?.email || "—"}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        <div>
                          ${Number(w.netAmount ?? w.amount ?? 0).toFixed(2)} net
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {w.publicReference ?? "legacy"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={w.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {w.payoutMethod?.label ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setExecutionsFor(w.id)}
                          >
                            Executions
                          </Button>
                          {w.status === "APPROVED" && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setWithdrawalRejectTarget(w.id)
                                  setWithdrawalDecisionMode("abandon")
                                  setWithdrawalRejectReason("")
                                }}
                                disabled={rejectWithdrawal.isPending}
                                title="Release only if no provider send was ever claimed"
                              >
                                Safely abandon
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => {
                                  const provider = payoutProviderFor(w)
                                  if (!provider) return
                                  const publicReference =
                                    w.publicReference ?? w.id
                                  setPayoutExecutionTarget({
                                    id: w.id,
                                    provider,
                                    providerLabel:
                                      payoutProviderLabel(provider),
                                    amountLabel: `$${Number(
                                      w.netAmount ?? w.amount ?? 0,
                                    ).toFixed(2)} net`,
                                    publicReference,
                                    payoutMethodLabel:
                                      w.payoutMethod?.label ??
                                      "No destination label",
                                    confirmationToken: publicReference,
                                  })
                                  setPayoutExecutionReason("")
                                  setPayoutExecutionConfirmation("")
                                }}
                                disabled={
                                  executePayout.isPending ||
                                  !payoutProviderFor(w)
                                }
                              >
                                Execute (
                                {payoutProviderLabel(payoutProviderFor(w))})
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
          <PaginationBar
            page={payoutPage}
            totalPages={payoutPages}
            total={payoutTotal}
            pageSize={PAGE_SIZE}
            onPageChange={setPayoutPage}
          />
        </Card>
      )}

      {activeTab === "reconciliation" && (
        <ReconciliationDashboard
          recon={recon}
          isLoading={reconciliationQ.isLoading}
          isFetching={reconciliationQ.isFetching}
          error={reconciliationQ.error}
          onRefresh={() => reconciliationQ.refetch()}
        />
      )}

      {activeTab === "revenue" && <RevenuePanel />}

      {/* Executions drill-down */}
      <Dialog
        open={!!executionsFor}
        onOpenChange={(open) => !open && setExecutionsFor(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Payout Executions</DialogTitle>
            <DialogDescription>
              Provider attempts for this withdrawal
            </DialogDescription>
          </DialogHeader>
          {executionsQ.isLoading ? (
            <Skeleton className="h-24" />
          ) : !executionsQ.data || executionsQ.data.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No executions yet
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Provider evidence</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {executionsQ.data.map((e) => {
                  const resumableCancellation = canResumeCancellation(e)
                  const activeCancellationLease =
                    e.stage === "CANCEL_REQUESTED" && !resumableCancellation
                  return (
                    <TableRow key={e.id}>
                      <TableCell>
                        {e.provider?.displayName ?? e.provider?.name}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={e.status} />
                      </TableCell>
                      <TableCell>${Number(e.amount).toFixed(2)}</TableCell>
                      <TableCell className="max-w-[220px] text-xs">
                        <div className="font-medium">{e.stage}</div>
                        <div className="font-mono text-muted-foreground">
                          {e.providerTransferId ?? "no transfer"}
                        </div>
                        <div className="font-mono text-muted-foreground">
                          {e.providerPayoutId ?? "no bank payout"}
                        </div>
                        <div className="font-mono text-muted-foreground">
                          {e.bankTraceReference ??
                            e.acceptedReference ??
                            e.requestedReference ??
                            "no reference"}
                        </div>
                      </TableCell>
                      <TableCell
                        className="max-w-[200px] truncate text-xs text-muted-foreground"
                        title={e.errorMessage ?? ""}
                      >
                        {e.errorMessage ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {e.status === "PROCESSING" &&
                            e.stage === "PROVIDER_SENT" &&
                            e.provider?.name === "manual" && (
                              <Button
                                size="sm"
                                onClick={() => {
                                  const withdrawal = payable.find(
                                    (candidate) =>
                                      candidate.id === executionsFor,
                                  )
                                  if (!withdrawal?.publicReference) {
                                    toast.error(
                                      "This withdrawal has no canonical public reference and cannot be manually completed",
                                    )
                                    return
                                  }
                                  setExecutionsFor(null)
                                  setManualBankReference("")
                                  setManualCompletionReason("")
                                  setManualCompletionConfirmation("")
                                  setManualCompletionTarget({
                                    withdrawalId: executionsFor!,
                                    withdrawalPublicReference:
                                      withdrawal.publicReference,
                                    publisherId:
                                      withdrawal.publisher?.id ??
                                      withdrawal.publisherId,
                                    publisherLabel:
                                      withdrawal.publisher?.name ||
                                      withdrawal.publisher?.email ||
                                      withdrawal.publisherId,
                                    amountLabel: `${Number(e.amount).toFixed(
                                      2,
                                    )} ${e.sourceCurrency}`,
                                    executionId: e.id,
                                    executionCreatedAt: e.createdAt,
                                  })
                                  setManualPaidAt(localDateTimeValue())
                                }}
                              >
                                Confirm bank payment
                              </Button>
                            )}
                          {(e.status === "FAILED" ||
                            (e.status === "PROCESSING" &&
                              (RECOVERABLE_PAYOUT_CLAIM_STAGES.has(e.stage) ||
                                (e.stage === "TRANSFER_RECOVERY_REQUIRED" &&
                                  !e.providerPayoutId) ||
                                (["BANK_PAYOUT_RECOVERY_REQUIRED"].includes(
                                  e.stage,
                                ) &&
                                  !!e.providerPayoutId)))) && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                const isClaimRecovery =
                                  RECOVERABLE_PAYOUT_CLAIM_STAGES.has(e.stage)
                                setExecutionActionTarget({
                                  action: "retry",
                                  id: e.id,
                                  label: isClaimRecovery
                                    ? "Recover exact provider claim"
                                    : "Retry payout execution",
                                  providerLabel:
                                    e.provider?.displayName ??
                                    e.provider?.name ??
                                    "Unknown provider",
                                  amountLabel: `$${Number(e.amount).toFixed(
                                    2,
                                  )} ${e.sourceCurrency}`,
                                  stage: e.stage,
                                  evidence:
                                    e.bankTraceReference ??
                                    e.acceptedReference ??
                                    e.requestedReference ??
                                    e.providerPayoutId ??
                                    e.providerTransferId ??
                                    e.providerExecutionId ??
                                    "No provider reference recorded",
                                  confirmationToken: "RETRY",
                                })
                                setExecutionActionReason("")
                                setExecutionActionConfirmation("")
                              }}
                              disabled={retryExecution.isPending}
                            >
                              {RECOVERABLE_PAYOUT_CLAIM_STAGES.has(e.stage)
                                ? "Recover claim"
                                : "Retry"}
                            </Button>
                          )}
                          {EXPIRED_PAYOUT_CLAIM_STAGES.has(e.stage) && (
                            <Badge variant="destructive">
                              Finance review only
                            </Badge>
                          )}
                          {activeCancellationLease && (
                            <Badge variant="secondary">
                              Cancellation in progress
                            </Badge>
                          )}
                          {["PENDING", "PROCESSING"].includes(e.status) &&
                            ((["CREATED", "DESTINATION_VALIDATED"].includes(
                              e.stage,
                            ) &&
                              !e.providerExecutionId &&
                              !e.providerTransferId &&
                              !e.providerPayoutId) ||
                              (e.provider?.name === "stripe_connect" &&
                                !!e.providerExecutionId &&
                                [
                                  "TRANSFER_RECOVERY_REQUIRED",
                                  "BANK_PAYOUT_PENDING",
                                  "BANK_PAYOUT_RECOVERY_REQUIRED",
                                  "CANCEL_REQUESTED",
                                ].includes(e.stage) &&
                                (e.stage !== "CANCEL_REQUESTED" ||
                                  resumableCancellation))) && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setExecutionActionTarget({
                                    action: "cancel",
                                    id: e.id,
                                    label:
                                      e.stage === "CANCEL_REQUESTED"
                                        ? "Resume payout cancellation"
                                        : "Cancel payout execution",
                                    providerLabel:
                                      e.provider?.displayName ??
                                      e.provider?.name ??
                                      "Unknown provider",
                                    amountLabel: `$${Number(e.amount).toFixed(
                                      2,
                                    )} ${e.sourceCurrency}`,
                                    stage: e.stage,
                                    evidence:
                                      e.bankTraceReference ??
                                      e.acceptedReference ??
                                      e.requestedReference ??
                                      e.providerPayoutId ??
                                      e.providerTransferId ??
                                      e.providerExecutionId ??
                                      "No provider reference recorded",
                                    confirmationToken: "CANCEL",
                                  })
                                  setExecutionActionReason("")
                                  setExecutionActionConfirmation("")
                                }}
                                disabled={cancelExecution.isPending}
                              >
                                <XCircle className="mr-1 h-3 w-3" />{" "}
                                {e.stage === "CANCEL_REQUESTED"
                                  ? "Resume cancellation"
                                  : "Cancel"}
                              </Button>
                            )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>

      {/* Deliberate approval: approval makes the reservation eligible for send. */}
      <Dialog
        open={!!withdrawalApprovalTarget}
        onOpenChange={(open) => {
          if (!open && !approveWithdrawal.isPending) {
            setWithdrawalApprovalTarget(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve publisher withdrawal</DialogTitle>
            <DialogDescription>
              Confirm the exact publisher, amount, and reference. Approval does
              not itself send money, but it makes this reserved withdrawal
              eligible for a separate Finance execution.
            </DialogDescription>
          </DialogHeader>
          {withdrawalApprovalTarget && (
            <dl className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Publisher</dt>
                <dd className="text-right font-medium">
                  {withdrawalApprovalTarget.publisherLabel}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Amount</dt>
                <dd className="font-medium tabular-nums">
                  {withdrawalApprovalTarget.amountLabel}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Reference</dt>
                <dd className="font-mono text-xs">
                  {withdrawalApprovalTarget.publicReference}
                </dd>
              </div>
            </dl>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={approveWithdrawal.isPending}
              onClick={() => setWithdrawalApprovalTarget(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                approveWithdrawal.isPending || !withdrawalApprovalTarget
              }
              onClick={() =>
                approveWithdrawal.mutate(withdrawalApprovalTarget!.id)
              }
            >
              {approveWithdrawal.isPending
                ? "Approving..."
                : "Confirm approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* External-send confirmation: requires exact reference + rationale. */}
      <Dialog
        open={!!payoutExecutionTarget}
        onOpenChange={(open) => {
          if (!open && !executePayout.isPending) {
            setPayoutExecutionTarget(null)
            setPayoutExecutionReason("")
            setPayoutExecutionConfirmation("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" />
              Confirm external payout
            </DialogTitle>
            <DialogDescription>
              This command can send real money through the selected provider.
              Verify the immutable payout facts below before continuing.
            </DialogDescription>
          </DialogHeader>
          {payoutExecutionTarget && (
            <>
              <dl className="grid gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Provider</dt>
                  <dd className="font-medium">
                    {payoutExecutionTarget.providerLabel}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Amount</dt>
                  <dd className="font-medium tabular-nums">
                    {payoutExecutionTarget.amountLabel}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Reference</dt>
                  <dd className="font-mono text-xs">
                    {payoutExecutionTarget.publicReference}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Destination</dt>
                  <dd className="text-right font-medium">
                    {payoutExecutionTarget.payoutMethodLabel}
                  </dd>
                </div>
              </dl>
              <div className="space-y-2">
                <Label htmlFor="payout-execution-reason">
                  Finance execution reason
                </Label>
                <textarea
                  id="payout-execution-reason"
                  className="flex min-h-[88px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={payoutExecutionReason}
                  onChange={(event) =>
                    setPayoutExecutionReason(event.target.value)
                  }
                  minLength={10}
                  maxLength={500}
                  placeholder="Explain the evidence and business reason for sending this payout..."
                />
                <p className="text-xs text-muted-foreground">
                  {payoutExecutionReason.length}/500 characters
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="payout-execution-confirmation">
                  Type{" "}
                  <span className="font-mono">
                    {payoutExecutionTarget.confirmationToken}
                  </span>{" "}
                  to confirm
                </Label>
                <Input
                  id="payout-execution-confirmation"
                  value={payoutExecutionConfirmation}
                  onChange={(event) =>
                    setPayoutExecutionConfirmation(event.target.value)
                  }
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={payoutExecutionTarget.confirmationToken}
                />
              </div>
            </>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={executePayout.isPending}
              onClick={() => {
                setPayoutExecutionTarget(null)
                setPayoutExecutionReason("")
                setPayoutExecutionConfirmation("")
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                executePayout.isPending ||
                !payoutExecutionTarget ||
                payoutExecutionReason.trim().length < 10 ||
                payoutExecutionConfirmation.trim() !==
                  payoutExecutionTarget.confirmationToken
              }
              onClick={() =>
                executePayout.mutate({
                  id: payoutExecutionTarget!.id,
                  provider: payoutExecutionTarget!.provider,
                  reason: payoutExecutionReason.trim(),
                })
              }
            >
              {executePayout.isPending ? "Sending..." : "Send real payout"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Retry/recovery/cancellation confirmation with current provider facts. */}
      <Dialog
        open={!!executionActionTarget}
        onOpenChange={(open) => {
          if (
            !open &&
            !retryExecution.isPending &&
            !cancelExecution.isPending
          ) {
            setExecutionActionTarget(null)
            setExecutionActionReason("")
            setExecutionActionConfirmation("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{executionActionTarget?.label}</DialogTitle>
            <DialogDescription>
              {executionActionTarget?.action === "cancel"
                ? "This may issue a provider cancellation or reversal. Confirm the current stage and provider evidence before continuing."
                : "This may replay the original idempotent provider claim or continue a provider recovery. Confirm the current evidence before continuing."}
            </DialogDescription>
          </DialogHeader>
          {executionActionTarget && (
            <>
              <dl className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Provider</dt>
                  <dd className="font-medium">
                    {executionActionTarget.providerLabel}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Amount</dt>
                  <dd className="font-medium tabular-nums">
                    {executionActionTarget.amountLabel}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Current stage</dt>
                  <dd className="font-mono text-xs">
                    {executionActionTarget.stage}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Provider evidence</dt>
                  <dd className="max-w-[65%] break-all text-right font-mono text-xs">
                    {executionActionTarget.evidence}
                  </dd>
                </div>
              </dl>
              <div className="space-y-2">
                <Label htmlFor="execution-action-reason">
                  Finance operator reason
                </Label>
                <textarea
                  id="execution-action-reason"
                  className="flex min-h-[88px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={executionActionReason}
                  onChange={(event) =>
                    setExecutionActionReason(event.target.value)
                  }
                  minLength={10}
                  maxLength={500}
                  placeholder="Explain why this exact recovery or cancellation is safe..."
                />
                <p className="text-xs text-muted-foreground">
                  {executionActionReason.length}/500 characters
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="execution-action-confirmation">
                  Type{" "}
                  <span className="font-mono">
                    {executionActionTarget.confirmationToken}
                  </span>{" "}
                  to confirm
                </Label>
                <Input
                  id="execution-action-confirmation"
                  value={executionActionConfirmation}
                  onChange={(event) =>
                    setExecutionActionConfirmation(event.target.value)
                  }
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={executionActionTarget.confirmationToken}
                />
              </div>
            </>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={retryExecution.isPending || cancelExecution.isPending}
              onClick={() => {
                setExecutionActionTarget(null)
                setExecutionActionReason("")
                setExecutionActionConfirmation("")
              }}
            >
              Back
            </Button>
            <Button
              variant={
                executionActionTarget?.action === "cancel"
                  ? "destructive"
                  : "default"
              }
              disabled={
                retryExecution.isPending ||
                cancelExecution.isPending ||
                !executionActionTarget ||
                executionActionReason.trim().length < 10 ||
                executionActionConfirmation.trim() !==
                  executionActionTarget.confirmationToken
              }
              onClick={() => {
                if (!executionActionTarget) return
                const input = {
                  id: executionActionTarget.id,
                  reason: executionActionReason.trim(),
                }
                if (executionActionTarget.action === "retry") {
                  retryExecution.mutate(input)
                } else {
                  cancelExecution.mutate(input)
                }
              }}
            >
              {retryExecution.isPending || cancelExecution.isPending
                ? "Submitting..."
                : executionActionTarget?.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Evidence-bound completion for manual bank payouts only */}
      <Dialog
        open={!!manualCompletionTarget}
        onOpenChange={(open) => {
          if (!open && !completeManualWithdrawal.isPending) {
            resetManualCompletion()
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm manual bank payment</DialogTitle>
            <DialogDescription>
              Use evidence from the bank after the transfer was submitted. This
              completes the withdrawal and releases payout liability; it cannot
              be used for Stripe Connect or Wise.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {manualCompletionTarget && (
              <dl className="grid gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Publisher</dt>
                  <dd className="text-right font-medium">
                    <span className="block">
                      {manualCompletionTarget.publisherLabel}
                    </span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {manualCompletionTarget.publisherId}
                    </span>
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Amount</dt>
                  <dd className="font-medium tabular-nums">
                    {manualCompletionTarget.amountLabel}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">
                    Withdrawal reference
                  </dt>
                  <dd className="break-all text-right font-mono text-xs">
                    {manualCompletionTarget.withdrawalPublicReference}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Execution ID</dt>
                  <dd className="break-all text-right font-mono text-xs">
                    {manualCompletionTarget.executionId}
                  </dd>
                </div>
              </dl>
            )}
            <div className="space-y-2">
              <Label htmlFor="manual-bank-reference">
                Bank confirmation/reference
              </Label>
              <Input
                id="manual-bank-reference"
                value={manualBankReference}
                onChange={(event) => setManualBankReference(event.target.value)}
                minLength={6}
                maxLength={64}
                placeholder="Bank trace or confirmation reference"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-paid-at">Paid at</Label>
              <Input
                id="manual-paid-at"
                type="datetime-local"
                value={manualPaidAt}
                min={
                  manualCompletionTarget
                    ? localDateTimeValue(
                        new Date(manualCompletionTarget.executionCreatedAt),
                      )
                    : undefined
                }
                max={localDateTimeValue()}
                onChange={(event) => setManualPaidAt(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-completion-reason">
                Reconciliation note
              </Label>
              <textarea
                id="manual-completion-reason"
                className="flex min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={manualCompletionReason}
                onChange={(event) =>
                  setManualCompletionReason(event.target.value)
                }
                minLength={10}
                maxLength={2000}
                placeholder="Explain how and where the bank payment was verified..."
              />
              <p className="text-xs text-muted-foreground">
                {manualCompletionReason.length}/2000 characters
              </p>
            </div>
            {manualCompletionTarget && (
              <div className="space-y-2">
                <Label htmlFor="manual-completion-confirmation">
                  Type{" "}
                  <span className="font-mono">
                    {manualCompletionTarget.withdrawalPublicReference}
                  </span>{" "}
                  exactly to confirm
                </Label>
                <Input
                  id="manual-completion-confirmation"
                  value={manualCompletionConfirmation}
                  onChange={(event) =>
                    setManualCompletionConfirmation(event.target.value)
                  }
                  maxLength={191}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={manualCompletionTarget.withdrawalPublicReference}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={completeManualWithdrawal.isPending}
              onClick={resetManualCompletion}
            >
              Cancel
            </Button>
            <Button
              disabled={
                completeManualWithdrawal.isPending ||
                !manualCompletionTarget ||
                manualBankReference.trim().length < 6 ||
                !manualPaidAt ||
                manualCompletionReason.trim().length < 10 ||
                manualCompletionConfirmation !==
                  manualCompletionTarget.withdrawalPublicReference
              }
              onClick={() => completeManualWithdrawal.mutate()}
            >
              {completeManualWithdrawal.isPending
                ? "Recording..."
                : "Record evidence and complete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Decrypt dialog */}
      <Dialog
        open={!!decryptTarget}
        onOpenChange={(open) => !open && closeDecrypt()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" />
              View Banking Details
            </DialogTitle>
            <DialogDescription>
              This unlock is permanently audit-logged with your identity, IP,
              and the reason below. Requires the FINANCIAL_DATA_DECRYPT
              permission.
            </DialogDescription>
          </DialogHeader>
          {decrypted ? (
            <div className="space-y-2 py-2">
              {Object.entries(decrypted).map(([k, v]) => (
                <div
                  key={k}
                  className="flex justify-between rounded border p-2 text-sm"
                >
                  <span className="text-muted-foreground">{k}</span>
                  <span className="font-mono">{String(v)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2 py-2">
              <Label htmlFor="reason">
                Reason for access (min 10 characters)
              </Label>
              <Input
                id="reason"
                placeholder="e.g. Verifying account for withdrawal #1234"
                value={decryptReason}
                onChange={(e) => setDecryptReason(e.target.value)}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeDecrypt}>
              Close
            </Button>
            {!decrypted && (
              <Button
                onClick={() =>
                  decryptMutation.mutate({
                    id: decryptTarget!,
                    reason: decryptReason,
                  })
                }
                disabled={
                  decryptReason.trim().length < 10 || decryptMutation.isPending
                }
              >
                {decryptMutation.isPending ? "Unlocking..." : "Unlock"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Explicit reject / approved-abandonment decision dialog */}
      <Dialog
        open={!!withdrawalRejectTarget}
        onOpenChange={(open) => {
          if (!open && !rejectWithdrawal.isPending) {
            setWithdrawalRejectTarget(null)
            setWithdrawalRejectReason("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {withdrawalDecisionMode === "abandon"
                ? "Safely abandon approved withdrawal"
                : "Reject pending withdrawal"}
            </DialogTitle>
            <DialogDescription>
              {withdrawalDecisionMode === "abandon"
                ? "This separate Finance command releases the reservation only when the server proves that no provider call was ever claimed and every execution is pre-provider-aborted."
                : "Rejecting this pending request releases its existing reservation exactly once."}{" "}
              Record the internal Finance rationale; the publisher receives only
              a generic notification.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="withdrawal-rejection-reason">
              Internal rejection reason
            </Label>
            <textarea
              id="withdrawal-rejection-reason"
              className="flex min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={withdrawalRejectReason}
              onChange={(event) =>
                setWithdrawalRejectReason(event.target.value)
              }
              minLength={10}
              maxLength={2000}
              placeholder={
                withdrawalDecisionMode === "abandon"
                  ? "Explain why this approved withdrawal must be abandoned before provider send..."
                  : "Explain the evidence and policy reason for rejecting this pending withdrawal..."
              }
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              {withdrawalRejectReason.length}/2000 characters
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={rejectWithdrawal.isPending}
              onClick={() => {
                setWithdrawalRejectTarget(null)
                setWithdrawalRejectReason("")
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                rejectWithdrawal.isPending ||
                withdrawalRejectReason.trim().length < 10
              }
              onClick={() =>
                rejectWithdrawal.mutate({
                  id: withdrawalRejectTarget!,
                  reason: withdrawalRejectReason.trim(),
                  mode: withdrawalDecisionMode,
                })
              }
            >
              {rejectWithdrawal.isPending
                ? "Recording decision..."
                : withdrawalDecisionMode === "abandon"
                  ? "Safely abandon and release"
                  : "Reject and release reservation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve Settlement dialog */}
      <Dialog
        open={!!approveTarget}
        onOpenChange={(open) => {
          if (!open) {
            setApproveTarget(null)
            setApproveReason("")
            setForceApproval(false)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {forceApproval ? "Force customer approval" : "Approve settlement"}
            </DialogTitle>
            <DialogDescription>
              {forceApproval
                ? "This Super Admin action records the missing customer approval. Finance or Super Admin must still perform the final settlement approval afterward."
                : "Record a reason for the final Finance approval. This releases eligible publisher funds and is captured in the audit trail."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="settlement-reason">Reason</Label>
            <textarea
              id="settlement-reason"
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder="Explain why this settlement is being approved..."
              value={approveReason}
              onChange={(e) => setApproveReason(e.target.value)}
              maxLength={1000}
            />
            <p className="text-xs text-muted-foreground">
              {approveReason.length}/1000 characters
            </p>
          </div>
          <div className="rounded-md border p-3 text-sm">
            {settlementEligibilityQ.isLoading ? (
              <Skeleton className="h-5 w-full" />
            ) : settlementEligibilityQ.error ? (
              <p className="text-destructive">
                Eligibility could not be loaded. Approval remains blocked.
              </p>
            ) : settlementEligibilityQ.data?.eligible ? (
              <p className="text-emerald-700">
                Current delivery and order evidence is eligible. The mutation
                will recheck it under lock.
              </p>
            ) : (
              <div className="space-y-1 text-destructive">
                <p className="font-medium">Settlement is currently blocked:</p>
                <ul className="space-y-1">
                  {settlementEligibilityQ.data?.blockers.map((blocker) => (
                    <li key={blocker.code}>{blocker.message}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setApproveTarget(null)
                setApproveReason("")
                setForceApproval(false)
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={
                approveReason.trim().length < 1 ||
                approveSettlement.isPending ||
                !settlementEligibilityQ.data?.eligible
              }
              onClick={() =>
                approveSettlement.mutate({
                  id: approveTarget!,
                  reason: approveReason.trim(),
                  force: forceApproval,
                })
              }
            >
              {approveSettlement.isPending
                ? "Approving..."
                : forceApproval
                  ? "Record customer approval"
                  : "Approve and release"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
