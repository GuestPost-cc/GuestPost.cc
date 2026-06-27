"use client"

import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import {
  AlertCircle,
  Building2,
  Clock,
  CreditCard,
  DollarSign,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react"
import { api } from "../../lib/api"
import { useAuth } from "../../lib/auth"

interface Stats {
  revenue: number
  gmv: number
  activeOrders: number
  publishers: number
  customers: number
  pendingVerifications: number
  pendingWithdrawals: number
}

interface RecentOrder {
  id: string
  customer: { name: string | null; email: string } | null
  type: string
  status: string
  amount: number | null
  currency: string
  createdAt: string
}

const statusVariant = (status: string) => {
  switch (status) {
    case "COMPLETED":
    case "SETTLED":
    case "VERIFIED":
      return "default"
    case "PENDING_PAYMENT":
    case "PENDING":
      return "secondary"
    case "PUBLISHED":
      return "default"
    case "REJECTED":
    case "CANCELLED":
    case "REFUNDED":
      return "destructive"
    default:
      return "outline"
  }
}

function TrendIndicator({
  value,
  suffix = "",
}: {
  value: number
  suffix?: string
}) {
  if (value === 0) return null
  const isPositive = value > 0
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium ${
        isPositive ? "text-emerald-600" : "text-red-600"
      }`}
    >
      {isPositive ? (
        <TrendingUp className="h-3 w-3" />
      ) : (
        <TrendingDown className="h-3 w-3" />
      )}
      {isPositive ? "+" : ""}
      {value}
      {suffix}
    </span>
  )
}

function StatCard({
  title,
  value,
  icon: Icon,
  trend,
  trendSuffix,
  loading,
}: {
  title: string
  value: string | number
  icon: React.ElementType
  trend?: number
  trendSuffix?: string
  loading?: boolean
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <>
            <div className="text-2xl font-bold">{value}</div>
            {trend !== undefined && (
              <TrendIndicator value={trend} suffix={trendSuffix} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function KPICards({
  stats,
  loading,
}: {
  stats: Stats | undefined
  loading: boolean
}) {
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Revenue"
        value={stats ? `$${stats.revenue.toLocaleString()}` : "—"}
        icon={DollarSign}
        loading={loading}
      />
      <StatCard
        title="GMV"
        value={stats ? `$${stats.gmv.toLocaleString()}` : "—"}
        icon={ShoppingCart}
        loading={loading}
      />
      <StatCard
        title="Active Orders"
        value={stats?.activeOrders ?? "—"}
        icon={Clock}
        loading={loading}
      />
      <StatCard
        title="Publishers"
        value={stats?.publishers ?? "—"}
        icon={Users}
        loading={loading}
      />
      <StatCard
        title="Customers"
        value={stats?.customers ?? "—"}
        icon={Building2}
        loading={loading}
      />
      <StatCard
        title="Pending Verifications"
        value={stats?.pendingVerifications ?? "—"}
        icon={AlertCircle}
        loading={loading}
      />
      <StatCard
        title="Pending Withdrawals"
        value={stats?.pendingWithdrawals ?? "—"}
        icon={CreditCard}
        loading={loading}
      />
    </div>
  )
}

function RecentOrdersTable({
  orders,
  loading,
}: {
  orders: RecentOrder[]
  loading: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Orders</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : orders.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No recent orders
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.slice(0, 10).map((order) => (
                <TableRow key={order.id}>
                  <TableCell className="font-mono text-xs">
                    {order.id.slice(0, 8)}
                  </TableCell>
                  <TableCell>
                    {order.customer?.name ?? order.customer?.email ?? "—"}
                  </TableCell>
                  <TableCell className="capitalize">
                    {(order.type ?? "").replace(/_/g, " ").toLowerCase() || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(order.status) as any}>
                      {(order.status ?? "").replace(/_/g, " ") || "—"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {order.amount != null
                      ? `${order.currency} ${Number(order.amount).toFixed(2)}`
                      : "—"}
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
  )
}

function ActivityFeed() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "activity"],
    queryFn: () =>
      api.admin.listOrders().then((orders) =>
        orders.slice(0, 5).map((o) => ({
          id: o.id,
          message: `Order ${o.status.toLowerCase().replace(/_/g, " ")}`,
          time: o.createdAt,
        })),
      ),
    retry: 1,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : data?.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No recent activity
          </p>
        ) : (
          <div className="space-y-4">
            {data?.map(
              (item: { id: string; message: string; time: string }) => (
                <div key={item.id} className="flex items-center gap-3 text-sm">
                  <div className="h-2 w-2 rounded-full bg-primary" />
                  <span className="flex-1 capitalize">{item.message}</span>
                  <span className="text-muted-foreground">
                    {format(new Date(item.time), "p")}
                  </span>
                </div>
              ),
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function DashboardPage() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  // Settlements/withdrawals are SUPER_ADMIN/FINANCE backend routes — never
  // fetch them for OPERATIONS (was a 403 storm on the overview page)
  const canSeeFinance =
    user?.staffRole === "SUPER_ADMIN" || user?.staffRole === "FINANCE"

  const {
    data: usersData,
    isLoading: usersLoading,
    error: usersError,
  } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api.admin.listUsers(),
    retry: 1,
  })
  const users = usersData?.items

  const {
    data: orders,
    isLoading: ordersLoading,
    error: ordersError,
  } = useQuery({
    queryKey: ["admin", "orders"],
    queryFn: () => api.admin.listOrders(),
    retry: 1,
  })

  const {
    data: settlements,
    isLoading: settlementsLoading,
    error: settlementsError,
  } = useQuery({
    queryKey: ["admin", "settlements"],
    queryFn: () => api.admin.listSettlements(),
    retry: 1,
    enabled: canSeeFinance,
  })

  const {
    data: withdrawals,
    isLoading: withdrawalsLoading,
    error: withdrawalsError,
  } = useQuery({
    queryKey: ["admin", "withdrawals"],
    queryFn: () => api.admin.listWithdrawals(),
    retry: 1,
    enabled: canSeeFinance,
  })

  const isLoading =
    usersLoading ||
    ordersLoading ||
    (canSeeFinance && (settlementsLoading || withdrawalsLoading))
  // Finance query errors only matter for finance-capable staff
  const queryError =
    usersError ||
    ordersError ||
    (canSeeFinance ? settlementsError || withdrawalsError : undefined)

  if (queryError) {
    return (
      <ErrorState
        title="Failed to load dashboard"
        description={
          queryError instanceof Error
            ? queryError.message
            : "An unexpected error occurred"
        }
        onRetry={() => queryClient.invalidateQueries({ queryKey: ["admin"] })}
      />
    )
  }

  let stats: Stats | undefined

  if (!isLoading) {
    const customers = users?.filter((u) => u.userType === "CUSTOMER") ?? []
    const publishers = users?.filter((u) => u.userType === "PUBLISHER") ?? []
    const completedOrders = orders?.filter((o) =>
      ["COMPLETED", "SETTLED", "VERIFIED", "PUBLISHED"].includes(o.status),
    )
    const pendingOrders = orders?.filter((o) =>
      ["PENDING_PAYMENT", "ASSIGNED", "CONTENT_CREATION", "OUTREACH"].includes(
        o.status,
      ),
    )

    // Decimal columns arrive as strings — without Number() this reduce
    // string-concatenates into a nonsense figure.
    const gmv =
      completedOrders?.reduce((sum, o) => sum + Number(o.amount ?? 0), 0) ?? 0

    stats = {
      publishers: publishers.length,
      customers: customers.length,
      activeOrders: pendingOrders?.length ?? 0,
      gmv,
      revenue: Math.round(gmv * 0.3),
      pendingVerifications:
        settlements?.items?.filter(
          (s) => s.status === "PENDING" || s.status === "UNDER_REVIEW",
        ).length ?? 0,
      pendingWithdrawals:
        withdrawals?.items?.filter((w) => w.status === "PENDING").length ?? 0,
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
      </div>

      <KPICards stats={isLoading ? undefined : stats} loading={isLoading} />

      <div className="grid gap-6 lg:grid-cols-2">
        <RecentOrdersTable orders={orders ?? []} loading={ordersLoading} />
        <ActivityFeed />
      </div>
    </div>
  )
}
