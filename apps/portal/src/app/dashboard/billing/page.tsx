"use client"

import {
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
  ErrorState,
  Input,
  Label,
  Skeleton,
} from "@guestpost/ui"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import {
  ArrowDownCircle,
  ArrowUpCircle,
  Clock,
  CreditCard,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Wallet,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { api } from "../../../lib/api"

interface WalletData {
  id: string
  availableBalance: number
  reservedBalance: number
  currency: string
  version: number
}

interface Transaction {
  id: string
  type: string
  amount: number
  description: string | null
  reference: string | null
  createdAt: string
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
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-24" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-10 w-40" />
      </CardContent>
    </Card>
  )
}

function TransactionsSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  )
}

const depositSchema = z.object({
  amount: z.coerce.number().min(1, "Minimum deposit is $1.00"),
})

type DepositForm = z.infer<typeof depositSchema>

export default function BillingPage() {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [showDepositDialog, setShowDepositDialog] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [processingPayment, setProcessingPayment] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  )
  // Set when checkout sends the customer here to top up; we return them after.
  const [returnTo, setReturnTo] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<DepositForm>({
    resolver: zodResolver(depositSchema),
    defaultValues: { amount: 0 },
  })

  const {
    data: walletData,
    isLoading: walletLoading,
    error: walletError,
    refetch: refetchWallet,
  } = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.billing.getWallet(),
  })

  const {
    data: transactionsData,
    isLoading: transactionsLoading,
    error: transactionsError,
    refetch: refetchTransactions,
  } = useQuery({
    queryKey: ["transactions"],
    queryFn: () => api.billing.listTransactions(),
  })

  const {
    data: ordersData,
    error: ordersError,
    refetch: refetchOrders,
  } = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.orders.list() as Promise<any[]>,
  })

  // Reserved balance: sum of amounts on DRAFT/SUBMITTED orders
  const reservedBalance = (ordersData ?? [])
    .filter(
      (o: any) =>
        o.status === "DRAFT" || o.status === "SUBMITTED" || o.status === "PAID",
    )
    .reduce((sum: number, o: any) => sum + (o.totalAmount || 0), 0)

  // ── Post-Stripe redirect: poll wallet until webhook credits it ──────
  // The webhook is the ONLY code path that credits the wallet. The frontend
  // just polls the read-only deposit-status endpoint + wallet balance until
  // the webhook fires, then shows success.
  //
  // Scenarios handled:
  //   1. Webhook fires fast   → deposit-status returns COMPLETED → success
  //   2. Webhook slow/missing → polls 2s, timeout after 60s → graceful message
  //   3. Reload after success → deposit-status returns COMPLETED → success
  //   4. Stale ?success=true  → no sessionStorage, no sessionId → show billing page
  const checkDeposit = useCallback(async () => {
    const sessionId = sessionStorage.getItem("deposit_sessionId") ?? ""
    const walletId = sessionStorage.getItem("deposit_walletId") ?? ""

    if (!sessionId || !walletId) {
      // Stale URL — nothing to poll.
      setProcessingPayment(false)
      return
    }

    try {
      const result = await api.billing.checkDepositStatus(walletId, sessionId)
      if (result.processed) {
        clearInterval(pollTimer.current)
        sessionStorage.removeItem("deposit_sessionId")
        sessionStorage.removeItem("deposit_walletId")
        sessionStorage.removeItem("deposit_expectedAmount")
        sessionStorage.removeItem("deposit_timestamp")
        toast.success("Deposit successful!")
        queryClient.invalidateQueries({ queryKey: ["wallet"] })
        queryClient.invalidateQueries({ queryKey: ["transactions"] })
        const pendingReturn = sessionStorage.getItem("deposit_returnTo")
        if (pendingReturn) {
          sessionStorage.removeItem("deposit_returnTo")
          router.replace(pendingReturn)
        } else {
          setProcessingPayment(false)
        }
      }
      // If not processed yet, just wait for the next poll cycle.
    } catch {
      // API error — keep polling, the timeout will handle the failure case.
    }
  }, [router, queryClient])

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

    if (sp.get("success") === "true") {
      // Stripe appends ?session_id=cs_xxx to the success_url via the
      // {CHECKOUT_SESSION_ID} placeholder in the backend's success_url.
      const sid = sp.get("session_id")
      if (sid) sessionStorage.setItem("deposit_sessionId", sid)

      // Only start polling if we have a session ID to check.
      const sessionId = sessionStorage.getItem("deposit_sessionId")
      const walletId = sessionStorage.getItem("deposit_walletId")
      if (sessionId && walletId) {
        setProcessingPayment(true)
        checkDeposit()
        pollTimer.current = setInterval(checkDeposit, 2000)
        // Timeout after 60 seconds — webhook should fire by then.
        setTimeout(() => {
          clearInterval(pollTimer.current)
          setProcessingPayment(false)
          toast(
            "Payment received. Your wallet is still being updated. Refresh this page shortly.",
          )
        }, 60000)
      }
      // No sessionId + walletId = stale URL → just show billing page.
    }

    return () => clearInterval(pollTimer.current)
    // biome-ignore lint/correctness/useExhaustiveDependencies: router is used inside checkDeposit, not directly here
  }, [setValue, checkDeposit])

  const depositMutation = useMutation({
    mutationFn: async (amount: number) => {
      if (!walletData?.id) throw new Error("Wallet not loaded")
      const session = await api.billing.createCheckoutSession({
        walletId: walletData.id,
        amount,
      })
      if (session?.url) {
        // Preserve returnTo and expected amount through Stripe redirect cycle
        sessionStorage.setItem("deposit_expectedAmount", String(amount))
        sessionStorage.setItem("deposit_timestamp", String(Date.now()))
        sessionStorage.setItem("deposit_walletId", walletData!.id)
        if (returnTo) {
          sessionStorage.setItem("deposit_returnTo", returnTo)
        }
        window.location.href = session.url
      } else {
        throw new Error("No checkout URL returned")
      }
    },
    onError: () => {
      toast.error("Failed to initiate deposit")
    },
  })

  const filteredTransactions = (transactionsData ?? []).filter(
    (tx: Transaction) => {
      if (!searchQuery) return true
      const query = searchQuery.toLowerCase()
      return (
        tx.id.toLowerCase().includes(query) ||
        tx.type.toLowerCase().includes(query) ||
        tx.description?.toLowerCase().includes(query)
      )
    },
  )

  const totalDeposits = (transactionsData ?? [])
    .filter((tx: Transaction) => tx.type === "DEPOSIT")
    .reduce((sum: number, tx: Transaction) => sum + Number(tx.amount), 0)

  const _totalSpent = (transactionsData ?? [])
    .filter(
      (tx: Transaction) => tx.type === "PURCHASE" || tx.type === "RESERVATION",
    )
    .reduce(
      (sum: number, tx: Transaction) => sum + Math.abs(Number(tx.amount)),
      0,
    )

  // Combine errors from all queries
  const billingError = walletError || transactionsError || ordersError

  if (processingPayment) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <h2 className="text-xl font-semibold">Processing your payment…</h2>
        <p className="text-muted-foreground text-sm max-w-md text-center">
          Your payment was successful. We&apos;re waiting for the confirmation
          to credit your wallet. This usually takes a few seconds.
        </p>
      </div>
    )
  }

  if (billingError) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold tracking-tight">Billing</h1>
        </div>
        <ErrorState
          title="Something went wrong"
          description={(billingError as Error).message}
          onRetry={() => {
            refetchWallet()
            refetchTransactions()
            refetchOrders()
          }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Billing</h1>
          <p className="text-muted-foreground">
            Manage your wallet and payments
          </p>
        </div>
        <Button onClick={() => setShowDepositDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Deposit Funds
        </Button>
      </div>

      {/* Wallet Cards */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        {walletLoading ? (
          <>
            <WalletSkeleton />
            <WalletSkeleton />
            <WalletSkeleton />
            <WalletSkeleton />
          </>
        ) : walletData ? (
          <>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Available Balance
                </CardTitle>
                <Wallet className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold font-mono">
                  ${Number(walletData.availableBalance).toFixed(2)}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Ready to spend
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Reserved Balance
                </CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold font-mono">
                  ${reservedBalance.toFixed(2)}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  In pending orders
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Deposited
                </CardTitle>
                <CreditCard className="h-4 w-4 text-muted-foreground" />
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

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Version
                </CardTitle>
                <FileText className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold font-mono">
                  {walletData.version}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Optimistic lock counter
                </p>
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>

      {/* Transactions */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>Transaction History</CardTitle>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search transactions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          <CardDescription>
            All wallet activity, including deposits, payments, and refunds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {transactionsLoading ? (
            <TransactionsSkeleton />
          ) : filteredTransactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Wallet className="h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No transactions</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {searchQuery
                  ? "No transactions match your search."
                  : "Deposit funds to get started."}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredTransactions.map((tx: Transaction) => {
                const Icon = transactionIcons[tx.type] || FileText
                const colorClass = transactionColors[tx.type] || ""
                const isNegative =
                  tx.type === "PURCHASE" ||
                  tx.type === "RESERVATION" ||
                  tx.type === "WITHDRAWAL"
                return (
                  <div
                    key={tx.id}
                    className="flex items-center gap-4 rounded-lg border p-4"
                  >
                    <div className={`${colorClass}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium capitalize">
                        {tx.type.toLowerCase().replace(/_/g, " ")}
                        {tx.reference && (
                          <span className="ml-1 text-xs text-muted-foreground font-mono">
                            #{tx.reference}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {tx.description || (
                          <span className="italic">No description</span>
                        )}
                      </p>
                    </div>
                    <div className="text-right">
                      <p
                        className={`text-sm font-mono font-medium ${
                          isNegative ? "text-red-600" : "text-emerald-600"
                        }`}
                      >
                        {isNegative ? "-" : "+"}$
                        {Math.abs(Number(tx.amount)).toFixed(2)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(tx.createdAt), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Deposit Dialog */}
      <Dialog open={showDepositDialog} onOpenChange={setShowDepositDialog}>
        <DialogContent className="sm:max-w-[400px]">
          <form
            onSubmit={handleSubmit((data) =>
              depositMutation.mutate(data.amount),
            )}
          >
            <DialogHeader>
              <DialogTitle>Deposit Funds</DialogTitle>
              <DialogDescription>
                Add funds to your wallet. This will redirect to our secure
                payment provider.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="amount">Amount (USD)</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="amount"
                    type="number"
                    step="0.01"
                    min="1"
                    placeholder="0.00"
                    className="pl-7"
                    {...register("amount", { valueAsNumber: true })}
                  />
                </div>
                {errors.amount && (
                  <p className="text-sm text-destructive">
                    {errors.amount.message}
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                {[50, 100, 250, 500].map((amt) => (
                  <Button
                    key={amt}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      setValue("amount", amt, { shouldValidate: true })
                    }}
                  >
                    ${amt}
                  </Button>
                ))}
              </div>

              <div className="rounded-lg bg-muted p-4 text-sm">
                <p className="font-medium">Secure payment powered by Stripe</p>
                <p className="mt-1 text-muted-foreground">
                  Your payment information is encrypted and never stored on our
                  servers.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowDepositDialog(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={depositMutation.isPending}>
                {depositMutation.isPending
                  ? "Processing..."
                  : "Continue to Payment"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
