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
  DollarSign,
  Eye,
  RefreshCw,
  ShieldAlert,
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

function DriftSection({
  title,
  rows,
  headers,
  renderRow,
}: {
  title: string
  rows: any[]
  headers: string[]
  renderRow: (row: any) => React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          {title}
          <Badge variant={rows.length === 0 ? "success" : "destructive"}>
            {rows.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      {rows.length > 0 && (
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {headers.map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>{renderRow(r)}</TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
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

  const approveSettlement = useMutation({
    mutationFn: (id: string) => api.admin.approveSettlement(id),
    onSuccess: () => {
      toast.success("Settlement approved")
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
                    "status",
                    "createdAt",
                  ],
                  settlements.map((s: any) => [
                    s.id,
                    s.orderId,
                    s.publisher?.name ?? s.publisherId,
                    Number(s.grossAmount ?? s.amount ?? 0).toFixed(2),
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
                            onClick={() => approveSettlement.mutate(s.id)}
                            disabled={approveSettlement.isPending}
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
        <div className="space-y-4">
          <Card>
            <CardContent className="flex items-center justify-between p-4">
              <p className="text-sm text-muted-foreground">
                Verifies cached balances match the transaction ledger. Run after
                any manual data change.
              </p>
              <Button
                variant="default"
                size="sm"
                onClick={() => reconciliationQ.refetch()}
                disabled={reconciliationQ.isFetching}
              >
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${reconciliationQ.isFetching ? "animate-spin" : ""}`}
                />
                {reconciliationQ.isFetching ? "Running..." : "Run Now"}
              </Button>
            </CardContent>
          </Card>

          {reconciliationQ.isLoading ? (
            <LoadingRows />
          ) : reconciliationQ.error ? (
            <ErrorBlock
              label="Reconciliation failed to run"
              onRetry={() => reconciliationQ.refetch()}
            />
          ) : recon ? (
            <>
              <Card>
                <CardContent className="flex items-center gap-4 p-6">
                  {recon.ok ? (
                    <>
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30">
                        <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <div>
                        <p className="font-semibold text-emerald-700 dark:text-emerald-400">
                          All checks passed
                        </p>
                        <p className="text-sm text-muted-foreground">
                          No drift detected — balances agree with the ledger.
                          Ran{" "}
                          {format(new Date(recon.ranAt), "MMM d, yyyy h:mm a")}
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                        <ShieldAlert className="h-6 w-6 text-red-600 dark:text-red-400" />
                      </div>
                      <div>
                        <p className="font-semibold text-red-700 dark:text-red-400">
                          Drift detected — investigate before processing payouts
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Ran{" "}
                          {format(new Date(recon.ranAt), "MMM d, yyyy h:mm a")}
                        </p>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Wallet Drift */}
              <DriftSection
                title="Wallet Drift"
                rows={recon.walletDrift}
                headers={[
                  "Wallet ID",
                  "Organization ID",
                  "Expected",
                  "Actual",
                  "Delta",
                ]}
                renderRow={(r: any) => (
                  <>
                    <TableCell className="font-mono text-xs">
                      {r.walletId?.slice(0, 8)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.organizationId?.slice(0, 8)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      ${Number(r.expected).toFixed(2)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      ${Number(r.actual).toFixed(2)}
                    </TableCell>
                    <TableCell
                      className={`tabular-nums font-medium ${Number(r.delta) < 0 ? "text-destructive" : "text-emerald-600"}`}
                    >
                      ${Number(r.delta).toFixed(2)}
                    </TableCell>
                  </>
                )}
              />

              {/* Publisher Balance Drift */}
              <DriftSection
                title="Publisher Balance Drift"
                rows={recon.publisherDrift}
                headers={[
                  "Publisher ID",
                  "Expected",
                  "Actual",
                  "Delta",
                  "Debt Balance",
                ]}
                renderRow={(r: any) => (
                  <>
                    <TableCell className="font-mono text-xs">
                      {r.publisherId?.slice(0, 8)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      ${Number(r.expected).toFixed(2)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      ${Number(r.actual).toFixed(2)}
                    </TableCell>
                    <TableCell
                      className={`tabular-nums font-medium ${Number(r.delta) < 0 ? "text-destructive" : "text-emerald-600"}`}
                    >
                      ${Number(r.delta).toFixed(2)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      ${Number(r.debtBalance ?? 0).toFixed(2)}
                    </TableCell>
                  </>
                )}
              />

              {/* Stuck Orders */}
              <DriftSection
                title="Stuck Orders"
                rows={recon.stuckOrders}
                headers={["Order ID", "Amount", "Problem"]}
                renderRow={(r: any) => (
                  <>
                    <TableCell className="font-mono text-xs">
                      {r.orderId?.slice(0, 8)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {r.amount ? `$${Number(r.amount).toFixed(2)}` : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-md">
                      {r.problem}
                    </TableCell>
                  </>
                )}
              />

              {/* Stuck Payouts */}
              <DriftSection
                title="Stuck Payouts"
                rows={recon.stuckPayouts}
                headers={["ID", "Amount", "Problem"]}
                renderRow={(r: any) => (
                  <>
                    <TableCell className="font-mono text-xs">
                      {(
                        r.withdrawalId ??
                        r.executionId ??
                        r.publisherId ??
                        ""
                      )?.slice(0, 8)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {r.amount ? `$${Number(r.amount).toFixed(2)}` : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-md">
                      {r.problem}
                    </TableCell>
                  </>
                )}
              />
            </>
          ) : null}
        </div>
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
    </div>
  )
}
