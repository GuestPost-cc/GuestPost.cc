"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useQuery, useMutation } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { toast } from "sonner"
import {
  DollarSign,
  Clock,
  CheckCircle,
  Wallet,
  TrendingUp,
  ArrowUpRight,
  RefreshCw,
  Download,
  Filter,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, ErrorState } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@guestpost/ui"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@guestpost/ui"
import { Label } from "@guestpost/ui"

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
    amount: z.coerce.number().positive("Amount must be positive"),
  })

  type WithdrawFormData = z.infer<typeof withdrawSchema>

  const {
    register,
    handleSubmit: handleFormSubmit,
    setValue,
    formState: { errors },
    reset,
  } = useForm<WithdrawFormData>({
    resolver: zodResolver(withdrawSchema),
  })

  const { data: balance, isLoading, refetch, error } = useQuery({
    queryKey: ["publisher-balance", user?.publisherId],
    queryFn: () => api.publisherPayouts.getBalance(user!.publisherId!),
    enabled: !!user?.publisherId,
  })

  const { data: transactions = [], isLoading: txnLoading, error: txnError } = useQuery({
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
    mutationFn: (amount: number) =>
      api.publisherPayouts.requestWithdrawal({ amount }),
    onSuccess: () => {
      toast.success("Withdrawal requested successfully")
      setShowWithdrawDialog(false)
      reset()
      refetch()
    },
    onError: () => {
      toast.error("Failed to request withdrawal")
    },
  })

  const handleWithdraw = (data: WithdrawFormData) => {
    if (balance && data.amount > balance.withdrawableAmount) {
      toast.error("Amount exceeds withdrawable balance")
      return
    }
    withdrawMutation.mutate(data.amount)
  }

  const handleExport = (txns: any[]) => {
    const csv = [
      ["Date", "Description", "Type", "Status", "Amount"].join(","),
      ...txns.map((t: any) =>
        [
          new Date(t.createdAt).toISOString().split("T")[0],
          `"${(t.description || "").replace(/"/g, '""')}"`,
          t.type,
          t.status,
          t.amount,
        ].join(","),
      ),
    ].join("\n")
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `earnings-export-${new Date().toISOString().split("T")[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
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
        return txn.status === "PAID" || txn.type === "PAYOUT"
      default:
        return true
    }
  })

  const pendingAmount = balance ? Number(balance.pendingAmount) : 0
  const approvedAmount = balance ? Number(balance.approvedAmount) : 0
  const withdrawableAmount = balance ? Number(balance.withdrawableAmount) : 0
  const lifetimeAmount = balance ? Number(balance.lifetimeEarned) : 0

  const balanceError = error ?? txnError
  if (balanceError)
    return (
      <ErrorState
        title="Failed to load earnings"
        description={(balanceError as Error).message}
        onRetry={() => refetch()}
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
          <Button variant="outline" onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button onClick={() => setShowWithdrawDialog(true)}>
            <Wallet className="mr-2 h-4 w-4" />
            Withdraw
          </Button>
        </div>
      </div>

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
            <Button variant="outline" size="sm" onClick={() => handleExport(transactions)}>
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
                          txn.status === "PAID"
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
                          txn.type === "PAYOUT" ? "text-destructive" : "text-emerald-600"
                        }
                      >
                        {txn.type === "PAYOUT" ? "-" : "+"}${txn.amount.toFixed(2)}
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
              Enter the amount you want to withdraw. Your withdrawable balance is{" "}
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
              {errors.amount && <p className="text-sm text-destructive">{errors.amount.message}</p>}
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
              disabled={withdrawMutation.isPending}
            >
              {withdrawMutation.isPending ? "Processing..." : "Request Withdrawal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}