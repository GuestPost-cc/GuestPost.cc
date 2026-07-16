"use client"

import type { OrderStatus } from "@guestpost/shared"
import {
  Badge,
  Button,
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Clock,
  CreditCard,
  DollarSign,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { api } from "../../lib/api"
import { useAuth } from "../../lib/auth"
import { getOrderBadgeVariant } from "../../lib/order-status-badge-variant"

interface Stats {
  revenue: number | null
  gmv: number | null
  activeOrders: number
  publishers: number | null
  customers: number | null
  pendingSettlements: number | null
  pendingWithdrawals: number | null
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
      <CardHeader className="flex flex-row items-center justify-between px-4 pt-4 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="px-4 pb-4">
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
  canSeeFinance,
  canSeeUsers,
}: {
  stats: Stats | undefined
  loading: boolean
  canSeeFinance: boolean
  canSeeUsers: boolean
}) {
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
      {canSeeFinance && (
        <StatCard
          title="Net Revenue"
          value={
            stats?.revenue != null ? `$${stats.revenue.toLocaleString()}` : "—"
          }
          icon={DollarSign}
          loading={loading}
        />
      )}
      {canSeeFinance && (
        <StatCard
          title="Platform GMV"
          value={stats?.gmv != null ? `$${stats.gmv.toLocaleString()}` : "—"}
          icon={ShoppingCart}
          loading={loading}
        />
      )}
      <StatCard
        title="Active Orders"
        value={stats?.activeOrders ?? "—"}
        icon={Clock}
        loading={loading}
      />
      {canSeeFinance && (
        <StatCard
          title="Publishers"
          value={stats?.publishers ?? "—"}
          icon={Users}
          loading={loading}
        />
      )}
      {canSeeUsers && (
        <StatCard
          title="Customers"
          value={stats?.customers ?? "—"}
          icon={Building2}
          loading={loading}
        />
      )}
      {canSeeFinance && (
        <StatCard
          title="Settlements In Review"
          value={stats?.pendingSettlements ?? "—"}
          icon={AlertCircle}
          loading={loading}
        />
      )}
      {canSeeFinance && (
        <StatCard
          title="Pending Withdrawals"
          value={stats?.pendingWithdrawals ?? "—"}
          icon={CreditCard}
          loading={loading}
        />
      )}
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
                    <Badge
                      variant={getOrderBadgeVariant(
                        order.status as OrderStatus,
                      )}
                    >
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

function formatOperationsSales(values?: Record<string, number>) {
  const entries = Object.entries(values ?? {})
  if (entries.length === 0) return "$0.00"
  return entries
    .map(([currency, amount]) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
        amount,
      ),
    )
    .join(" + ")
}

function OperationsDashboard() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const active = useQuery({
    queryKey: ["operations-inbox", "active", "dashboard"],
    queryFn: () => api.admin.operationsInbox({ view: "active", take: 6 }),
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  })
  const available = useQuery({
    queryKey: ["operations-inbox", "available", "dashboard"],
    queryFn: () =>
      api.admin.operationsInbox({
        view: "available",
        take: 5,
        includeSummary: false,
      }),
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  })
  const claim = useMutation({
    mutationFn: (orderId: string) => api.admin.claimOrder(orderId),
    onSuccess: async (_result, orderId) => {
      await queryClient.invalidateQueries({ queryKey: ["operations-inbox"] })
      toast.success("Order claimed")
      router.push(`/dashboard/fulfillment/${orderId}`)
    },
    onError: async (error: Error) => {
      await queryClient.invalidateQueries({ queryKey: ["operations-inbox"] })
      toast.error(
        error.message.includes("already assigned")
          ? "Another operator claimed this order first."
          : error.message,
      )
    },
  })

  const error = active.error || available.error
  if (error) {
    return (
      <ErrorState
        title="Failed to load Operations dashboard"
        description={(error as Error).message}
        onRetry={() => {
          active.refetch()
          available.refetch()
        }}
      />
    )
  }
  const summary = active.data?.summary ?? available.data?.summary
  const stats: Array<{
    title: string
    value: string | number
    icon: React.ElementType
  }> = [
    { title: "My active", value: summary?.myActive ?? 0, icon: ClipboardList },
    { title: "Available", value: summary?.available ?? 0, icon: UserPlus },
    { title: "Overdue", value: summary?.overdue ?? 0, icon: AlertTriangle },
    { title: "Claimed", value: summary?.claimed ?? 0, icon: CheckCircle2 },
    { title: "Completed", value: summary?.completed ?? 0, icon: CheckCircle2 },
    {
      title: "Delivered sales",
      value: formatOperationsSales(summary?.salesByCurrency),
      icon: CircleDollarSign,
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Operations Overview</h1>
          <p className="mt-1 text-muted-foreground">
            Your assigned work and the live platform queue.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/fulfillment">
            Open fulfillment
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-6">
        {stats.map((stat) => (
          <StatCard
            key={stat.title}
            title={stat.title}
            value={stat.value}
            icon={stat.icon}
            loading={active.isLoading && available.isLoading}
          />
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Continue working</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/dashboard/fulfillment">View all</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {active.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-14 w-full" />
                ))}
              </div>
            ) : active.data?.items.length ? (
              <div className="divide-y">
                {active.data.items.map((order) => (
                  <Link
                    key={order.id}
                    href={`/dashboard/fulfillment/${order.id}`}
                    className="flex items-center justify-between gap-4 py-3 hover:bg-muted/40"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {order.title || order.website?.domain || order.id}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {order.status.replaceAll("_", " ")}
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </Link>
                ))}
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No active work assigned.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg">Available to claim</CardTitle>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Updates every 5 seconds
              </div>
            </div>
            <Badge variant="secondary">{summary?.available ?? 0}</Badge>
          </CardHeader>
          <CardContent>
            {available.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-14 w-full" />
                ))}
              </div>
            ) : available.data?.items.length ? (
              <div className="divide-y">
                {available.data.items.map((order) => (
                  <div
                    key={order.id}
                    className="flex items-center justify-between gap-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {order.title || order.website?.domain || order.id}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {order.website?.domain ??
                          order.type.replaceAll("_", " ")}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => claim.mutate(order.id)}
                      disabled={claim.isPending}
                    >
                      <UserPlus className="h-4 w-4" />
                      Claim
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No orders are waiting to be claimed.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function GeneralDashboardPage() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  // Settlements/withdrawals are SUPER_ADMIN/FINANCE backend routes — never
  // fetch them for OPERATIONS (was a 403 storm on the overview page)
  const canSeeFinance =
    user?.staffRole === "SUPER_ADMIN" || user?.staffRole === "FINANCE"
  const canSeeUsers = user?.staffRole === "SUPER_ADMIN"

  const {
    data: usersData,
    isLoading: usersLoading,
    error: usersError,
  } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api.admin.listUsers(),
    retry: 1,
    enabled: canSeeUsers,
  })
  const users = usersData?.items

  const {
    data: publishersData,
    isLoading: publishersLoading,
    error: publishersError,
  } = useQuery({
    queryKey: ["admin", "publishers", "overview"],
    queryFn: () => api.admin.listPublishers({ page: 1, limit: 1 }),
    retry: 1,
    enabled: canSeeFinance,
  })

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

  const {
    data: revenue,
    isLoading: revenueLoading,
    error: revenueError,
  } = useQuery({
    queryKey: ["admin", "revenue", "overview"],
    queryFn: () => api.admin.getRevenue({ groupBy: "channel" }),
    retry: 1,
    enabled: canSeeFinance,
  })

  const isLoading =
    (canSeeUsers && usersLoading) ||
    ordersLoading ||
    (canSeeFinance &&
      (publishersLoading ||
        settlementsLoading ||
        withdrawalsLoading ||
        revenueLoading))
  // Finance query errors only matter for finance-capable staff
  const queryError =
    (canSeeUsers ? usersError : undefined) ||
    ordersError ||
    (canSeeFinance
      ? publishersError || settlementsError || withdrawalsError || revenueError
      : undefined)

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
    const pendingOrders = orders?.filter((o) =>
      ["PENDING_PAYMENT", "ASSIGNED", "CONTENT_CREATION", "OUTREACH"].includes(
        o.status,
      ),
    )

    stats = {
      publishers: canSeeFinance ? (publishersData?.total ?? 0) : null,
      customers: canSeeUsers ? customers.length : null,
      activeOrders: pendingOrders?.length ?? 0,
      gmv: canSeeFinance
        ? Number(revenue?.totals.current.grossAmount ?? 0)
        : null,
      revenue: canSeeFinance
        ? Number(revenue?.totals.current.netRevenue ?? 0)
        : null,
      pendingSettlements: canSeeFinance
        ? (settlements?.items?.filter(
            (s) => s.status === "PENDING" || s.status === "UNDER_REVIEW",
          ).length ?? 0)
        : null,
      pendingWithdrawals: canSeeFinance
        ? (withdrawals?.items?.filter((w) => w.status === "PENDING").length ??
          0)
        : null,
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
      </div>

      <KPICards
        stats={isLoading ? undefined : stats}
        loading={isLoading}
        canSeeFinance={canSeeFinance}
        canSeeUsers={canSeeUsers}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <RecentOrdersTable orders={orders ?? []} loading={ordersLoading} />
        <ActivityFeed />
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const { user, loading } = useAuth()
  if (loading) return <Skeleton className="h-72 w-full" />
  if (user?.staffRole === "OPERATIONS") return <OperationsDashboard />
  return <GeneralDashboardPage />
}
