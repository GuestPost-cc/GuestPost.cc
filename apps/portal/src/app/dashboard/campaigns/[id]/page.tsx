"use client"

import type { OrderResponse } from "@guestpost/api-client"
import type { CampaignStatus } from "@guestpost/database"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  getCampaignStatusPresentation,
  getOrderStatusPresentation,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import { format } from "date-fns"
import { AlertCircle, ArrowLeft, Eye, FileText, Plus } from "lucide-react"
import Link from "next/link"
import { use } from "react"
import { api } from "../../../../lib/api"
import { formatCustomerMoney } from "../../../../lib/customer-order-workflow"

async function listAllCampaignOrders(campaignId: string) {
  const orders: OrderResponse[] = []
  let skip = 0
  let total = Number.POSITIVE_INFINITY

  while (skip < total) {
    const page = await api.orders.listPaginated({
      campaignId,
      take: 100,
      skip,
    })
    orders.push(...page.items)
    total = page.total
    if (page.items.length === 0) break
    skip += page.items.length
  }

  return orders
}

function CampaignDetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10" />
        <Skeleton className="h-8 w-48" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardContent className="pt-6">
              <Skeleton className="h-64 w-full" />
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-48 w-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const resolvedParams = use(params)

  const {
    data: campaign,
    isLoading: campaignsLoading,
    error: campaignsError,
    refetch: refetchCampaigns,
  } = useQuery({
    queryKey: ["campaign", resolvedParams.id],
    queryFn: () => api.campaigns.getCampaign(resolvedParams.id),
  })

  const {
    data: campaignOrders = [],
    isLoading: ordersLoading,
    error: ordersError,
    refetch: refetchOrders,
  } = useQuery({
    queryKey: ["customer-orders", "campaign", resolvedParams.id],
    queryFn: () => listAllCampaignOrders(resolvedParams.id),
  })

  const campaignDetailError = campaignsError || ordersError

  if (campaignDetailError) {
    return (
      <ErrorState
        title="Failed to load campaign"
        description={(campaignDetailError as Error).message}
        onRetry={() => {
          refetchCampaigns()
          refetchOrders()
        }}
      />
    )
  }

  const isLoading = campaignsLoading || ordersLoading

  const activeOrders = campaignOrders.filter(
    (order: OrderResponse) =>
      !["COMPLETED", "CANCELLED", "REFUNDED", "SETTLED"].includes(order.status),
  ).length
  const completedOrders = campaignOrders.filter(
    (order: OrderResponse) => order.status === "COMPLETED",
  ).length
  const totalSpend = campaignOrders.reduce(
    (sum: number, order: OrderResponse) => sum + (order.totalAmount || 0),
    0,
  )

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/campaigns">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Campaigns
          </Link>
        </Button>
        <CampaignDetailSkeleton />
      </div>
    )
  }

  if (!campaign) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <h2 className="mt-4 text-xl font-semibold">Campaign Not Found</h2>
        <p className="mt-2 text-muted-foreground">
          The campaign you&apos;re looking for doesn&apos;t exist or you
          don&apos;t have access to it.
        </p>
        <Button className="mt-4" asChild>
          <Link href="/dashboard/campaigns">View All Campaigns</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/dashboard/campaigns">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">
                {campaign.name}
              </h1>
              {(() => {
                const p = getCampaignStatusPresentation(
                  campaign.status as CampaignStatus,
                )
                return <StatusBadge variant={p.variant}>{p.label}</StatusBadge>
              })()}
            </div>
            <p className="text-sm text-muted-foreground">
              Created {format(new Date(campaign.createdAt), "PP")}
            </p>
          </div>
        </div>

        <Button asChild>
          <Link
            href={`/dashboard/marketplace?campaignId=${encodeURIComponent(campaign.id)}`}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Order
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Orders
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{campaignOrders.length}</div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Active Orders
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeOrders}</div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Completed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{completedOrders}</div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Spend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">
              {formatCustomerMoney(totalSpend)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Campaign Orders</CardTitle>
              <CardDescription>
                Orders associated with this campaign
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {campaignOrders.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <FileText className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No orders yet</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Add your first order to this campaign
              </p>
              <Button className="mt-4" asChild>
                <Link
                  href={`/dashboard/marketplace?campaignId=${encodeURIComponent(campaign.id)}`}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add Order
                </Link>
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order ID</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaignOrders.map((order: OrderResponse) => {
                  const presentation = getOrderStatusPresentation(order.status)
                  return (
                    <TableRow key={order.id}>
                      <TableCell className="font-mono text-xs">
                        <Link
                          href={`/dashboard/orders/${order.id}`}
                          className="hover:text-primary"
                        >
                          #{order.id.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {order.items?.[0]?.serviceType?.replace(/_/g, " ") ??
                          "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge variant={presentation.variant}>
                          {presentation.label}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {order.totalAmount != null
                          ? formatCustomerMoney(
                              order.totalAmount,
                              order.currency,
                            )
                          : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(order.createdAt), "PP")}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/dashboard/orders/${order.id}`}>
                            <Eye className="h-4 w-4" />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
