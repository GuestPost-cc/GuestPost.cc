"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Label } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Skeleton, ErrorState } from "@guestpost/ui"
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
  availableBalance: string | number
  reservedBalance: string | number
  currency: string
}

interface Transaction {
  id: string
  type: string
  amount: string | number
  createdAt: string
  description?: string | null
}

const transactionIcons: Record<string, React.ElementType> = {
  DEPOSIT: ArrowUpCircle,
  PURCHASE: ArrowDownCircle,
  RESERVATION: ArrowDownCircle,
  RELEASE: ArrowUpCircle,
  REFUND: RefreshCw,
  WITHDRAWAL: ArrowDownCircle,
}

const transactionColors: Record<string, string> = {
  DEPOSIT: "text-emerald-500",
  PURCHASE: "text-red-500",
  RESERVATION: "text-amber-500",
  RELEASE: "text-blue-500",
  REFUND: "text-blue-500",
  WITHDRAWAL: "text-red-500",
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
  const router = useRouter()
  const [showDepositDialog, setShowDepositDialog] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  // Set when checkout sends the customer here to top up; we return them after.
  const [returnTo, setReturnTo] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(
      z.object({
        amount: z.coerce.number().positive("Amount must be positive"),
      })
    ),
    defaultValues: { amount: 0 },
  })

  const { data: walletData, isLoading: walletLoading, error: walletError, refetch: refetchWallet } = useQuery<WalletData>({
    queryKey: ["wallet"],
    queryFn: () => api.billing.getWallet(),
  })

  const { data: transactionsData, isLoading: transactionsLoading, error: transactionsError, refetch: refetchTransactions } = useQuery<Transaction[]>({
    queryKey: ["transactions"],
    queryFn: () => api.billing.listTransactions() as Promise<Transaction[]>,
  })

  const { data: ordersData, error: ordersError, refetch: refetchOrders } = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.orders.list() as Promise<any[]>,
  })

  const reservedBalance = (ordersData ?? [])
    .filter((o: any) => !["COMPLETED", "CANCELLED", "REFUNDED"].includes(o.status))
    .reduce((sum: number, o: any) => sum + (o.totalAmount || 0), 0)

  // Auto-open the deposit dialog (prefilled) when checkout redirects here for a
  // top-up: /dashboard/billing?deposit=<amount>&returnTo=<url>
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const amt = Number(sp.get("deposit"))
    const ret = sp.get("returnTo")
    if (amt > 0) {
      setShowDepositDialog(true)
      setValue("amount", Math.ceil(amt), { shouldValidate: true })
    }
    if (ret) setReturnTo(ret)
  }, [setValue])

  const depositMutation = useMutation({
    mutationFn: (amount: number) => {
      if (!walletData?.id) throw new Error("Wallet not loaded")
      return api.billing.deposit({ walletId: walletData.id, amount })
    },
    onSuccess: (_data, variables) => {
      toast.success(`Deposited $${variables.toFixed(2)} successfully!`)
      queryClient.invalidateQueries({ queryKey: ["wallet"] })
      queryClient.invalidateQueries({ queryKey: ["transactions"] })
      setShowDepositDialog(false)
      reset()
      // Bounce back to checkout (or wherever) now that funds are available.
      if (returnTo) {
        const dest = returnTo
        setReturnTo(null)
        router.push(dest)
      }
    },
    onError: () => {
      toast.error("Failed to process deposit")
    },
  })

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
    .filter((tx: Transaction) => tx.type === "DEPOSIT")
    .reduce((sum: number, tx: Transaction) => sum + Number(tx.amount), 0)

  const totalSpent = (transactionsData ?? [])
    .filter((tx: Transaction) => tx.type === "PURCHASE")
    .reduce((sum: number, tx: Transaction) => sum + Math.abs(Number(tx.amount)), 0)

  const billingError = walletError || transactionsError || ordersError

  if (billingError) {
    return <ErrorState title="Failed to load billing" description={(billingError as Error).message} onRetry={() => { refetchWallet(); refetchTransactions(); refetchOrders(); }} />
  }

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
              ${Number(walletData?.availableBalance ?? 0).toFixed(2)}
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
                const isNegative = Number(tx.amount) < 0

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
                      <span className={`font-mono font-medium ${isNegative ? "text-red-500" : "text-emerald-500"}`}>
                        {isNegative ? "-" : "+"}${Math.abs(Number(tx.amount)).toFixed(2)}
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
            <Button variant="outline" size="sm" onClick={() => toast.info("No invoices to download yet")}>
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
          <form onSubmit={handleSubmit((data) => depositMutation.mutate(data.amount))}>
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
                    {...register("amount", { valueAsNumber: true })}
                    className="pl-7"
                  />
                </div>
                {errors.amount?.message && (
                  <p className="text-sm text-destructive">{errors.amount.message}</p>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2">
                {[50, 100, 250, 500, 1000, 2500].map((amount) => (
                  <Button
                    key={amount}
                    variant={watch("amount") === amount ? "default" : "outline"}
                    size="sm"
                    type="button"
                    onClick={() => setValue("amount", amount, { shouldValidate: true })}
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
              <Button type="button" variant="outline" onClick={() => setShowDepositDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={depositMutation.isPending}>
                {depositMutation.isPending ? "Processing..." : "Continue to Payment"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}