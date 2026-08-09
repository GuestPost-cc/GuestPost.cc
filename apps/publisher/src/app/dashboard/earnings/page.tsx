"use client"

import { payoutErrorPresentation } from "@guestpost/api-client"
import {
  type CertifiedWithdrawalMethodType,
  isPaidWithdrawalStatus,
  selectExecutablePayoutMethods,
} from "@guestpost/shared"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  downloadCsv,
  ErrorState,
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
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  CheckCircle,
  Clock,
  DollarSign,
  Download,
  RefreshCw,
  TrendingUp,
  Wallet,
} from "lucide-react"
import { useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

type TabValue = "pending" | "approved" | "withdrawable" | "paid"

const tabs: { value: TabValue; label: string; icon: React.ElementType }[] = [
  { value: "pending", label: "Pending", icon: Clock },
  { value: "approved", label: "Approved", icon: CheckCircle },
  { value: "withdrawable", label: "Withdrawable", icon: Wallet },
  { value: "paid", label: "Paid Out", icon: TrendingUp },
]

function KPICard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string
  value: string
  icon: React.ElementType
  color: string
}) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{label}</p>
          <Icon className={`h-5 w-5 ${color}`} />
        </div>
        <p className="mt-2 text-3xl font-bold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  )
}

export default function EarningsPage() {
  const { user } = useAuth()
  const [activeTab, setActiveTab] = useState<TabValue>("pending")
  const [showWithdrawDialog, setShowWithdrawDialog] = useState(false)

  const withdrawSchema = z.object({
    amount: z.coerce
      .number()
      .min(1, "Amount must be at least $1")
      .max(1_000_000, "Amount is too large")
      .multipleOf(0.01, "Use no more than two decimal places"),
  })

  type WithdrawFormInput = z.input<typeof withdrawSchema>
  type WithdrawFormData = z.output<typeof withdrawSchema>

  const {
    register,
    handleSubmit: handleFormSubmit,
    setValue,
    formState: { errors },
    reset,
  } = useForm<WithdrawFormInput, unknown, WithdrawFormData>({
    resolver: zodResolver(withdrawSchema),
  })

  const {
    data: balance,
    isLoading,
    refetch,
    error,
  } = useQuery({
    queryKey: ["publisher-balance", user?.publisherId],
    queryFn: () => api.publisherPayouts.getBalance(),
    enabled: !!user?.publisherId,
  })

  const {
    data: payoutMethodsRaw,
    isLoading: payoutMethodsLoading,
    error: payoutMethodsError,
    refetch: refetchPayoutMethods,
  } = useQuery({
    queryKey: ["payout-methods"],
    queryFn: () => api.publisherPayouts.listPayoutMethods(),
  })
  const payoutMethods = selectExecutablePayoutMethods(payoutMethodsRaw)
  const payoutMethodsFailure = payoutMethodsError
    ? payoutErrorPresentation(
        payoutMethodsError,
        "Payout methods could not be verified.",
      )
    : null
  const withdrawalIdempotencyRef = useRef<{
    fingerprint: string
    key: string
  } | null>(null)

  const {
    data: transactions = [],
    isLoading: txnLoading,
    error: txnError,
    refetch: refetchTxns,
  } = useQuery({
    queryKey: ["publisher-transactions"],
    queryFn: async () => {
      const withdrawals = await api.publisherPayouts.listWithdrawals()
      return (withdrawals.items ?? []).map((w: any) => ({
        id: w.id,
        type: "PAYOUT",
        amount: w.amount,
        status: w.status,
        description: w.note || `Withdrawal #${w.id.slice(0, 8)}`,
        createdAt: w.createdAt,
      }))
    },
  })

  const withdrawMutation = useMutation({
    mutationFn: (request: {
      amount: number
      method: CertifiedWithdrawalMethodType
      payoutMethodId: string
      idempotencyKey: string
    }) => api.publisherPayouts.requestWithdrawal(request),
    onSuccess: () => {
      toast.success("Withdrawal requested successfully")
      setShowWithdrawDialog(false)
      reset()
      withdrawalIdempotencyRef.current = null
      refetch()
      refetchTxns()
    },
    onError: (error: unknown) => {
      const presentation = payoutErrorPresentation(
        error,
        "Failed to request withdrawal",
      )
      toast.error(presentation.message, {
        description: presentation.requestId
          ? `Request ID: ${presentation.requestId}`
          : undefined,
      })
    },
  })

  const handleWithdraw = (data: WithdrawFormData) => {
    if (payoutMethodsLoading || payoutMethodsError) {
      toast.error(
        "Payout eligibility could not be verified. Retry loading payout methods before submitting.",
      )
      return
    }
    if (balance && Number(balance.debtBalance) > 0) {
      toast.error(
        "Withdrawals are unavailable while outstanding publisher debt remains. Future settlements must repay it first.",
      )
      return
    }
    if (balance && data.amount > balance.withdrawableBalance) {
      toast.error("Amount exceeds withdrawable balance")
      return
    }
    const payoutMethod =
      payoutMethods?.find((method) => method.isDefault) ?? payoutMethods?.[0]
    if (!payoutMethod) {
      toast.error("Connect an active payout method first")
      return
    }
    const fingerprint = [
      data.amount.toFixed(2),
      payoutMethod.id,
      payoutMethod.type,
    ].join(":")
    if (withdrawalIdempotencyRef.current?.fingerprint !== fingerprint) {
      withdrawalIdempotencyRef.current = {
        fingerprint,
        key: crypto.randomUUID(),
      }
    }
    withdrawMutation.mutate({
      amount: data.amount,
      method: payoutMethod.type,
      payoutMethodId: payoutMethod.id,
      idempotencyKey: withdrawalIdempotencyRef.current.key,
    })
  }

  const handleExport = (txns: any[]) => {
    // downloadCsv neutralizes spreadsheet formula injection in descriptions
    downloadCsv(
      `earnings-export-${new Date().toISOString().split("T")[0]}.csv`,
      ["Date", "Description", "Type", "Status", "Amount"],
      txns.map((t: any) => [
        new Date(t.createdAt).toISOString().split("T")[0],
        t.description || "",
        t.type,
        t.status,
        t.amount,
      ]),
    )
    toast.success("Earnings exported")
  }

  const filteredTransactions = transactions.filter((txn: any) => {
    switch (activeTab) {
      case "pending":
        return txn.status === "PENDING"
      case "approved":
        return txn.status === "APPROVED"
      case "withdrawable":
        return txn.status === "APPROVED"
      case "paid":
        return isPaidWithdrawalStatus(txn.status)
      default:
        return true
    }
  })

  const pendingAmount = balance ? Number(balance.pendingBalance) : 0
  const approvedAmount = balance ? Number(balance.approvedBalance) : 0
  const withdrawableAmount = balance ? Number(balance.withdrawableBalance) : 0
  const debtAmount = balance ? Number(balance.debtBalance) : 0
  const lifetimeAmount = balance ? Number(balance.lifetimeEarnings) : 0
  const withdrawalBlockedReason = isLoading
    ? "Checking your withdrawable balance…"
    : payoutMethodsLoading
      ? "Checking your eligible payout methods…"
      : payoutMethodsError
        ? `${payoutMethodsFailure?.message ?? "Payout methods could not be verified."} Retry before requesting a withdrawal.${
            payoutMethodsFailure?.requestId
              ? ` Request ID: ${payoutMethodsFailure.requestId}`
              : ""
          }`
        : debtAmount > 0
          ? "Withdrawals are unavailable while outstanding publisher debt remains. Future settlements must repay it first."
          : withdrawableAmount < 1
            ? "No withdrawable balance is currently available."
            : payoutMethods.length === 0
              ? "No active, executable payout method is available. Complete or review payout setup first."
              : null
  const canRequestWithdrawal =
    !isLoading &&
    !payoutMethodsLoading &&
    !payoutMethodsError &&
    debtAmount <= 0 &&
    payoutMethods.length > 0 &&
    withdrawableAmount >= 1

  const balanceError = error ?? txnError
  if (balanceError)
    return (
      <ErrorState
        title="Failed to load earnings"
        description={(balanceError as Error).message}
        onRetry={() => {
          refetch()
          refetchTxns()
        }}
      />
    )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Earnings</h1>
          <p className="text-sm text-muted-foreground">
            Track your earnings and manage withdrawals
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              void refetch()
              void refetchTxns()
              void refetchPayoutMethods()
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button
            onClick={() => setShowWithdrawDialog(true)}
            disabled={!canRequestWithdrawal}
          >
            <Wallet className="mr-2 h-4 w-4" />
            Withdraw
          </Button>
        </div>
      </div>

      {withdrawalBlockedReason ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-4 text-sm">
          <p className="text-muted-foreground">{withdrawalBlockedReason}</p>
          {payoutMethodsError ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refetchPayoutMethods()}
            >
              Retry payout methods
            </Button>
          ) : payoutMethods.length === 0 &&
            !payoutMethodsLoading &&
            debtAmount <= 0 &&
            withdrawableAmount >= 1 ? (
            <a
              href="/dashboard/payout-methods"
              className="font-medium underline"
            >
              Review payout setup
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <KPICard
          label="Pending"
          value={`$${pendingAmount.toFixed(2)}`}
          icon={Clock}
          color="text-amber-500"
        />
        <KPICard
          label="Approved"
          value={`$${approvedAmount.toFixed(2)}`}
          icon={CheckCircle}
          color="text-blue-500"
        />
        <KPICard
          label="Withdrawable"
          value={`$${withdrawableAmount.toFixed(2)}`}
          icon={Wallet}
          color="text-emerald-500"
        />
        <KPICard
          label="Lifetime Earnings"
          value={`$${lifetimeAmount.toFixed(2)}`}
          icon={TrendingUp}
          color="text-purple-500"
        />
      </div>

      <Card>
        <CardHeader className="pb-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Transaction History</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleExport(transactions)}
            >
              <Download className="mr-2 h-4 w-4" />
              Export
            </Button>
          </div>
          <div className="mt-4 flex gap-2">
            {tabs.map((tab) => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.value}
                  onClick={() => setActiveTab(tab.value)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                    activeTab === tab.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted hover:bg-muted/80"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              )
            })}
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {txnLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : filteredTransactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <DollarSign className="mb-3 h-10 w-10 text-muted-foreground/50" />
              <p className="font-medium">No transactions found</p>
              <p className="text-sm text-muted-foreground">
                Transactions will appear here once you have earnings
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTransactions.map((txn: any) => (
                  <TableRow key={txn.id}>
                    <TableCell className="text-muted-foreground">
                      {new Date(txn.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>{txn.description}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {txn.type.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          isPaidWithdrawalStatus(txn.status)
                            ? "success"
                            : txn.status === "APPROVED"
                              ? "info"
                              : "warning"
                        }
                      >
                        {txn.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      <span
                        className={
                          txn.type === "PAYOUT"
                            ? "text-destructive"
                            : "text-emerald-600"
                        }
                      >
                        {txn.type === "PAYOUT" ? "-" : "+"}$
                        {txn.amount.toFixed(2)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={showWithdrawDialog} onOpenChange={setShowWithdrawDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Withdrawal</DialogTitle>
            <DialogDescription>
              Enter the amount you want to withdraw. Your withdrawable balance
              is{" "}
              <span className="font-medium text-foreground">
                ${withdrawableAmount.toFixed(2)}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="amount">Amount (USD)</Label>
              <Input
                id="amount"
                type="number"
                step="any"
                min="1"
                max={withdrawableAmount}
                placeholder="0.00"
                {...register("amount")}
              />
              {errors.amount && (
                <p className="text-sm text-destructive">
                  {errors.amount.message}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              {[50, 100, 250, 500].map((amount) => (
                <Button
                  key={amount}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setValue("amount", amount)}
                  disabled={amount > withdrawableAmount}
                >
                  ${amount}
                </Button>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setValue("amount", withdrawableAmount)}
              >
                Max
              </Button>
            </div>
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              {payoutMethodsLoading ? (
                <p className="text-muted-foreground">
                  Checking eligible payout methods…
                </p>
              ) : payoutMethodsError ? (
                <div className="space-y-2 text-destructive">
                  <p>
                    {payoutMethodsFailure?.message ??
                      "Payout methods could not be verified."}{" "}
                    A withdrawal cannot be submitted safely.
                    {payoutMethodsFailure?.requestId
                      ? ` Request ID: ${payoutMethodsFailure.requestId}`
                      : ""}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void refetchPayoutMethods()}
                  >
                    Retry
                  </Button>
                </div>
              ) : payoutMethods.length === 0 ? (
                <p className="text-muted-foreground">
                  No active, executable payout method is available. Review{" "}
                  <a href="/dashboard/payout-methods" className="underline">
                    Payout Methods
                  </a>
                  .
                </p>
              ) : (
                <p>
                  Payout destination:{" "}
                  <span className="font-medium">
                    {
                      (
                        payoutMethods.find((method) => method.isDefault) ??
                        payoutMethods[0]
                      )?.label
                    }
                  </span>
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowWithdrawDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleFormSubmit(handleWithdraw)}
              disabled={withdrawMutation.isPending || !canRequestWithdrawal}
            >
              {withdrawMutation.isPending
                ? "Processing..."
                : "Request Withdrawal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
