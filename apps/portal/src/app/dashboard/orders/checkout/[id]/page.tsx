"use client"

import { use } from "react"
import { useQuery, useMutation } from "@tanstack/react-query"
import { api } from "../../../../../lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { ArrowLeft, AlertCircle, Wallet, ExternalLink } from "lucide-react"
import { format } from "date-fns"
import Link from "next/link"
import { toast } from "sonner"
import { useState } from "react"

export default function CheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params)
  const [isProcessing, setIsProcessing] = useState(false)

  const { data: order, isLoading: orderLoading } = useQuery({
    queryKey: ["order", resolvedParams.id],
    queryFn: () => api.orders.getById(resolvedParams.id),
  })

  const { data: wallet, isLoading: walletLoading } = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.billing.getWallet(),
  })

  const proceedToPayment = async () => {
    setIsProcessing(true)
    try {
      const result = await api.orders.submitPayment(resolvedParams.id)
      toast.success("Payment submitted successfully")
      window.location.href = `/dashboard/orders/${resolvedParams.id}`
    } catch (err: any) {
      toast.error(err?.message || "Payment failed")
    } finally {
      setIsProcessing(false)
    }
  }

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
  const balance = (wallet as any)?.availableBalance ?? (wallet as any)?.balance ?? 0
  const hasSufficientBalance = balance >= amount

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
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

      <Card>
        <CardHeader>
          <CardTitle>Order Summary</CardTitle>
          <CardDescription>Details of your order</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Service Type</p>
              <p className="font-medium capitalize">
                {order.items?.[0]?.serviceType?.replace(/_/g, " ").toLowerCase() ?? "—"}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Website</p>
              <p className="font-medium">
                {order.items?.[0]?.website?.url ? (
                  <a href={order.items[0].website.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                    {new URL(order.items[0].website.url).hostname}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : "—"}
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

      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
          <CardDescription>Pay using your wallet balance</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Order Total</span>
              <span className="text-xl font-bold font-mono">${amount.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Wallet className="h-4 w-4" />
                Available Balance
              </span>
              <span className="font-medium font-mono">${(balance ?? 0).toFixed(2)}</span>
            </div>
            <div className="border-t pt-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Amount to Deduct</span>
                <span className={`text-lg font-bold font-mono ${hasSufficientBalance ? "text-primary" : "text-destructive"}`}>
                  ${amount.toFixed(2)}
                </span>
              </div>
            </div>
          </div>

          {!hasSufficientBalance && (
            <div className="flex items-start gap-3 rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Insufficient Balance</p>
                <p className="mt-1 text-amber-700">
                  You need ${(amount - balance).toFixed(2)} more. Please deposit funds first.
                </p>
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" asChild>
              <Link href="/dashboard/billing">
                {hasSufficientBalance ? "Deposit More" : "Deposit Funds"}
              </Link>
            </Button>
            <Button
              className="flex-1"
              disabled={!hasSufficientBalance || isProcessing || order.status !== "DRAFT"}
              onClick={proceedToPayment}
            >
              {isProcessing ? "Processing..." : "Pay Now"}
            </Button>
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