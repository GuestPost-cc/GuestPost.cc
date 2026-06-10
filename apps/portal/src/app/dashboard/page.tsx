"use client"

import { useQuery } from "@tanstack/react-query"
import { api } from "../../lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@guestpost/ui"
import { Skeleton, ErrorState } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import {
  Wallet,
  PiggyBank,
  ShoppingCart,
  CheckCircle,
  Clock,
  TrendingUp,
  Plus,
  ArrowRight,
  FileText,
  CreditCard,
  AlertCircle,
} from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import Link from "next/link"
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from "recharts"

const ORDER_STATUS_COLORS: Record<string, string> = {
  PENDING_PAYMENT: "#f59e0b",
  PAID: "#3b82f6",
  ASSIGNED: "#8b5cf6",
  CONTENT_CREATION: "#06b6d4",
  OUTREACH: "#ec4899",
  PUBLISHED: "#22c55e",
  UNDER_REVIEW: "#f97316",
  COMPLETED: "#10b981",
  CANCELLED: "#ef4444",
  REFUNDED: "#6b7280",
}

function KPICard({
  title,
  value,
  description,
  icon: Icon,
  trend,
  trendLabel,
}: {
  title: string
  value: string | number
  description?: string
  icon: React.ElementType
  trend?: number
  trendLabel?: string
}) {
  return (
    <Card className="relative overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold">{value}</div>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
        {trend !== undefined && (
          <div className="mt-2 flex items-center gap-1">
            <span className={`flex items-center text-xs font-medium ${trend >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              <TrendingUp className={`h-3 w-3 ${trend < 0 ? "rotate-180" : ""}`} />
              {Math.abs(trend)}%
            </span>
            <span className="text-xs text-muted-foreground">{trendLabel}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ChartCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <Card className="col-span-1">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function RecentOrdersSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex items-center justify-between rounded-lg border p-3">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      ))}
    </div>
  )
}

function KPICardsSkeleton() {
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {[...Array(6)].map((_, i) => (
        <Card key={i}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-10 rounded-lg" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export default function DashboardPage() {
  const { data: walletData, isLoading: walletLoading, error: walletError, refetch: refetchWallet } = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.billing.getWallet(),
  })

  const { data: ordersData, isLoading: ordersLoading, error: ordersError, refetch: refetchOrders } = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.orders.list(),
  })

  const { data: campaignsData, isLoading: campaignsLoading, error: campaignsError, refetch: refetchCampaigns } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api.campaigns.listCampaigns(),
  })

  const orders = ordersData ?? []
  const campaigns = campaignsData ?? []

  const activeOrders = orders.filter((o: any) => !["COMPLETED", "CANCELLED", "REFUNDED"].includes(o.status)).length
  const underReviewOrders = orders.filter((o: any) => o.status === "UNDER_REVIEW").length
  const completedOrders = orders.filter((o: any) => o.status === "COMPLETED").length

  const reservedBalance = orders
    .filter((o: any) => !["COMPLETED", "CANCELLED", "REFUNDED"].includes(o.status))
    .reduce((sum: number, o: any) => sum + (o.totalAmount || 0), 0)

  const now = new Date()
  const currentMonth = now.getMonth()
  const currentYear = now.getFullYear()
  const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1
  const lastMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear

  const monthlySpend = orders
    .filter((o: any) => {
      const created = new Date(o.createdAt)
      return created.getMonth() === currentMonth && created.getFullYear() === currentYear
    })
    .reduce((sum: number, o: any) => sum + (o.totalAmount || 0), 0)

  const lastMonthSpend = orders
    .filter((o: any) => {
      const created = new Date(o.createdAt)
      return created.getMonth() === lastMonth && created.getFullYear() === lastMonthYear
    })
    .reduce((sum: number, o: any) => sum + (o.totalAmount || 0), 0)

  const spendTrend = lastMonthSpend > 0
    ? Math.round(((monthlySpend - lastMonthSpend) / lastMonthSpend) * 100)
    : monthlySpend > 0 ? 100 : 0

  const monthlyData = Array.from({ length: 6 }, (_, i) => {
    const d = new Date()
    d.setMonth(d.getMonth() - (5 - i))
    return {
      month: format(d, "MMM"),
      orders: orders.filter((o: any) => {
        const created = new Date(o.createdAt)
        return created.getMonth() === d.getMonth() && created.getFullYear() === d.getFullYear()
      }).length,
      spend: orders
        .filter((o: any) => {
          const created = new Date(o.createdAt)
          return created.getMonth() === d.getMonth() && created.getFullYear() === d.getFullYear()
        })
        .reduce((sum: number, o: any) => sum + (o.totalAmount || 0), 0),
    }
  })

  const statusDistribution = Object.entries(
    orders.reduce((acc: Record<string, number>, o: any) => {
      acc[o.status] = (acc[o.status] || 0) + 1
      return acc
    }, {}) as Record<string, number>
  ).map(([name, value]) => ({ name, value }))

  const activityFeed = orders
    .flatMap((o: any) =>
      (o.events || []).map((e: any) => ({
        id: e.id,
        orderId: o.id,
        eventType: e.eventType,
        createdAt: e.createdAt,
        metadata: e.metadata,
      }))
    )
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10)

  const recentOrders = [...orders]
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5)

  const dashboardError = walletError || ordersError || campaignsError

  if (dashboardError) {
    return <ErrorState title="Failed to load dashboard" description={(dashboardError as Error).message} onRetry={() => { refetchWallet(); refetchOrders(); refetchCampaigns(); }} />
  }

  const isLoading = walletLoading || ordersLoading || campaignsLoading

  if (isLoading) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground">Welcome back! Here&apos;s your overview.</p>
          </div>
        </div>
        <KPICardsSkeleton />
        <div className="grid gap-6 lg:grid-cols-2">
          <Card><CardContent className="pt-6"><Skeleton className="h-64 w-full" /></CardContent></Card>
          <Card><CardContent className="pt-6"><Skeleton className="h-64 w-full" /></CardContent></Card>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">Welcome back! Here&apos;s your overview.</p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" asChild>
            <Link href="/dashboard/reports">
              <FileText className="mr-2 h-4 w-4" />
              View Reports
            </Link>
          </Button>
          <Button asChild>
            <Link href="/dashboard/orders/new">
              <Plus className="mr-2 h-4 w-4" />
              New Order
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KPICard
          title="Wallet Balance"
          value={`$${Number(walletData?.availableBalance ?? 0).toFixed(2)}`}
          description="Available funds"
          icon={Wallet}
        />
        <KPICard
          title="Reserved"
          value={`$${reservedBalance.toFixed(2)}`}
          description="In progress orders"
          icon={PiggyBank}
        />
        <KPICard
          title="Active Orders"
          value={activeOrders}
          description="In progress"
          icon={ShoppingCart}
        />
        <KPICard
          title="Under Review"
          value={underReviewOrders}
          description="Awaiting approval"
          icon={Clock}
        />
        <KPICard
          title="Completed"
          value={completedOrders}
          description="All time"
          icon={CheckCircle}
        />
        <KPICard
          title="Monthly Spend"
          value={`$${monthlySpend.toFixed(2)}`}
          description={format(new Date(), "MMMM yyyy")}
          icon={CreditCard}
          trend={spendTrend}
          trendLabel="vs last month"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Orders & Spend" description="Last 6 months">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={monthlyData}>
                <defs>
                  <linearGradient id="colorOrders" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorSpend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="month" className="text-xs" />
                <YAxis className="text-xs" />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: "hsl(var(--card))", 
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="orders"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorOrders)"
                  name="Orders"
                />
                <Area
                  type="monotone"
                  dataKey="spend"
                  stroke="#22c55e"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorSpend)"
                  name="Spend"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Order Status" description="Distribution by status">
          <div className="flex h-72 items-center gap-8">
            <div className="h-52 w-52">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusDistribution}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {statusDistribution.map((entry, index) => (
                      <Cell 
                        key={`cell-${index}`} 
                        fill={ORDER_STATUS_COLORS[entry.name] || "#6b7280"} 
                      />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: "hsl(var(--card))", 
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-1 space-y-2">
              {statusDistribution.slice(0, 5).map((item) => (
                <div key={item.name} className="flex items-center gap-2">
                  <div 
                    className="h-3 w-3 rounded-full" 
                    style={{ backgroundColor: ORDER_STATUS_COLORS[item.name] || "#6b7280" }}
                  />
                  <span className="flex-1 text-sm text-muted-foreground">
                    {item.name.replace(/_/g, " ")}
                  </span>
                  <span className="text-sm font-medium">{item.value}</span>
                </div>
              ))}
              {statusDistribution.length > 5 && (
                <p className="text-xs text-muted-foreground">
                  +{statusDistribution.length - 5} more
                </p>
              )}
            </div>
          </div>
        </ChartCard>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Recent Orders</CardTitle>
              <CardDescription>Latest orders across all campaigns</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/dashboard/orders">
                View all <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {recentOrders.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <ShoppingCart className="h-12 w-12 text-muted-foreground/50" />
                <h3 className="mt-4 text-lg font-medium">No orders yet</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Create your first order to get started
                </p>
                <Button className="mt-4" asChild>
                  <Link href="/dashboard/orders/new">
                    <Plus className="mr-2 h-4 w-4" />
                    New Order
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
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentOrders.map((order: any) => (
                    <TableRow key={order.id} className="cursor-pointer hover:bg-muted/50">
                      <TableCell className="font-mono text-xs">
                        <Link href={`/dashboard/orders/${order.id}`} className="hover:text-primary">
                          #{order.id.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {order.items?.[0]?.serviceType?.replace(/_/g, " ") ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge 
                          variant={order.status === "COMPLETED" ? "default" : "secondary"}
                          className="capitalize"
                        >
                          {order.status.replace(/_/g, " ").toLowerCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {order.totalAmount ? `$${order.totalAmount.toFixed(2)}` : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(order.createdAt), "PP")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
            <CardDescription>Recent order updates</CardDescription>
          </CardHeader>
          <CardContent>
            {activityFeed.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Clock className="h-8 w-8 text-muted-foreground/50" />
                <p className="mt-2 text-sm text-muted-foreground">No recent activity</p>
              </div>
            ) : (
              <div className="space-y-4">
                {activityFeed.slice(0, 8).map((event: any) => (
                  <div key={event.id} className="flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <FileText className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1 space-y-1">
                      <p className="text-sm">
                        <span className="font-medium">
                          {event.eventType.replace(/_/g, " ").toLowerCase()}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          for #{event.orderId?.slice(0, 8)}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(event.createdAt), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}