"use client"

import { useQuery } from "@tanstack/react-query"
import { api } from "../../lib/api"
import { useAuth } from "../../lib/auth"
import { Card, CardContent, CardHeader, CardTitle } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import {
  Clock,
  CheckCircle2,
  DollarSign,
  Wallet,
  TrendingUp,
  RefreshCw,
} from "lucide-react"
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
} from "recharts"
import { toast } from "sonner"

const kpiConfig = [
  { key: "pending", label: "Pending Orders", icon: Clock, color: "text-amber-500" },
  { key: "active", label: "Active Orders", icon: RefreshCw, color: "text-blue-500" },
  { key: "withdrawable", label: "Withdrawable", icon: Wallet, color: "text-emerald-500" },
  { key: "lifetime", label: "Lifetime Earnings", icon: TrendingUp, color: "text-purple-500" },
]

const mockChartData = [
  { month: "Jan", earnings: 2400 },
  { month: "Feb", earnings: 1398 },
  { month: "Mar", earnings: 9800 },
  { month: "Apr", earnings: 3908 },
  { month: "May", earnings: 4800 },
  { month: "Jun", earnings: 3800 },
]

const mockOrdersData = [
  { month: "Jan", orders: 12 },
  { month: "Feb", orders: 19 },
  { month: "Mar", orders: 8 },
  { month: "Apr", orders: 24 },
  { month: "May", orders: 32 },
  { month: "Jun", orders: 18 },
]

function KPICard({
  label,
  value,
  icon: Icon,
  color,
  loading,
}: {
  label: string
  value: string
  icon: React.ElementType
  color: string
  loading?: boolean
}) {
  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-8 rounded-full" />
          </div>
          <Skeleton className="mt-3 h-8 w-32" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{label}</p>
          <Icon className={`h-5 w-5 ${color}`} />
        </div>
        <p className="mt-2 text-3xl font-bold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  )
}

function ChartCard({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export default function DashboardPage() {
  const { user } = useAuth()
  const { data: balance, isLoading, error, refetch } = useQuery({
    queryKey: ["publisher-balance", user?.publisherId],
    queryFn: () => api.publisherPayouts.getBalance(user!.publisherId!),
    enabled: !!user?.publisherId,
  })

  const { data: orders = [] } = useQuery({
    queryKey: ["publisher-orders"],
    queryFn: () => api.orders.list(),
  })

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <div className="text-center">
          <p className="text-lg font-medium">Failed to load dashboard</p>
          <p className="text-sm text-muted-foreground">Please try again later</p>
          <button
            onClick={() => refetch()}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      </div>
    )
  }

  const pendingOrders = orders.filter(
    (o) => o.status === "PENDING_PAYMENT" || o.status === "PAID" || o.status === "ASSIGNED"
  ).length
  const activeOrders = orders.filter(
    (o) =>
      o.status === "CONTENT_CREATION" ||
      o.status === "OUTREACH" ||
      o.status === "UNDER_REVIEW"
  ).length

  const withdrawable = balance
    ? `$${Number(balance.withdrawableAmount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "$0.00"
  const lifetime = balance
    ? `$${Number(balance.lifetimeEarned).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "$0.00"

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Welcome back! Here&apos;s your overview.</p>
        </div>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label="Pending Orders"
          value={isLoading ? "—" : String(pendingOrders)}
          icon={Clock}
          color="text-amber-500"
          loading={isLoading}
        />
        <KPICard
          label="Active Orders"
          value={isLoading ? "—" : String(activeOrders)}
          icon={RefreshCw}
          color="text-blue-500"
          loading={isLoading}
        />
        <KPICard
          label="Withdrawable"
          value={withdrawable}
          icon={Wallet}
          color="text-emerald-500"
          loading={isLoading}
        />
        <KPICard
          label="Lifetime Earnings"
          value={lifetime}
          icon={TrendingUp}
          color="text-purple-500"
          loading={isLoading}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Earnings Overview">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={mockChartData}>
                <defs>
                  <linearGradient id="colorEarnings" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="currentColor" stopOpacity={0.1} />
                    <stop offset="95%" stopColor="currentColor" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="month" className="text-xs" tick={{ fontSize: 12 }} />
                <YAxis className="text-xs" tick={{ fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="earnings"
                  stroke="hsl(var(--primary))"
                  fillOpacity={1}
                  fill="url(#colorEarnings)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Orders Volume">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={mockOrdersData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="month" className="text-xs" tick={{ fontSize: 12 }} />
                <YAxis className="text-xs" tick={{ fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Bar
                  dataKey="orders"
                  fill="hsl(var(--primary))"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium">Recent Orders</CardTitle>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <CheckCircle2 className="mb-3 h-10 w-10 text-muted-foreground/50" />
              <p className="font-medium">No orders yet</p>
              <p className="text-sm text-muted-foreground">Orders will appear here when assigned to you</p>
            </div>
          ) : (
            <div className="space-y-3">
              {orders.slice(0, 5).map((order) => (
                <div
                  key={order.id}
                  className="flex items-center justify-between rounded-lg border p-4"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <CheckCircle2 className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="font-medium">
                        {order.items[0]?.serviceType?.replace(/_/g, " ") ?? "Order"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {order.items[0]?.website?.url ?? "No website"}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <Badge
                      variant={
                        order.status === "PUBLISHED"
                          ? "success"
                          : order.status === "CONTENT_CREATION"
                          ? "info"
                          : "secondary"
                      }
                    >
                      {order.status.replace(/_/g, " ")}
                    </Badge>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {order.totalAmount
                        ? `$${Number(order.totalAmount).toFixed(2)}`
                        : "—"}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}