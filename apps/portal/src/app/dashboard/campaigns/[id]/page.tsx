"use client"

import { use } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../../lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
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
  ArrowLeft,
  Plus,
  Eye,
  FileText,
  Megaphone,
  AlertCircle,
} from "lucide-react"
import { format } from "date-fns"
import Link from "next/link"

interface Campaign {
  id: string
  name: string
  status: string
  createdAt: string
  updatedAt: string
}

interface Order {
  id: string
  status: string
  items: Array<{
    serviceType: string
    topic: string | null
  }>
  totalAmount: number | null
  createdAt: string
}

const statusColors: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-700",
  PAUSED: "bg-amber-100 text-amber-700",
  COMPLETED: "bg-blue-100 text-blue-700",
  ARCHIVED: "bg-gray-100 text-gray-500",
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
          <Card><CardContent className="pt-6"><Skeleton className="h-64 w-full" /></CardContent></Card>
        </div>
        <Card><CardContent className="pt-6"><Skeleton className="h-48 w-full" /></CardContent></Card>
      </div>
    </div>
  )
}

export default function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params)

  const { data: campaignsData, isLoading: campaignsLoading } = useQuery<Campaign[]>({
    queryKey: ["campaigns"],
    queryFn: () => api.campaigns.listCampaigns() as Promise<Campaign[]>,
  })

  const { data: ordersData, isLoading: ordersLoading } = useQuery<Order[]>({
    queryKey: ["orders"],
    queryFn: () => api.orders.list() as Promise<Order[]>,
  })

  const isLoading = campaignsLoading || ordersLoading

  const campaign = campaignsData?.find((c: Campaign) => c.id === resolvedParams.id)
  const campaignOrders = ordersData?.filter((o: Order) => {
    const order = o as any
    return order.campaignId === resolvedParams.id
  }) ?? []

  const activeOrders = campaignOrders.filter((o: Order) => !["COMPLETED", "CANCELLED"].includes(o.status)).length
  const completedOrders = campaignOrders.filter((o: Order) => o.status === "COMPLETED").length
  const totalSpend = campaignOrders.reduce((sum: number, o: Order) => sum + (o.totalAmount || 0), 0)

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
          The campaign you&apos;re looking for doesn&apos;t exist or you don&apos;t have access to it.
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
              <h1 className="text-2xl font-bold tracking-tight">{campaign.name}</h1>
              <Badge className={`${statusColors[campaign.status] || "bg-gray-100 text-gray-700"} capitalize`}>
                {campaign.status.toLowerCase()}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Created {format(new Date(campaign.createdAt), "PP")}
            </p>
          </div>
        </div>

        <Button asChild>
          <Link href={`/dashboard/orders/new?campaign=${campaign.id}`}>
            <Plus className="mr-2 h-4 w-4" />
            Add Order
          </Link>
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Orders</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{campaignOrders.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Orders</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeOrders}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Completed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{completedOrders}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Spend</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">${totalSpend.toFixed(2)}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Campaign Orders</CardTitle>
              <CardDescription>Orders associated with this campaign</CardDescription>
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
                <Link href={`/dashboard/orders/new?campaign=${campaign.id}`}>
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
                {campaignOrders.map((order: Order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-mono text-xs">
                      <Link href={`/dashboard/orders/${order.id}`} className="hover:text-primary">
                        #{order.id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {order.items?.[0]?.serviceType?.replace(/_/g, " ") ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">
                        {order.status.replace(/_/g, " ").toLowerCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {order.totalAmount ? `$${order.totalAmount.toFixed(2)}` : "—"}
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
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}