"use client"

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
  ArrowUpRight,
  Building2,
  CheckCircle,
  Clock,
  CreditCard,
  Plus,
  RefreshCw,
  Wallet,
  XCircle,
} from "lucide-react"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

// Full WithdrawalStatus enum — FAILED (provider hard-failure) and REVERSED
// (funds returned after failure) were missing and crashed the table
type WithdrawalStatus =
  | "PENDING"
  | "APPROVED"
  | "PROCESSING"
  | "COMPLETED"
  | "REJECTED"
  | "FAILED"
  | "REVERSED"

const statusConfig: Record<
  WithdrawalStatus,
  {
    label: string
    icon: React.ElementType
    variant:
      | "default"
      | "secondary"
      | "success"
      | "destructive"
      | "warning"
      | "outline"
  }
> = {
  PENDING: { label: "Pending", icon: Clock, variant: "warning" },
  APPROVED: { label: "Approved", icon: CheckCircle, variant: "secondary" },
  COMPLETED: { label: "Completed", icon: CheckCircle, variant: "success" },
  PROCESSING: { label: "Processing", icon: Clock, variant: "secondary" },
  REJECTED: { label: "Rejected", icon: XCircle, variant: "destructive" },
  FAILED: { label: "Failed", icon: XCircle, variant: "destructive" },
  REVERSED: {
    label: "Reversed — funds returned",
    icon: CheckCircle,
    variant: "outline",
  },
}

// Unknown statuses must never crash the table
const fallbackStatus = {
  label: "Unknown",
  icon: Clock,
  variant: "outline" as const,
}

export default function WithdrawalsPage() {
  const { user } = useAuth()
  const [showRequestDialog, setShowRequestDialog] = useState(false)

  const requestSchema = z.object({
    amount: z.coerce.number().positive("Amount must be positive"),
  })

  type RequestFormData = z.infer<typeof requestSchema>

  const {
    register,
    handleSubmit: handleFormSubmit,
    setValue,
    formState: { errors },
    reset,
  } = useForm<RequestFormData>({
    resolver: zodResolver(requestSchema),
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
    data: withdrawalsRaw,
    isLoading: withdrawalsLoading,
    error: withdrawalsError,
    refetch: refetchWithdrawals,
  } = useQuery({
    queryKey: ["publisher-withdrawals"],
    queryFn: () => api.publisherPayouts.listWithdrawals(),
  })
  const withdrawals = withdrawalsRaw?.items ?? []

  const { data: payoutMethods } = useQuery({
    queryKey: ["payout-methods"],
    queryFn: () => api.publisherPayouts.listPayoutMethods(),
  })
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null)
  const defaultMethod =
    payoutMethods?.find((m) => m.isDefault) ?? payoutMethods?.[0]
  const activeMethodId = selectedMethodId ?? defaultMethod?.id

  const requestMutation = useMutation({
    mutationFn: (data: {
      amount: number
      payoutMethodId?: string
      method?: string
    }) => api.publisherPayouts.requestWithdrawal(data),
    onSuccess: () => {
      toast.success("Withdrawal requested successfully")
      setShowRequestDialog(false)
      reset()
      refetch()
      refetchWithdrawals()
    },
    onError: (err: any) => {
      toast.error(err?.message ?? "Failed to request withdrawal")
    },
  })

  const handleRequest = (data: RequestFormData) => {
    if (balance && data.amount > balance.withdrawableBalance) {
      toast.error("Amount exceeds withdrawable balance")
      return
    }
    const method = payoutMethods?.find((m) => m.id === activeMethodId)
    requestMutation.mutate({
      amount: data.amount,
      payoutMethodId: activeMethodId ?? undefined,
      method: method?.type ?? "bank_transfer",
    })
  }

  const withdrawableAmount = balance ? Number(balance.withdrawableBalance) : 0

  const withdrawError = error ?? withdrawalsError
  if (withdrawError)
    return (
      <ErrorState
        title="Failed to load withdrawals"
        description={(withdrawError as Error).message}
        onRetry={() => { refetch(); refetchWithdrawals(); }}
      />
    )

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
              <p className="text-sm text-muted-foreground">
                Available to Withdraw
              </p>
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
                    new Date(w.createdAt).getMonth() === new Date().getMonth(),
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
                  <TableHead>Method</TableHead>
                  <TableHead>Available</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {withdrawals.map((withdrawal) => {
                  const config =
                    statusConfig[withdrawal.status] ?? fallbackStatus
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
                        {withdrawal.payoutMethod?.label ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {withdrawal.availableAt
                          ? new Date(
                              withdrawal.availableAt,
                            ).toLocaleDateString()
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
              <div className="flex gap-2 pt-2">
                {[100, 250, 500].map((val) => (
                  <Button
                    key={val}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setValue("amount", val)}
                    disabled={val > withdrawableAmount}
                  >
                    ${val}
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
            <div className="space-y-2">
              <Label>Payout Method</Label>
              {!payoutMethods || payoutMethods.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No payout method on file — add one under{" "}
                  <a
                    href="/dashboard/payout-methods"
                    className="underline text-foreground"
                  >
                    Payout Methods
                  </a>{" "}
                  first.
                </p>
              ) : (
                <div className="space-y-2">
                  {payoutMethods.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setSelectedMethodId(m.id)}
                      className={`flex w-full items-center justify-between rounded-md border p-3 text-left text-sm transition-colors ${
                        activeMethodId === m.id
                          ? "border-primary bg-primary/5"
                          : "hover:bg-muted/50"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {m.type === "bank_transfer" ? (
                          <Building2 className="h-4 w-4" />
                        ) : (
                          <CreditCard className="h-4 w-4" />
                        )}
                        <span className="font-medium">{m.label}</span>
                        {m.isDefault && (
                          <Badge variant="outline">Default</Badge>
                        )}
                      </span>
                      <span className="text-muted-foreground">
                        {String(
                          m.displayDetails?.bankName ??
                            m.displayDetails?.maskedEmail ??
                            m.type,
                        )}
                        {m.displayDetails?.last4
                          ? ` ••••${m.displayDetails.last4}`
                          : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
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
              onClick={handleFormSubmit(handleRequest)}
              disabled={requestMutation.isPending}
            >
              {requestMutation.isPending
                ? "Processing..."
                : "Request Withdrawal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
