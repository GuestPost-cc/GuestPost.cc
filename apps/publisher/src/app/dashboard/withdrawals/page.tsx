"use client"

import { useState } from "react"
import { useQuery, useMutation } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { toast } from "sonner"
import {
  Wallet,
  Plus,
  Clock,
  CheckCircle,
  XCircle,
  ArrowUpRight,
  RefreshCw,
  CreditCard,
  Building2,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Label } from "@guestpost/ui"
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

type WithdrawalStatus = "PENDING" | "APPROVED" | "PROCESSING" | "COMPLETED" | "REJECTED"

const statusConfig: Record<
  WithdrawalStatus,
  { label: string; icon: React.ElementType; variant: "default" | "secondary" | "success" | "destructive" | "warning" | "outline" }
> = {
  PENDING: { label: "Pending", icon: Clock, variant: "warning" },
  APPROVED: { label: "Approved", icon: CheckCircle, variant: "secondary" },
  COMPLETED: { label: "Completed", icon: CheckCircle, variant: "success" },
  PROCESSING: { label: "Processing", icon: Clock, variant: "secondary" },
  REJECTED: { label: "Rejected", icon: XCircle, variant: "destructive" },
}

const mockWithdrawals = [
  {
    id: "wd_1",
    amount: 250,
    currency: "USD",
    status: "COMPLETED" as WithdrawalStatus,
    note: "Monthly payout",
    createdAt: "2026-05-15T10:00:00Z",
    processedAt: "2026-05-17T14:00:00Z",
  },
  {
    id: "wd_2",
    amount: 350,
    currency: "USD",
    status: "COMPLETED" as WithdrawalStatus,
    note: "Monthly payout",
    createdAt: "2026-04-15T10:00:00Z",
    processedAt: "2026-04-17T14:00:00Z",
  },
  {
    id: "wd_3",
    amount: 180,
    currency: "USD",
    status: "PENDING" as WithdrawalStatus,
    note: "Custom withdrawal",
    createdAt: "2026-06-01T08:00:00Z",
    processedAt: null,
  },
  {
    id: "wd_4",
    amount: 500,
    currency: "USD",
    status: "APPROVED" as WithdrawalStatus,
    note: "Quarterly payout",
    createdAt: "2026-05-28T10:00:00Z",
    processedAt: null,
  },
]

export default function WithdrawalsPage() {
  const { user } = useAuth()
  const [showRequestDialog, setShowRequestDialog] = useState(false)
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")

  const { data: balance, isLoading, refetch } = useQuery({
    queryKey: ["publisher-balance", user?.publisherId],
    queryFn: () => api.publisherPayouts.getBalance(user!.publisherId!),
    enabled: !!user?.publisherId,
  })

  const { data: withdrawals = mockWithdrawals, isLoading: withdrawalsLoading } = useQuery({
    queryKey: ["publisher-withdrawals"],
    queryFn: () => api.publisherPayouts.listWithdrawals(),
  })

  const requestMutation = useMutation({
    mutationFn: (data: { amount: number; note?: string }) =>
      api.publisherPayouts.requestWithdrawal(data),
    onSuccess: () => {
      toast.success("Withdrawal requested successfully")
      setShowRequestDialog(false)
      setAmount("")
      setNote("")
      refetch()
    },
    onError: () => {
      toast.error("Failed to request withdrawal")
    },
  })

  const handleRequest = () => {
    const amountNum = parseFloat(amount)
    if (isNaN(amountNum) || amountNum <= 0) {
      toast.error("Please enter a valid amount")
      return
    }
    if (balance && amountNum > balance.withdrawableAmount) {
      toast.error("Amount exceeds withdrawable balance")
      return
    }
    requestMutation.mutate({ amount: amountNum, note: note || undefined })
  }

  const withdrawableAmount = balance ? Number(balance.withdrawableAmount) : 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Withdrawals</h1>
          <p className="text-sm text-muted-foreground">
            Request and track your payment withdrawals
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button onClick={() => setShowRequestDialog(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Request Withdrawal
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Available to Withdraw</p>
              <Wallet className="h-5 w-5 text-emerald-500" />
            </div>
            <p className="mt-2 text-3xl font-bold tracking-tight">
              ${withdrawableAmount.toFixed(2)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Pending</p>
              <Clock className="h-5 w-5 text-amber-500" />
            </div>
            <p className="mt-2 text-3xl font-bold tracking-tight">
              $
              {withdrawals
                .filter((w) => w.status === "PENDING")
                .reduce((sum, w) => sum + w.amount, 0)
                .toFixed(2)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">This Month</p>
              <ArrowUpRight className="h-5 w-5 text-blue-500" />
            </div>
            <p className="mt-2 text-3xl font-bold tracking-tight">
              $
              {withdrawals
                .filter(
                  (w) =>
                    w.status === "COMPLETED" &&
                    new Date(w.processedAt ?? w.createdAt).getMonth() ===
                      new Date().getMonth()
                )
                .reduce((sum, w) => sum + w.amount, 0)
                .toFixed(2)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Withdrawal History</CardTitle>
        </CardHeader>
        <CardContent>
          {withdrawalsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : withdrawals.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Wallet className="mb-3 h-10 w-10 text-muted-foreground/50" />
              <p className="font-medium">No withdrawals yet</p>
              <p className="text-sm text-muted-foreground">
                Your withdrawal history will appear here
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Processed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {withdrawals.map((withdrawal) => {
                  const config = statusConfig[withdrawal.status]
                  const Icon = config.icon
                  return (
                    <TableRow key={withdrawal.id}>
                      <TableCell className="text-muted-foreground">
                        {new Date(withdrawal.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="font-medium">
                        ${withdrawal.amount.toFixed(2)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={config.variant}>
                          <Icon className="mr-1 h-3 w-3" />
                          {config.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {withdrawal.note ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {withdrawal.processedAt
                          ? new Date(withdrawal.processedAt).toLocaleDateString()
                          : "—"}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={showRequestDialog} onOpenChange={setShowRequestDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Withdrawal</DialogTitle>
            <DialogDescription>
              Your available balance is{" "}
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
                min="1"
                max={withdrawableAmount}
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <div className="flex gap-2 pt-2">
                {[100, 250, 500].map((val) => (
                  <Button
                    key={val}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setAmount(String(val))}
                    disabled={val > withdrawableAmount}
                  >
                    ${val}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAmount(String(withdrawableAmount))}
                >
                  Max
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="note">Note (Optional)</Label>
              <Input
                id="note"
                placeholder="Add a note..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowRequestDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRequest}
              disabled={
                requestMutation.isPending ||
                !amount ||
                parseFloat(amount) <= 0
              }
            >
              {requestMutation.isPending ? "Processing..." : "Request Withdrawal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}