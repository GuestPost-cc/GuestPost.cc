"use client"

import type {
  AdminOperationsWorkbenchAction,
  AdminOperationsWorkbenchActionType,
} from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Skeleton,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { formatDistanceToNowStrict, isPast } from "date-fns"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardList,
  FileCheck2,
  HeadphonesIcon,
  PackageSearch,
  RefreshCw,
  Scale,
  ShieldCheck,
  Store,
  UserPlus,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import { getOrderBadgeVariant } from "../../../lib/order-status-badge-variant"

const actionLabels: Record<AdminOperationsWorkbenchActionType, string> = {
  SUPPORT: "Support",
  FULFILLMENT: "Fulfillment",
  CANCELLATION: "Cancellation",
  DISPUTE: "Dispute",
  DELIVERY_VERIFICATION: "Delivery verification",
  DOMAIN_VERIFICATION: "Domain verification",
  MODERATION: "Moderation",
  INVENTORY: "Inventory",
}

const actionIcons: Record<
  AdminOperationsWorkbenchActionType,
  React.ElementType
> = {
  SUPPORT: HeadphonesIcon,
  FULFILLMENT: ClipboardList,
  CANCELLATION: Scale,
  DISPUTE: AlertTriangle,
  DELIVERY_VERIFICATION: ClipboardCheck,
  DOMAIN_VERIFICATION: ShieldCheck,
  MODERATION: FileCheck2,
  INVENTORY: Store,
}

function priorityVariant(priority: AdminOperationsWorkbenchAction["priority"]) {
  if (priority === "CRITICAL") return "destructive" as const
  if (priority === "HIGH") return "secondary" as const
  return "outline" as const
}

function formatMoney(values: Record<string, number> | undefined) {
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

function KpiCard({
  label,
  value,
  icon: Icon,
  loading,
  tone = "default",
}: {
  label: string
  value: number | string
  icon: React.ElementType
  loading: boolean
  tone?: "default" | "attention" | "support"
}) {
  return (
    <Card
      className={
        tone === "attention"
          ? "border-amber-500/30 bg-amber-500/[0.04]"
          : tone === "support"
            ? "border-blue-500/30 bg-blue-500/[0.04]"
            : undefined
      }
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        {loading ? (
          <Skeleton className="mt-2 h-8 w-16" />
        ) : (
          <div className="mt-1 text-2xl font-semibold tracking-tight">
            {value}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Deadline({ value }: { value: string | null }) {
  if (!value) return null
  const date = new Date(value)
  const overdue = isPast(date)
  return (
    <span className={overdue ? "text-destructive" : "text-muted-foreground"}>
      {overdue ? "Overdue" : "Due"} {formatDistanceToNowStrict(date)}
    </span>
  )
}

function QueueItem({
  item,
  onClaim,
  claiming,
}: {
  item: AdminOperationsWorkbenchAction
  onClaim: (orderId: string) => void
  claiming: boolean
}) {
  const Icon = actionIcons[item.type]
  return (
    <div className="flex flex-col gap-3 border-b px-4 py-4 last:border-b-0 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={priorityVariant(item.priority)}>
              {item.priority}
            </Badge>
            <span className="text-xs font-medium text-muted-foreground">
              {actionLabels[item.type]}
            </span>
          </div>
          <p className="mt-1 truncate text-sm font-semibold">{item.title}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {item.description}
          </p>
          <div className="mt-1 text-xs">
            <Deadline value={item.deadlineAt} />
          </div>
        </div>
      </div>
      {item.claimable ? (
        <Button size="sm" onClick={() => onClaim(item.id)} disabled={claiming}>
          <UserPlus className="h-4 w-4" />
          {claiming ? "Claiming…" : "Claim & open"}
        </Button>
      ) : (
        <Button size="sm" variant="outline" asChild>
          <Link href={item.href}>
            Open
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      )}
    </div>
  )
}

function LaneLink({
  href,
  label,
  value,
}: {
  href: string
  label: string
  value: number
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-muted"
    >
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{value}</span>
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
    </Link>
  )
}

export function OperationsWorkbench() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["operations-workbench"],
    queryFn: () => api.admin.getOperationsWorkbench(),
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  })
  const claim = useMutation({
    mutationFn: (orderId: string) => api.admin.claimOrder(orderId),
    onSuccess: async (_result, orderId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["operations-workbench"] }),
        queryClient.invalidateQueries({ queryKey: ["operations-inbox"] }),
      ])
      toast.success("Order claimed")
      router.push(`/dashboard/fulfillment/${orderId}`)
    },
    onError: async (error: Error) => {
      await queryClient.invalidateQueries({
        queryKey: ["operations-workbench"],
      })
      toast.error(
        error.message.includes("already assigned")
          ? "Another operator claimed this order first. The workbench is refreshed."
          : error.message,
      )
    },
  })

  if (query.error) {
    return (
      <ErrorState
        title="Failed to load Operations workbench"
        description={(query.error as Error).message}
        onRetry={() => query.refetch()}
      />
    )
  }

  const data = query.data
  const loading = query.isLoading
  const overview = data?.overview

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <PackageSearch className="h-4 w-4" />
            </span>
            <h1 className="text-3xl font-bold tracking-tight">
              Operations Workbench
            </h1>
          </div>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            Fulfillment, assigned Support, verification, and platform inventory
            requiring your attention.
          </p>
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Live operational queue
            {data?.generatedAt ? (
              <span>
                · Updated{" "}
                {formatDistanceToNowStrict(new Date(data.generatedAt))} ago
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            title="Refresh Operations workbench"
          >
            <RefreshCw
              className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`}
            />
          </Button>
          <Button asChild>
            <Link href="/dashboard/fulfillment">
              Open My Fulfillment
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Needs attention"
          value={overview?.needsAttention ?? 0}
          icon={AlertTriangle}
          loading={loading}
          tone="attention"
        />
        <KpiCard
          label="My active"
          value={overview?.myActive ?? 0}
          icon={ClipboardList}
          loading={loading}
        />
        <KpiCard
          label="Available"
          value={overview?.available ?? 0}
          icon={UserPlus}
          loading={loading}
        />
        <KpiCard
          label="Ready to publish"
          value={overview?.readyToPublish ?? 0}
          icon={FileCheck2}
          loading={loading}
        />
        <KpiCard
          label="Verification issues"
          value={overview?.verificationIssues ?? 0}
          icon={ClipboardCheck}
          loading={loading}
        />
        <KpiCard
          label="Assigned Support"
          value={overview?.assignedSupport ?? 0}
          icon={HeadphonesIcon}
          loading={loading}
          tone="support"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.75fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle className="text-lg">Priority work queue</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Server-prioritized actions across your Operations workflows.
                </p>
              </div>
              <Badge variant="secondary">
                {data?.actionQueue.length ?? 0} visible
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="space-y-3 p-5">
                {Array.from({ length: 6 }).map((_, index) => (
                  <Skeleton key={index} className="h-16 w-full" />
                ))}
              </div>
            ) : data?.actionQueue.length ? (
              data.actionQueue.map((item) => (
                <QueueItem
                  key={`${item.type}:${item.id}`}
                  item={item}
                  onClaim={(orderId) => claim.mutate(orderId)}
                  claiming={claim.isPending && claim.variables === item.id}
                />
              ))
            ) : (
              <div className="py-16 text-center">
                <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
                <p className="mt-3 text-sm font-medium">No urgent work</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  New assigned and shared-queue work will appear here.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-blue-500/20">
          <CardHeader className="border-b bg-blue-500/[0.04]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <HeadphonesIcon className="h-5 w-5" /> Assigned Support
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Listing and order tickets routed to you.
                </p>
              </div>
              <div className="text-right">
                <div className="text-xl font-semibold">
                  {data?.support.assigned ?? 0}
                </div>
                <div className="text-xs text-muted-foreground">
                  {data?.support.overdue ?? 0} overdue
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="space-y-3 p-5">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-14 w-full" />
                ))}
              </div>
            ) : data?.support.items.length ? (
              <div className="divide-y">
                {data.support.items.slice(0, 6).map((ticket) => (
                  <Link
                    key={ticket.id}
                    href={`/dashboard/support/${ticket.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">
                          {ticket.subject}
                        </p>
                        {ticket.overdue ? (
                          <Badge variant="destructive">Overdue</Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {ticket.order?.websiteName ??
                          ticket.order?.title ??
                          "Assigned platform support"}
                      </p>
                      {ticket.order ? (
                        <Badge
                          className="mt-1"
                          variant={getOrderBadgeVariant(ticket.order.status)}
                        >
                          {ticket.order.status.replaceAll("_", " ")}
                        </Badge>
                      ) : null}
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </Link>
                ))}
              </div>
            ) : (
              <p className="px-5 py-12 text-center text-sm text-muted-foreground">
                No assigned Support tickets need a response.
              </p>
            )}
            <div className="border-t p-3">
              <Button variant="ghost" className="w-full" asChild>
                <Link href="/dashboard/support">
                  Open Support queue
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardList className="h-4 w-4" /> Fulfillment pipeline
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 p-3 pt-0">
            <LaneLink
              href="/dashboard/fulfillment"
              label="My active"
              value={data?.fulfillment.myActive ?? 0}
            />
            <LaneLink
              href="/dashboard/fulfillment"
              label="Waiting on customer"
              value={data?.fulfillment.waitingCustomer ?? 0}
            />
            <LaneLink
              href="/dashboard/fulfillment"
              label="Ready to publish"
              value={data?.fulfillment.readyToPublish ?? 0}
            />
            <LaneLink
              href="/dashboard/fulfillment"
              label="Verification"
              value={data?.fulfillment.verificationTotal ?? 0}
            />
            <LaneLink
              href="/dashboard/fulfillment"
              label="Available to claim"
              value={data?.fulfillment.available ?? 0}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Scale className="h-4 w-4" /> Resolution and trust
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 p-3 pt-0">
            <LaneLink
              href="/dashboard/support"
              label="Assigned Support"
              value={data?.support.assigned ?? 0}
            />
            <LaneLink
              href="/dashboard/cancellations"
              label="Cancellations"
              value={data?.resolution.cancellations ?? 0}
            />
            <LaneLink
              href="/dashboard/disputes"
              label="Disputes"
              value={data?.resolution.disputes ?? 0}
            />
            <LaneLink
              href="/dashboard/verification/delivery"
              label="Delivery verification"
              value={data?.resolution.deliveryVerification ?? 0}
            />
            <LaneLink
              href="/dashboard/verification"
              label="Domain verification"
              value={data?.resolution.domainVerification ?? 0}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Store className="h-4 w-4" /> Inventory readiness
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 p-3 pt-0">
            <LaneLink
              href="/dashboard/marketplace"
              label="Pending moderation"
              value={data?.inventory.pendingModeration ?? 0}
            />
            <LaneLink
              href="/dashboard/websites"
              label="Assigned listing issues"
              value={data?.inventory.assignedListingIssues ?? 0}
            />
            <LaneLink
              href="/dashboard/websites"
              label="Integration issues"
              value={data?.inventory.integrationIssues ?? 0}
            />
            <div className="mt-3 grid grid-cols-3 gap-2 border-t pt-4 text-center">
              <div>
                <div className="text-lg font-semibold">
                  {data?.fulfillment.claimed ?? 0}
                </div>
                <div className="text-[11px] text-muted-foreground">Claimed</div>
              </div>
              <div>
                <div className="text-lg font-semibold">
                  {data?.fulfillment.completed ?? 0}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Completed
                </div>
              </div>
              <div>
                <CircleDollarSign className="mx-auto h-4 w-4 text-muted-foreground" />
                <div
                  className="mt-1 truncate text-xs font-semibold"
                  title={formatMoney(data?.fulfillment.salesByCurrency)}
                >
                  {formatMoney(data?.fulfillment.salesByCurrency)}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
