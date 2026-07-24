"use client"

import type { DisputeStatus } from "@guestpost/database"
import {
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  getDisputeStatusPresentation,
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
import { format, formatDistanceToNow } from "date-fns"
import {
  AlertTriangle,
  Clock,
  DollarSign,
  FileSearch,
  RotateCcw,
  Scale,
  XCircle,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import {
  AdminFilterBar,
  AdminMetricCard,
  AdminPage,
  AdminPageHeader,
} from "../../../components/admin-workspace"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

// Phase 7.9 #28 — dispute status presentation comes from
// getDisputeStatusPresentation in @guestpost/ui. Local map deleted.

type ResolveAction = "RESTORE" | "REFUND" | "REJECT"
type RefundResponsibility =
  | "CUSTOMER"
  | "PUBLISHER"
  | "PLATFORM"
  | "SHARED"
  | "SYSTEM"

export default function DisputesPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const canResolveOperationally =
    user?.staffRole === "SUPER_ADMIN" || user?.staffRole === "OPERATIONS"
  const canApproveRefund =
    user?.staffRole === "SUPER_ADMIN" || user?.staffRole === "FINANCE"
  const [status, setStatus] = useState("all")
  const [resolveTarget, setResolveTarget] = useState<{
    id: string
    action: ResolveAction
  } | null>(null)
  const [reason, setReason] = useState("")
  const [responsibility, setResponsibility] = useState<
    RefundResponsibility | ""
  >("")

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "disputes", status],
    queryFn: () =>
      api.admin.listDisputes({ status: status === "all" ? undefined : status }),
  })

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["admin", "disputes"] })

  const review = useMutation({
    mutationFn: (id: string) => api.admin.reviewDispute(id),
    onSuccess: () => {
      toast.success("Marked under review")
      refresh()
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  })

  const resolve = useMutation({
    mutationFn: ({
      id,
      action,
      resolution,
      responsibility,
    }: {
      id: string
      action: ResolveAction
      resolution: string
      responsibility?: RefundResponsibility
    }) => api.admin.resolveDispute(id, action, resolution, responsibility),
    onSuccess: () => {
      toast.success("Dispute resolved")
      setResolveTarget(null)
      setReason("")
      setResponsibility("")
      refresh()
      qc.invalidateQueries({ queryKey: ["admin", "orders"] })
    },
    onError: (e: any) => toast.error(e?.message || "Failed to resolve"),
  })

  if (error)
    return (
      <ErrorState
        title="Failed to load disputes"
        description={(error as Error).message}
        onRetry={() => refetch()}
      />
    )

  const items = data?.items ?? []
  const counts = data?.counts ?? { open: 0, underReview: 0, active: 0 }

  return (
    <AdminPage>
      <AdminPageHeader
        eyebrow="Protected resolution workflow"
        title="Disputes"
        description="Customer disputes pause settlement until resolved. Operations reviews evidence; Finance or Super Admin approves refund outcomes."
        icon={Scale}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <AdminMetricCard
          label="Open"
          value={counts.open}
          icon={AlertTriangle}
          tone={counts.open > 0 ? "danger" : "success"}
        />
        <AdminMetricCard
          label="Under review"
          value={counts.underReview}
          icon={Clock}
          tone={counts.underReview > 0 ? "warning" : "success"}
        />
        <AdminMetricCard
          label="Active total"
          value={counts.active}
          icon={Scale}
          tone={counts.active > 0 ? "info" : "success"}
        />
      </div>

      <AdminFilterBar
        activeCount={status === "all" ? 0 : 1}
        resultCount={items.length}
        resultLabel={items.length === 1 ? "dispute" : "disputes"}
        onClear={() => setStatus("all")}
      >
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-full bg-background sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All disputes</SelectItem>
            <SelectItem value="OPEN">Open</SelectItem>
            <SelectItem value="UNDER_REVIEW">Under Review</SelectItem>
            <SelectItem value="RESOLVED_REFUNDED">Refunded</SelectItem>
            <SelectItem value="RESOLVED_REJECTED">Rejected</SelectItem>
            <SelectItem value="RESOLVED_RESTORED">Restored</SelectItem>
          </SelectContent>
        </Select>
      </AdminFilterBar>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Scale className="h-12 w-12 text-muted-foreground/40" />
              <h3 className="mt-4 text-lg font-medium">No disputes</h3>
              <p className="text-sm text-muted-foreground">
                Nothing matches this filter.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Raised</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((d: any) => {
                  const sb = getDisputeStatusPresentation(
                    d.status as DisputeStatus,
                  )
                  const active =
                    d.status === "OPEN" || d.status === "UNDER_REVIEW"
                  return (
                    <TableRow key={d.id}>
                      <TableCell
                        className="whitespace-nowrap text-sm"
                        title={format(new Date(d.createdAt), "PPpp")}
                      >
                        {formatDistanceToNow(new Date(d.createdAt), {
                          addSuffix: true,
                        })}
                      </TableCell>
                      <TableCell>
                        <a
                          href={`/dashboard/orders?focus=${d.orderId}`}
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          #{d.orderId.slice(0, 8)}
                        </a>
                        <div className="text-xs text-muted-foreground">
                          {d.order?.title ?? "—"}
                        </div>
                        {d.order?.website?.domain && (
                          <div className="text-xs text-muted-foreground">
                            {d.order.website.domain}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {d.order?.customer?.name ?? "—"}
                        <div className="text-xs text-muted-foreground">
                          {d.order?.customer?.email}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {d.order?.amount != null
                          ? `$${d.order.amount.toLocaleString()}`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge variant={sb.variant}>
                          {sb.label}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="max-w-[240px]">
                        <span
                          className="block truncate text-sm"
                          title={d.reason}
                        >
                          {d.reason}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" variant="outline" asChild>
                            <a href={`/dashboard/disputes/${d.id}/evidence`}>
                              <FileSearch className="mr-1 h-3.5 w-3.5" />
                              Evidence
                            </a>
                          </Button>
                          {active &&
                            (canResolveOperationally || canApproveRefund) && (
                              <>
                                {canResolveOperationally &&
                                  d.status === "OPEN" && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => review.mutate(d.id)}
                                      title="Mark under review"
                                    >
                                      <Clock className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                {canResolveOperationally && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-emerald-600"
                                    title="Restore order"
                                    onClick={() =>
                                      setResolveTarget({
                                        id: d.id,
                                        action: "RESTORE",
                                      })
                                    }
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                {canApproveRefund && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-blue-600"
                                    title="Refund customer"
                                    onClick={() =>
                                      setResolveTarget({
                                        id: d.id,
                                        action: "REFUND",
                                      })
                                    }
                                  >
                                    <DollarSign className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                {canResolveOperationally && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-destructive"
                                    title="Reject dispute"
                                    onClick={() =>
                                      setResolveTarget({
                                        id: d.id,
                                        action: "REJECT",
                                      })
                                    }
                                  >
                                    <XCircle className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                              </>
                            )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!resolveTarget}
        onOpenChange={(o) => {
          if (!o) {
            setResolveTarget(null)
            setReason("")
            setResponsibility("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {resolveTarget?.action === "RESTORE" && "Restore order"}
              {resolveTarget?.action === "REFUND" && "Refund customer"}
              {resolveTarget?.action === "REJECT" && "Reject dispute"}
            </DialogTitle>
            <DialogDescription>
              {resolveTarget?.action === "RESTORE" &&
                "Return the order to its pre-dispute state and resume the workflow."}
              {resolveTarget?.action === "REFUND" &&
                "Refund the customer. Any publisher settlement is reversed."}
              {resolveTarget?.action === "REJECT" &&
                "Dismiss the dispute and return the order to its prior state."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Resolution note (recorded in the audit trail)..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={1000}
          />
          {resolveTarget?.action === "REFUND" && (
            <Select
              value={responsibility}
              onValueChange={(value) =>
                setResponsibility(value as RefundResponsibility)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Who is responsible for the refund?" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PUBLISHER">Publisher</SelectItem>
                <SelectItem value="PLATFORM">Platform</SelectItem>
                <SelectItem value="CUSTOMER">Customer</SelectItem>
                <SelectItem value="SHARED">Shared responsibility</SelectItem>
                <SelectItem value="SYSTEM">System/technical failure</SelectItem>
              </SelectContent>
            </Select>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setResolveTarget(null)
                setReason("")
                setResponsibility("")
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={
                resolve.isPending ||
                reason.trim().length < 10 ||
                (resolveTarget?.action === "REFUND" && !responsibility)
              }
              onClick={() =>
                resolveTarget &&
                resolve.mutate({
                  id: resolveTarget.id,
                  action: resolveTarget.action,
                  resolution: reason.trim(),
                  responsibility:
                    resolveTarget.action === "REFUND" && responsibility
                      ? responsibility
                      : undefined,
                })
              }
            >
              {resolve.isPending ? "Resolving..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
