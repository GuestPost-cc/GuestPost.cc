"use client"

import type {
  OperationsInboxOrder,
  OperationsInboxView,
} from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  ErrorState,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format, formatDistanceToNowStrict, isPast } from "date-fns"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Clock3,
  type LucideIcon,
  RefreshCw,
  Search,
  UserPlus,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import {
  AdminFilterBar,
  AdminMetricCard,
  AdminPage,
  AdminPageHeader,
} from "../../../components/admin-workspace"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { ForbiddenPage, useRequireRole } from "../../../lib/use-require-role"

const views: Array<{
  value: OperationsInboxView
  label: string
  count: (summary: any) => number | undefined
}> = [
  { value: "active", label: "My Work", count: (s) => s?.myActive },
  { value: "available", label: "Available", count: (s) => s?.available },
  {
    value: "waiting",
    label: "Waiting",
    count: (s) => s?.waitingCustomer,
  },
  {
    value: "ready",
    label: "Ready to Publish",
    count: (s) => s?.readyToPublish,
  },
  {
    value: "verification",
    label: "Verification",
    count: (s) => s?.verificationTotal,
  },
  { value: "history", label: "History", count: () => undefined },
]

const nextActionLabels: Record<string, string> = {
  CLAIM: "Claim & open",
  ACCEPT: "Accept order",
  CONTENT: "Continue content",
  WAITING_CUSTOMER: "View order",
  PUBLISH: "Publish",
  VERIFICATION: "View verification",
  CANCELLATION: "Review cancellation",
  VIEW: "View order",
}

function formatMoney(values: Record<string, number> | undefined) {
  const entries = Object.entries(values ?? {})
  if (entries.length === 0) return "$0.00"
  return entries
    .map(([currency, amount]) =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
      }).format(amount),
    )
    .join(" + ")
}

function DueAt({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">Not set</span>
  const date = new Date(value)
  const overdue = isPast(date)
  return (
    <div className={overdue ? "text-destructive" : "text-muted-foreground"}>
      <div className="font-medium">
        {overdue ? "Overdue" : "Due"} {formatDistanceToNowStrict(date)}
      </div>
      <div className="text-xs">{format(date, "MMM d, p")}</div>
    </div>
  )
}

function OrderAction({
  order,
  onClaim,
  claiming,
}: {
  order: OperationsInboxOrder
  onClaim: (orderId: string) => void
  claiming: boolean
}) {
  if (order.claimable) {
    return (
      <Button size="sm" onClick={() => onClaim(order.id)} disabled={claiming}>
        <UserPlus className="h-4 w-4" />
        {claiming ? "Claiming..." : "Claim & open"}
      </Button>
    )
  }
  return (
    <Button size="sm" variant="outline" asChild>
      <Link href={`/dashboard/fulfillment/${order.id}`}>
        {nextActionLabels[order.nextAction] ?? "Open"}
        <ArrowRight className="h-4 w-4" />
      </Link>
    </Button>
  )
}

export default function FulfillmentPage() {
  const { allowed, loading } = useRequireRole("SUPER_ADMIN", "OPERATIONS")
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Operations or Super Admin" />
  return <FulfillmentPageInner />
}

function FulfillmentPageInner() {
  const { user } = useAuth()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [view, setView] = useState<OperationsInboxView>("active")
  const [search, setSearch] = useState("")

  const query = useQuery({
    queryKey: ["operations-inbox", view, search],
    queryFn: () =>
      api.admin.operationsInbox({
        view,
        search: search.trim() || undefined,
        take: 100,
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
          ? "Another operator claimed this order first. The queue is refreshed."
          : error.message || "Could not claim order",
      )
    },
  })

  const summary = query.data?.summary
  const items = query.data?.items ?? []
  const title =
    user?.staffRole === "OPERATIONS" ? "My Fulfillment" : "Platform Fulfillment"
  const emptyMessage = useMemo(() => {
    if (search.trim()) return "No matching fulfillment orders."
    if (view === "available")
      return "No platform orders are waiting to be claimed."
    if (view === "active")
      return user?.staffRole === "OPERATIONS"
        ? "You have no active fulfillment work."
        : "No platform fulfillment orders are active."
    return "No orders in this view."
  }, [search, user?.staffRole, view])
  const summaryCards: Array<{
    label: string
    value: string | number
    Icon: LucideIcon
  }> = [
    {
      label: user?.staffRole === "OPERATIONS" ? "My active" : "Active",
      value: summary?.myActive ?? 0,
      Icon: ClipboardList,
    },
    { label: "Available", value: summary?.available ?? 0, Icon: UserPlus },
    { label: "Overdue", value: summary?.overdue ?? 0, Icon: AlertTriangle },
    { label: "Claimed", value: summary?.claimed ?? 0, Icon: CheckCircle2 },
    { label: "Completed", value: summary?.completed ?? 0, Icon: Clock3 },
    {
      label: "Delivered sales",
      value: formatMoney(summary?.salesByCurrency),
      Icon: CircleDollarSign,
    },
  ]

  if (query.error) {
    return (
      <ErrorState
        title="Failed to load fulfillment"
        description={(query.error as Error).message}
        onRetry={() => query.refetch()}
      />
    )
  }

  return (
    <AdminPage>
      <AdminPageHeader
        eyebrow="Live fulfillment queue"
        title={title}
        description="Assigned platform orders and new work available to claim, prioritized by lifecycle urgency."
        icon={ClipboardList}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw
              className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`}
            />
            <span className="ml-2">Refresh</span>
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-6">
        {summaryCards.map(({ label, value, Icon }) => (
          <AdminMetricCard
            key={label}
            label={label}
            value={query.isLoading ? <Skeleton className="h-7 w-16" /> : value}
            icon={Icon}
            tone={
              label === "Overdue"
                ? Number(value) > 0
                  ? "danger"
                  : "success"
                : label === "Available"
                  ? "info"
                  : label === "Claimed" || label === "Completed"
                    ? "success"
                    : "neutral"
            }
          />
        ))}
      </div>

      <Tabs
        value={view}
        onValueChange={(value) => setView(value as OperationsInboxView)}
      >
        <TabsList className="h-auto w-full justify-start overflow-x-auto">
          {views.map((item) => {
            const count = item.count(summary)
            const label =
              item.value === "active" && user?.staffRole === "SUPER_ADMIN"
                ? "Active"
                : item.label
            return (
              <TabsTrigger
                key={item.value}
                value={item.value}
                className="gap-2"
              >
                {label}
                {count !== undefined && (
                  <Badge
                    variant="secondary"
                    className="min-w-5 justify-center px-1.5"
                  >
                    {count}
                  </Badge>
                )}
              </TabsTrigger>
            )
          })}
        </TabsList>
      </Tabs>

      <AdminFilterBar
        activeCount={Number(Boolean(search))}
        resultCount={items.length}
        resultLabel={items.length === 1 ? "order" : "orders"}
        onClear={() => setSearch("")}
      >
        <div className="relative min-w-0 flex-1 lg:max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search order, title, or website"
            className="bg-background pl-9"
          />
        </div>
      </AdminFilterBar>

      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Website</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Assignment</TableHead>
                  <TableHead className="text-right">Next action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((order) => {
                  const assignment = order.fulfillmentAssignments[0]
                  return (
                    <TableRow key={order.id}>
                      <TableCell>
                        <div className="font-medium">
                          {order.title ||
                            order.type.replaceAll("_", " ").toLowerCase()}
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {order.id.slice(0, 10)}
                        </div>
                      </TableCell>
                      <TableCell>
                        {order.website?.domain ??
                          order.website?.url ??
                          "Not set"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {order.status.replaceAll("_", " ")}
                        </Badge>
                        {order.cancellationRequests.length > 0 && (
                          <Badge variant="destructive" className="ml-2">
                            Cancellation
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <DueAt value={order.fulfillmentDueAt} />
                      </TableCell>
                      <TableCell>
                        {assignment ? (
                          <Badge variant="secondary">
                            {assignment.assignedToUserId === user?.id
                              ? "Assigned to you"
                              : "Assigned"}
                          </Badge>
                        ) : (
                          <Badge variant="outline">Available</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <OrderAction
                          order={order}
                          onClaim={(orderId) => claim.mutate(orderId)}
                          claiming={
                            claim.isPending && claim.variables === order.id
                          }
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AdminPage>
  )
}
