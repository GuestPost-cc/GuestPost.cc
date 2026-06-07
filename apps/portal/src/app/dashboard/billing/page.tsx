"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Label } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@guestpost/ui"
import {
  Wallet,
  ArrowUpCircle,
  ArrowDownCircle,
  CreditCard,
  Plus,
  Search,
  FileText,
  Download,
  Clock,
  CheckCircle,
  XCircle,
  RefreshCw,
} from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

interface WalletData {
  id: string
  balance: number
  currency: string
}

interface Transaction {
  id: string
  type: string
  amount: number
  status: string
  createdAt: string
  description?: string
}

const transactionIcons: Record<string, React.ElementType> = {
  DEPOSIT: ArrowUpCircle,
  ORDER_PAYMENT: ArrowDownCircle,
  REFUND: RefreshCw,
  WITHDRAWAL: ArrowDownCircle,
  ADJUSTMENT: RefreshCw,
}

const transactionColors: Record<string, string> = {
  DEPOSIT: "text-emerald-500",
  ORDER_PAYMENT: "text-red-500",
  REFUND: "text-blue-500",
  WITHDRAWAL: "text-red-500",
  ADJUSTMENT: "text-purple-500",
}

const statusColors: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-700",
  COMPLETED: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
  CANCELLED: "bg-gray-100 text-gray-500",
}

function WalletSkeleton() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-24" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-32" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-24" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-32" />
        </CardContent>
      </Card>
    </div>
  )
}

function TransactionsSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-lg border p-4">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-5 w-20" />
        </div>
      ))}
    </div>
  )
}

export default function BillingPage() {
  const queryClient = useQueryClient()
  const [showDepositDialog, setShowDepositDialog] = useState(false)
  const [depositAmount, setDepositAmount] = useState("")
  const [searchQuery, setSearchQuery] = useState("")

  const { data: walletData, isLoading: walletLoading } = useQuery<WalletData>({
    queryKey: ["wallet"],
    queryFn: () => api.billing.getWallet() as Promise<WalletData>,
  })

  const { data: transactionsData, isLoading: transactionsLoading } = useQuery<Transaction[]>({
    queryKey: ["transactions"],
    queryFn: () => api.billing.listTransactions() as Promise<Transaction[]>,
  })

  const { data: ordersData } = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.orders.list() as Promise<any[]>,
  })

  const reservedBalance = (ordersData ?? [])
    .filter((o: any) => !["COMPLETED", "CANCELLED", "REFUNDED"].includes(o.status))
    .reduce((sum: number, o: any) => sum + (o.totalAmount || 0), 0)

  const depositMutation = useMutation({
    mutationFn: (amount: number) => api.billing.deposit({ amount }),
    onSuccess: (data) => {
      toast.success(`Deposited $${depositAmount} successfully!`)
      queryClient.invalidateQueries({ queryKey: ["wallet"] })
      queryClient.invalidateQueries({ queryKey: ["transactions"] })
      setShowDepositDialog(false)
      setDepositAmount("")
    },
    onError: () => {
      toast.error("Failed to process deposit")
    },
  })

  const handleDeposit = () => {
    const amount = parseFloat(depositAmount)
    if (isNaN(amount) || amount <= 0) {
      toast.error("Please enter a valid amount")
      return
    }
    depositMutation.mutate(amount)
  }

  const filteredTransactions = (transactionsData ?? []).filter((tx: Transaction) => {
    if (!searchQuery) return true
    const query = searchQuery.toLowerCase()
    return (
      tx.id.toLowerCase().includes(query) ||
      tx.type.toLowerCase().includes(query) ||
      tx.description?.toLowerCase().includes(query)
    )
  })

  const totalDeposits = (transactionsData ?? [])
    .filter((tx: Transaction) => tx.type === "DEPOSIT" && tx.status === "COMPLETED")
    .reduce((sum: number, tx: Transaction) => sum + tx.amount, 0)

  const totalSpent = (transactionsData ?? [])
    .filter((tx: Transaction) => tx.type === "ORDER_PAYMENT" && tx.status === "COMPLETED")
    .reduce((sum: number, tx: Transaction) => sum + Math.abs(tx.amount), 0)

  if (walletLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Billing</h1>
          <p className="text-muted-foreground">Manage your wallet and payments</p>
        </div>
        <WalletSkeleton />
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent>
            <TransactionsSkeleton />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Billing</h1>
          <p className="text-muted-foreground">Manage your wallet and payments</p>
        </div>
        <Button onClick={() => setShowDepositDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Deposit Funds
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="bg-gradient-to-br from-primary/5 to-primary/10">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Wallet className="h-4 w-4" />
              Available Balance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">
              ${(walletData?.balance || 0).toFixed(2)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {walletData?.currency || "USD"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Clock className="h-4 w-4" />
              Reserved
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">
              ${reservedBalance.toFixed(2)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Funds in progress
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <CreditCard className="h-4 w-4" />
              Total Deposited
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">
              ${totalDeposits.toFixed(2)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              All time deposits
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Transaction History</CardTitle>
              <CardDescription>Your recent wallet transactions</CardDescription>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search transactions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 w-64"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {transactionsLoading ? (
            <TransactionsSkeleton />
          ) : filteredTransactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <FileText className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No transactions</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {searchQuery
                  ? "Try adjusting your search"
                  : "Your transaction history will appear here"}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredTransactions.map((tx: Transaction) => {
                const Icon = transactionIcons[tx.type] || RefreshCw
                const colorClass = transactionColors[tx.type] || "text-muted-foreground"
                const isNegative = tx.type === "ORDER_PAYMENT" || tx.type === "WITHDRAWAL"

                return (
                  <div
                    key={tx.id}
                    className="flex items-center justify-between rounded-lg border p-4 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-full bg-muted ${colorClass}`}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="font-medium capitalize">
                          {tx.type.replace(/_/g, " ").toLowerCase()}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {tx.description || tx.id.slice(0, 8)} •{" "}
                          {formatDistanceToNow(new Date(tx.createdAt), { addSuffix: true })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge className={`${statusColors[tx.status] || "bg-gray-100 text-gray-700"} capitalize`}>
                        {tx.status.toLowerCase()}
                      </Badge>
                      <span className={`font-mono font-medium ${isNegative ? "text-red-500" : "text-emerald-500"}`}>
                        {isNegative ? "-" : "+"}${Math.abs(tx.amount).toFixed(2)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Invoices</CardTitle>
              <CardDescription>Your billing invoices</CardDescription>
            </div>
            <Button variant="outline" size="sm">
              <Download className="mr-2 h-4 w-4" />
              Download All
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <FileText className="h-10 w-10 text-muted-foreground/50" />
            <p className="mt-2 text-sm text-muted-foreground">
              No invoices yet. Invoices will be generated automatically.
            </p>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showDepositDialog} onOpenChange={setShowDepositDialog}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Deposit Funds</DialogTitle>
            <DialogDescription>
              Add funds to your wallet. This will redirect to our secure payment provider.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="amount">Amount (USD)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  min="1"
                  placeholder="0.00"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  className="pl-7"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[50, 100, 250, 500, 1000, 2500].map((amount) => (
                <Button
                  key={amount}
                  variant={depositAmount === amount.toString() ? "default" : "outline"}
                  size="sm"
                  onClick={() => setDepositAmount(amount.toString())}
                >
                  ${amount}
                </Button>
              ))}
            </div>

            <div className="rounded-lg bg-muted p-4 text-sm">
              <p className="font-medium">Secure payment powered by Stripe</p>
              <p className="mt-1 text-muted-foreground">
                Your payment information is encrypted and never stored on our servers.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDepositDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleDeposit}
              disabled={!depositAmount || parseFloat(depositAmount) <= 0 || depositMutation.isPending}
            >
              {depositMutation.isPending ? "Processing..." : "Continue to Payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}