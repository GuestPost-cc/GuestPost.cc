"use client"

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, ArrowLeft, ExternalLink, Wallet } from "lucide-react"
import Link from "next/link"
import { use } from "react"
import { toast } from "sonner"
import { api } from "../../../../../lib/api"
import { useAuth } from "../../../../../lib/auth"
import {
  customerCanMutateOrder,
  formatCustomerMoney,
} from "../../../../../lib/customer-order-workflow"

export default function CheckoutPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const resolvedParams = use(params)
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const { data: order, isLoading: orderLoading } = useQuery({
    queryKey: ["order", resolvedParams.id],
    queryFn: () => api.orders.getById(resolvedParams.id),
  })

  const { data: wallet, isLoading: walletLoading } = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.billing.getWallet(),
  })

  const { mutate: proceedToPayment, isPending: isProcessing } = useMutation({
    mutationFn: () => api.orders.submitPayment(resolvedParams.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer-orders"] })
      queryClient.invalidateQueries({
        queryKey: ["order", resolvedParams.id],
      })
      queryClient.invalidateQueries({ queryKey: ["wallet"] })
      toast.success("Payment submitted successfully")
      window.location.href = `/dashboard/orders/${resolvedParams.id}`
    },
    onError: (err: any) => toast.error(err?.message || "Payment failed"),
  })

  if (orderLoading || walletLoading) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/orders">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Orders
          </Link>
        </Button>
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-48 w-full" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <h2 className="mt-4 text-xl font-semibold">Order Not Found</h2>
        <Button className="mt-4" asChild>
          <Link href="/dashboard/orders">View All Orders</Link>
        </Button>
      </div>
    )
  }

  const amount = order.totalAmount || 0
  const balance = Number((wallet as any)?.availableBalance ?? 0)
  const reserved = Number((wallet as any)?.reservedBalance ?? 0)
  const hasSufficientBalance = balance >= amount
  const canPay = customerCanMutateOrder(order, user)
  const postPaymentBalance = Math.max(0, balance - amount)

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/dashboard/orders">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Checkout</h1>
          <p className="text-sm text-muted-foreground">
            Review and pay for order #{order.id.slice(0, 8)}
          </p>
        </div>
      </div>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle>Order Summary</CardTitle>
          <CardDescription>Details of your order</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Service Type</p>
              <p className="font-medium capitalize">
                {order.items?.[0]?.serviceType
                  ?.replace(/_/g, " ")
                  .toLowerCase() ?? "—"}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Website</p>
              <p className="font-medium">
                {order.items?.[0]?.website?.url ? (
                  <a
                    href={order.items[0].website.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-primary hover:underline"
                  >
                    {new URL(order.items[0].website.url).hostname}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  "—"
                )}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Topic</p>
              <p className="font-medium">{order.items?.[0]?.topic || "—"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Status</p>
              <Badge variant="secondary" className="capitalize">
                {order.status.replace(/_/g, " ").toLowerCase()}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle>Payment</CardTitle>
          <CardDescription>Pay using your wallet balance</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3 rounded-2xl border bg-muted/20 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Order Total</span>
              <span className="text-xl font-bold font-mono">
                {formatCustomerMoney(amount, order.currency)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Wallet className="h-4 w-4" />
                Available Balance
              </span>
              <span className="font-medium font-mono">
                {formatCustomerMoney(balance, order.currency)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Currently Reserved
              </span>
              <span className="font-medium font-mono">
                {formatCustomerMoney(reserved, order.currency)}
              </span>
            </div>
            <div className="border-t pt-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Amount to Deduct</span>
                <span
                  className={`text-lg font-bold font-mono ${hasSufficientBalance ? "text-primary" : "text-destructive"}`}
                >
                  {formatCustomerMoney(amount, order.currency)}
                </span>
              </div>
            </div>
            {hasSufficientBalance && (
              <div className="flex items-center justify-between border-t pt-3">
                <span className="text-sm font-medium">
                  Balance After Payment
                </span>
                <span className="font-semibold font-mono">
                  {formatCustomerMoney(postPaymentBalance, order.currency)}
                </span>
              </div>
            )}
          </div>

          {!hasSufficientBalance && (
            <div className="flex items-start gap-3 rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Insufficient Balance</p>
                <p className="mt-1 text-amber-700">
                  You need{" "}
                  {formatCustomerMoney(amount - balance, order.currency)} more.{" "}
                  {user?.customerRole === "OWNER"
                    ? "Deposit the difference to continue."
                    : "Ask an organization owner to add funds."}
                </p>
              </div>
            </div>
          )}

          {!canPay && (
            <div className="flex items-start gap-3 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium text-foreground">
                  Payment permission required
                </p>
                <p className="mt-1">
                  Only an organization owner or the member who created this
                  draft can submit its payment.
                </p>
              </div>
            </div>
          )}

          <div className="flex gap-3">
            {user?.customerRole === "OWNER" && (
              <Button
                variant={hasSufficientBalance ? "outline" : "default"}
                className="flex-1"
                asChild
              >
                <Link
                  href={
                    hasSufficientBalance
                      ? "/dashboard/billing"
                      : `/dashboard/billing?deposit=${Math.ceil(amount - balance)}&returnTo=${encodeURIComponent(`/dashboard/orders/checkout/${resolvedParams.id}`)}`
                  }
                >
                  {hasSufficientBalance
                    ? "Deposit More"
                    : `Deposit ${formatCustomerMoney(Math.ceil(amount - balance), order.currency)} to continue`}
                </Link>
              </Button>
            )}
            {hasSufficientBalance && canPay && (
              <Button
                className="flex-1"
                disabled={isProcessing || order?.status !== "DRAFT"}
                onClick={() => proceedToPayment()}
              >
                {isProcessing ? "Processing..." : "Pay Now"}
              </Button>
            )}
          </div>

          {order.status !== "DRAFT" && (
            <p className="text-center text-sm text-muted-foreground">
              This order has already been submitted for payment.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
