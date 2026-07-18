"use client"

import type {
  CancellationReasonCode,
  OrderResponse,
} from "@guestpost/api-client"
import type { OrderStatus, ServiceType } from "@guestpost/shared"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  getOrderStatusPresentation,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  Filter,
  Inbox,
  Search,
  ShoppingBag,
  Store,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useDeferredValue, useMemo, useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import {
  CUSTOMER_ORDER_STAGE_GROUPS,
  formatCustomerMoney,
  getCustomerNextAction,
  getCustomerOrderDeadline,
} from "../../../lib/customer-order-workflow"

const SERVICE_TYPES: ServiceType[] = [
  "GUEST_POST",
  "NICHE_EDIT",
  "EDITORIAL_LINK",
  "OUTREACH_LINK",
  "LOCAL_CITATION",
  "FOUNDATION_LINK",
  "BLOG_ARTICLE",
  "SEO_CONTENT",
]

const PAGE_SIZE = 20

function QueueSkeleton() {
  return (
    <div className="space-y-3 p-5">
      {[1, 2, 3, 4, 5].map((item) => (
        <div
          key={item}
          className="flex items-center gap-4 rounded-xl border p-4"
        >
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <Skeleton className="h-9 w-32" />
        </div>
      ))}
    </div>
  )
}

function DeadlineBadge({ order }: { order: OrderResponse }) {
  const deadline = getCustomerOrderDeadline(order)
  const className =
    deadline.risk === "overdue"
      ? "border-red-200 bg-red-50 text-red-700"
      : deadline.risk === "soon"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-border bg-muted/40 text-muted-foreground"
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium ${className}`}
    >
      <Clock3 className="h-3 w-3" />
      {deadline.label}
    </span>
  )
}

function OrderMobileCard({
  order,
  user,
  onOptions,
}: {
  order: OrderResponse
  user: { id: string; customerRole: "OWNER" | "MEMBER" | null }
  onOptions: (order: OrderResponse) => void
}) {
  const presentation = getOrderStatusPresentation(order.status)
  const nextAction = getCustomerNextAction(order, user)
  const website = order.website?.url ?? order.items[0]?.website?.url
  return (
    <div className="rounded-2xl border bg-background p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              #{order.id.slice(0, 8)}
            </span>
            <StatusBadge variant={presentation.variant}>
              {presentation.label}
            </StatusBadge>
          </div>
          <p className="mt-2 truncate font-semibold capitalize">
            {order.title || order.type.replaceAll("_", " ").toLowerCase()}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {website ?? "Website unavailable"}
          </p>
        </div>
        <p className="shrink-0 text-sm font-semibold tabular-nums">
          {formatCustomerMoney(order.totalAmount, order.currency)}
        </p>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <DeadlineBadge order={order} />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onOptions(order)}>
            Options
          </Button>
          <Button size="sm" asChild>
            <Link href={`/dashboard/orders/${order.id}`}>
              {nextAction.label}
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}

function OrdersQueue() {
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [stage, setStage] = useState(
    searchParams.get("view") === "attention" ? "attention" : "all",
  )
  const [search, setSearch] = useState("")
  const deferredSearch = useDeferredValue(search.trim())
  const [campaignId, setCampaignId] = useState("all")
  const [serviceType, setServiceType] = useState("all")
  const [sort, setSort] = useState<
    "priority" | "deadline" | "newest" | "value"
  >(stage === "attention" ? "priority" : "newest")
  const [pageIndex, setPageIndex] = useState(0)
  const [selectedOrder, setSelectedOrder] = useState<OrderResponse | null>(null)
  const [cancelReason, setCancelReason] = useState<CancellationReasonCode>(
    "CUSTOMER_CHANGED_MIND",
  )
  const [cancelNote, setCancelNote] = useState("")

  const stageDefinition = CUSTOMER_ORDER_STAGE_GROUPS.find(
    (candidate) => candidate.key === stage,
  )
  const statuses = stageDefinition
    ? ([...stageDefinition.statuses] as OrderStatus[])
    : undefined

  const ordersQuery = useQuery({
    queryKey: [
      "customer-orders",
      stage,
      deferredSearch,
      campaignId,
      serviceType,
      sort,
      pageIndex,
    ],
    enabled: Boolean(user?.organizationId),
    queryFn: () =>
      api.orders.listPaginated({
        statuses,
        needsAction: stage === "attention",
        search: deferredSearch || undefined,
        campaignId: campaignId === "all" ? undefined : campaignId,
        serviceType:
          serviceType === "all" ? undefined : (serviceType as ServiceType),
        sort,
        take: PAGE_SIZE,
        skip: pageIndex * PAGE_SIZE,
      }),
  })
  const campaignsQuery = useQuery({
    queryKey: ["campaigns", "order-filter"],
    queryFn: () => api.campaigns.listAllCampaigns(),
  })
  const cancellationPreviewQuery = useQuery({
    queryKey: ["order-cancellation-preview", selectedOrder?.id],
    queryFn: () => api.orders.cancellationPreview(selectedOrder!.id),
    enabled: Boolean(selectedOrder),
  })

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!selectedOrder || !cancellationPreviewQuery.data) {
        throw new Error("Cancellation policy unavailable")
      }
      const preview = cancellationPreviewQuery.data
      const body = {
        reasonCode: cancelReason,
        note: cancelNote.trim() || undefined,
        expectedVersion: preview.expectedVersion,
        idempotencyKey: `portal-${selectedOrder.id}-${preview.expectedVersion}`,
      }
      if (preview.action === "CANCEL_NOW") {
        return api.orders.cancel(selectedOrder.id, body)
      }
      if (preview.action === "REQUEST_CANCELLATION") {
        return api.orders.requestCancellation(selectedOrder.id, body)
      }
      if (preview.action === "OPEN_DISPUTE") {
        return api.orders.openDispute(
          selectedOrder.id,
          `${cancelReason}${cancelNote.trim() ? `: ${cancelNote.trim()}` : ""}`,
        )
      }
      throw new Error(preview.message)
    },
    onSuccess: () => {
      const action = cancellationPreviewQuery.data?.action
      toast.success(
        action === "REQUEST_CANCELLATION"
          ? "Cancellation request sent"
          : action === "OPEN_DISPUTE"
            ? "Dispute opened for review"
            : "Order cancelled and refund processed",
      )
      queryClient.invalidateQueries({ queryKey: ["customer-orders"] })
      queryClient.invalidateQueries({ queryKey: ["customer-workbench"] })
      setSelectedOrder(null)
      setCancelNote("")
    },
    onError: (error: Error) =>
      toast.error(error.message || "Failed to process cancellation"),
  })

  const resetPage = () => setPageIndex(0)
  const result = ordersQuery.data
  const orders = result?.items ?? []
  const total = result?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageStart = total === 0 ? 0 : pageIndex * PAGE_SIZE + 1
  const pageEnd = Math.min((pageIndex + 1) * PAGE_SIZE, total)

  const stageOptions = useMemo(
    () => [
      { key: "all", label: "All" },
      { key: "attention", label: "Needs action" },
      ...CUSTOMER_ORDER_STAGE_GROUPS.map((group) => ({
        key: group.key,
        label: group.label,
      })),
    ],
    [],
  )

  if (!user) return null

  if (ordersQuery.error) {
    return (
      <ErrorState
        title="We couldn't load your orders"
        description={(ordersQuery.error as Error).message}
        onRetry={() => ordersQuery.refetch()}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <ShoppingBag className="h-4 w-4" />
            Customer order queue
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Orders
          </h1>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">
            See what needs you, what is moving, and what has been delivered.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/marketplace">
            <Store className="mr-2 h-4 w-4" />
            New placement
          </Link>
        </Button>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {stageOptions.map((option) => (
          <Button
            key={option.key}
            type="button"
            variant={stage === option.key ? "default" : "outline"}
            size="sm"
            className="shrink-0 rounded-full"
            onClick={() => {
              setStage(option.key)
              setSort(option.key === "attention" ? "priority" : "newest")
              resetPage()
            }}
          >
            {option.key === "attention" && (
              <Inbox className="mr-1.5 h-3.5 w-3.5" />
            )}
            {option.label}
          </Button>
        ))}
      </div>

      <Card className="overflow-hidden rounded-2xl shadow-sm">
        <CardHeader className="border-b">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <CardTitle>Order queue</CardTitle>
              <CardDescription>
                {ordersQuery.isLoading
                  ? "Loading orders…"
                  : `${total} matching order${total === 1 ? "" : "s"}`}
              </CardDescription>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_180px_180px_170px]">
              <div className="relative sm:col-span-2 xl:col-span-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value)
                    resetPage()
                  }}
                  maxLength={200}
                  placeholder="Search order, site, campaign, topic…"
                  className="pl-9"
                />
              </div>
              <Select
                value={campaignId}
                onValueChange={(value) => {
                  setCampaignId(value)
                  resetPage()
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All campaigns" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All campaigns</SelectItem>
                  {(campaignsQuery.data ?? []).map((campaign) => (
                    <SelectItem key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={serviceType}
                onValueChange={(value) => {
                  setServiceType(value)
                  resetPage()
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All services" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All services</SelectItem>
                  {SERVICE_TYPES.map((service) => (
                    <SelectItem key={service} value={service}>
                      {service.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={sort}
                onValueChange={(value) => {
                  setSort(value as typeof sort)
                  resetPage()
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="priority">Priority</SelectItem>
                  <SelectItem value="deadline">Deadline</SelectItem>
                  <SelectItem value="newest">Newest</SelectItem>
                  <SelectItem value="value">Order value</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>

        {ordersQuery.isLoading ? (
          <QueueSkeleton />
        ) : orders.length === 0 ? (
          <CardContent className="flex min-h-72 flex-col items-center justify-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Filter className="h-6 w-6" />
            </div>
            <p className="mt-4 font-semibold">No matching orders</p>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Adjust the stage, campaign, service, or search. Your order history
              has not been changed.
            </p>
          </CardContent>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order & placement</TableHead>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Deadline</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Next action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((order) => {
                    const presentation = getOrderStatusPresentation(
                      order.status,
                    )
                    const nextAction = getCustomerNextAction(order, user)
                    const website =
                      order.website?.url ?? order.items[0]?.website?.url
                    return (
                      <TableRow key={order.id}>
                        <TableCell className="min-w-64">
                          <Link
                            href={`/dashboard/orders/${order.id}`}
                            className="font-semibold hover:text-primary"
                          >
                            {order.title ||
                              order.type.replaceAll("_", " ").toLowerCase()}
                          </Link>
                          <p className="mt-1 flex max-w-xs items-center gap-1 truncate text-xs text-muted-foreground">
                            <ExternalLink className="h-3 w-3 shrink-0" />
                            <span className="truncate">
                              {website ?? "Website unavailable"}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">
                              #{order.id.slice(0, 8)}
                            </span>
                          </p>
                        </TableCell>
                        <TableCell className="max-w-44 truncate text-sm">
                          {order.campaign?.name ?? "—"}
                        </TableCell>
                        <TableCell>
                          <StatusBadge variant={presentation.variant}>
                            {presentation.label}
                          </StatusBadge>
                        </TableCell>
                        <TableCell>
                          <DeadlineBadge order={order} />
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {formatCustomerMoney(
                            order.totalAmount,
                            order.currency,
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setSelectedOrder(order)}
                              aria-label={`Cancellation and dispute options for order ${order.id.slice(0, 8)}`}
                            >
                              <XCircle className="h-4 w-4" />
                            </Button>
                            <Button variant="outline" size="sm" asChild>
                              <Link href={`/dashboard/orders/${order.id}`}>
                                {nextAction.label}
                                <ArrowRight className="ml-1 h-3.5 w-3.5" />
                              </Link>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="space-y-3 p-4 md:hidden">
              {orders.map((order) => (
                <OrderMobileCard
                  key={order.id}
                  order={order}
                  user={user}
                  onOptions={setSelectedOrder}
                />
              ))}
            </div>
            <div className="flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Showing {pageStart}–{pageEnd} of {total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pageIndex === 0 || ordersQuery.isFetching}
                  onClick={() =>
                    setPageIndex((current) => Math.max(0, current - 1))
                  }
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Previous
                </Button>
                <span className="px-2 text-sm text-muted-foreground">
                  Page {pageIndex + 1} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    pageIndex + 1 >= totalPages || ordersQuery.isFetching
                  }
                  onClick={() => setPageIndex((current) => current + 1)}
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      <Dialog
        open={Boolean(selectedOrder)}
        onOpenChange={(open) => !open && setSelectedOrder(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancellation / dispute options</DialogTitle>
            <DialogDescription>
              {cancellationPreviewQuery.isLoading
                ? "Checking this order's policy…"
                : (cancellationPreviewQuery.data?.message ??
                  "Cancellation is not available for this order.")}
            </DialogDescription>
          </DialogHeader>
          {cancellationPreviewQuery.data?.action !== "NOT_ALLOWED" && (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>Reason</Label>
                <Select
                  value={cancelReason}
                  onValueChange={(value) =>
                    setCancelReason(value as CancellationReasonCode)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CUSTOMER_CHANGED_MIND">
                      Changed my mind
                    </SelectItem>
                    <SelectItem value="CAMPAIGN_CHANGED">
                      Campaign changed
                    </SelectItem>
                    <SelectItem value="DUPLICATE_ORDER">
                      Duplicate order
                    </SelectItem>
                    <SelectItem value="MISSED_DEADLINE">
                      Deadline missed
                    </SelectItem>
                    <SelectItem value="QUALITY_FAILURE">
                      Quality problem
                    </SelectItem>
                    <SelectItem value="OTHER">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cancellation-note">Details</Label>
                <Textarea
                  id="cancellation-note"
                  value={cancelNote}
                  onChange={(event) => setCancelNote(event.target.value)}
                  maxLength={2000}
                  rows={4}
                  placeholder="Add context for the other party or reviewer"
                />
              </div>
              {cancellationPreviewQuery.data?.refund.type === "FULL" && (
                <p className="rounded-xl bg-muted p-3 text-sm">
                  Full refund:{" "}
                  {formatCustomerMoney(
                    cancellationPreviewQuery.data.refund.amount,
                    cancellationPreviewQuery.data.refund.currency,
                  )}{" "}
                  to your wallet.
                </p>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSelectedOrder(null)}>
              Keep order
            </Button>
            <Button
              variant="destructive"
              disabled={
                cancelMutation.isPending ||
                cancellationPreviewQuery.isLoading ||
                !cancellationPreviewQuery.data ||
                cancellationPreviewQuery.data.action === "NOT_ALLOWED"
              }
              onClick={() => cancelMutation.mutate()}
            >
              {cancelMutation.isPending
                ? "Submitting…"
                : cancellationPreviewQuery.data?.action ===
                    "REQUEST_CANCELLATION"
                  ? "Send cancellation request"
                  : cancellationPreviewQuery.data?.action === "OPEN_DISPUTE"
                    ? "Open dispute"
                    : "Cancel order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<QueueSkeleton />}>
      <OrdersQueue />
    </Suspense>
  )
}
