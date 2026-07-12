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
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
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
  { key: "walletDrift", label: "Wallet Drift", icon: DollarSign },
  { key: "publisherDrift", label: "Publisher Balance Drift", icon: Users },
  { key: "settlementDrift", label: "Settlement Integrity", icon: Scale },
  {
    key: "orderPaymentRecon",
    label: "Order Payment Reconciliation",
    icon: CreditCard,
  },
  { key: "refundRecon", label: "Refund Reconciliation", icon: RefreshCw },
  {
    key: "stuckFinancialOrders",
    label: "Stuck Financial Orders",
    icon: AlertCircle,
  },
  { key: "stuckPayouts", label: "Stuck Payouts", icon: XCircle },
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
  icon: Icon,
  counts,
  onClick,
}: {
  label: string
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
                    <TableHead>Message</TableHead>
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
                        {row.amount
                          ? `$${Number(row.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-md">
                        {row.message}
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
    <div className="border-b flex gap-6">
      {tabs.map((tab) => (
        <button
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
  return <FinancePageInner />
}

function FinancePageInner() {
  const [activeTab, setActiveTab] = useState<Tab>("settlements")
  const [settlementPage, setSettlementPage] = useState(1)
  const [withdrawalPage, setWithdrawalPage] = useState(1)
  const queryClient = useQueryClient()

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
  const reconciliationQ = useQuery({
    queryKey: ["reconciliation"],
    queryFn: () => api.admin.getReconciliation(),
    enabled: activeTab === "reconciliation",
  })

  const invalidateWithdrawals = () =>
    queryClient.invalidateQueries({ queryKey: ["withdrawals"] })

  const [approveTarget, setApproveTarget] = useState<string | null>(null)
  const [approveReason, setApproveReason] = useState("")

  const approveSettlement = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.admin.approveSettlement(id, reason),
    onSuccess: () => {
      toast.success("Settlement approved")
      setApproveTarget(null)
      setApproveReason("")
      queryClient.invalidateQueries({ queryKey: ["settlements"] })
    },
    onError: (e: any) =>
      toast.error(e?.message ?? "Failed to approve settlement"),
  })

  const approveWithdrawal = useMutation({
    mutationFn: (id: string) => api.admin.approveWithdrawal(id),
    onSuccess: () => {
      toast.success("Withdrawal approved")
      invalidateWithdrawals()
    },
    onError: (e: any) =>
      toast.error(e?.message ?? "Failed to approve withdrawal"),
  })

  const rejectWithdrawal = useMutation({
    mutationFn: (id: string) =>
      api.admin.rejectWithdrawal(id, "Rejected by admin"),
    onSuccess: () => {
      toast.success("Withdrawal rejected")
      invalidateWithdrawals()
    },
    onError: (e: any) =>
      toast.error(e?.message ?? "Failed to reject withdrawal"),
  })

  const executePayout = useMutation({
    mutationFn: ({ id, provider }: { id: string; provider: string }) =>
      api.admin.executePayout(id, provider),
    onSuccess: () => {
      toast.success("Payout execution started")
      invalidateWithdrawals()
    },
    onError: (e: any) => toast.error(e?.message ?? "Payout execution failed"),
  })

  const markPaid = useMutation({
    mutationFn: (id: string) => api.admin.markWithdrawalPaid(id),
    onSuccess: () => {
      toast.success("Marked as paid")
      invalidateWithdrawals()
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to mark paid"),
  })

  // Executions drill-down
  const [executionsFor, setExecutionsFor] = useState<string | null>(null)
  const executionsQ = useQuery({
    queryKey: ["executions", executionsFor],
    queryFn: () => api.admin.getWithdrawalExecutions(executionsFor!),
    enabled: !!executionsFor,
  })
  const retryExecution = useMutation({
    mutationFn: (id: string) => api.admin.retryPayoutExecution(id),
    onSuccess: () => {
      toast.success("Retry started")
      queryClient.invalidateQueries({ queryKey: ["executions"] })
      invalidateWithdrawals()
    },
    onError: (e: any) => toast.error(e?.message ?? "Retry failed"),
  })
  const cancelExecution = useMutation({
    mutationFn: (id: string) => api.admin.cancelPayoutExecution(id),
    onSuccess: () => {
      toast.success("Execution cancelled")
      queryClient.invalidateQueries({ queryKey: ["executions"] })
      invalidateWithdrawals()
    },
    onError: (e: any) => toast.error(e?.message ?? "Cancel failed"),
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

  const payable = withdrawals.filter((w: any) =>
    ["APPROVED", "PROCESSING", "FAILED"].includes(w.status),
  )
  const recon = reconciliationQ.data

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Finance</h1>
      </div>

      <TabNav
        tabs={TABS}
        active={activeTab}
        onChange={setActiveTab}
        badges={{ payouts: payable.length }}
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
                      <TableCell className="text-muted-foreground text-sm">
                        {s.createdAt
                          ? format(new Date(s.createdAt), "MMM d, yyyy")
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {(s.status === "PENDING" ||
                          s.status === "UNDER_REVIEW") && (
                          <Button
                            size="sm"
                            onClick={() => {
                              setApproveTarget(s.id)
                              setApproveReason("")
                            }}
                          >
                            Approve
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
                          ${Number(w.amount || 0).toFixed(2)}
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
                                onClick={() => approveWithdrawal.mutate(w.id)}
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
                                onClick={() => rejectWithdrawal.mutate(w.id)}
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
              Execute sends real money through the selected provider. Manual =
              paid outside the platform, then marked paid.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {withdrawalsQ.isLoading ? (
              <LoadingRows />
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
                        ${Number(w.amount || 0).toFixed(2)}
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
                                onClick={() =>
                                  executePayout.mutate({
                                    id: w.id,
                                    provider: "manual",
                                  })
                                }
                                disabled={executePayout.isPending}
                              >
                                Execute (Manual)
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => markPaid.mutate(w.id)}
                                disabled={markPaid.isPending}
                              >
                                Mark Paid
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
                  <TableHead>Error</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {executionsQ.data.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      {e.provider?.displayName ?? e.provider?.name}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={e.status} />
                    </TableCell>
                    <TableCell>${Number(e.amount).toFixed(2)}</TableCell>
                    <TableCell
                      className="max-w-[200px] truncate text-xs text-muted-foreground"
                      title={e.errorMessage ?? ""}
                    >
                      {e.errorMessage ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {e.status === "FAILED" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => retryExecution.mutate(e.id)}
                            disabled={retryExecution.isPending}
                          >
                            Retry
                          </Button>
                        )}
                        {["PENDING", "PROCESSING"].includes(e.status) && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => cancelExecution.mutate(e.id)}
                            disabled={cancelExecution.isPending}
                          >
                            <XCircle className="mr-1 h-3 w-3" /> Cancel
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
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

      {/* Approve Settlement dialog */}
      <Dialog
        open={!!approveTarget}
        onOpenChange={(open) => {
          if (!open) {
            setApproveTarget(null)
            setApproveReason("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve settlement</DialogTitle>
            <DialogDescription>
              Record a reason for approving this settlement. This is captured in
              the audit trail.
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
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setApproveTarget(null)
                setApproveReason("")
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={
                approveReason.trim().length < 1 || approveSettlement.isPending
              }
              onClick={() =>
                approveSettlement.mutate({
                  id: approveTarget!,
                  reason: approveReason.trim(),
                })
              }
            >
              {approveSettlement.isPending
                ? "Approving..."
                : "Approve settlement"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
