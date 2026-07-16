"use client"

import type { CancellationReasonCode } from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
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
  ClipboardList,
  Eye,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  UserPlus,
  XCircle,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

const verifyBadge: Record<string, { variant: any; Icon: any }> = {
  VERIFIED: { variant: "success", Icon: ShieldCheck },
  PENDING: { variant: "secondary", Icon: ShieldAlert },
  RETRYING: { variant: "warning", Icon: RefreshCw },
  FAILED: { variant: "destructive", Icon: ShieldX },
  MANUAL_REVIEW: { variant: "warning", Icon: ShieldAlert },
}

function DeliveryReview({
  orderId,
  onClose,
}: {
  orderId: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const isSuperAdmin = user?.staffRole === "SUPER_ADMIN"
  const canFulfill =
    user?.staffRole === "SUPER_ADMIN" || user?.staffRole === "OPERATIONS"
  const [reason, setReason] = useState("")

  const { data: deliveries = [], isLoading } = useQuery({
    queryKey: ["admin-deliveries", orderId],
    queryFn: () => api.admin.listDeliveries(orderId),
  })

  const act = (fn: () => Promise<any>, ok: string) =>
    fn()
      .then(() => {
        toast.success(ok)
        qc.invalidateQueries({ queryKey: ["admin-deliveries", orderId] })
        qc.invalidateQueries({ queryKey: ["fulfillment-queue"] })
      })
      .catch((e: any) => toast.error(e?.message || "Action failed"))

  const active = deliveries[0]

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Delivery review — order {orderId.slice(0, 8)}
          </DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No deliveries submitted yet.
          </p>
        ) : (
          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            {deliveries.map((d: any) => {
              const v = verifyBadge[d.verificationStatus] ?? verifyBadge.PENDING
              const ev = d.evidence?.[0]
              return (
                <div key={d.id} className="rounded-lg border p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant={v.variant} className="gap-1">
                        <v.Icon className="h-3 w-3" />
                        {d.verificationStatus}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        v{d.version}
                        {d.supersededByVersion
                          ? ` (superseded by v${d.supersededByVersion})`
                          : " (active)"}
                      </span>
                      {d.interventionStatus !== "NONE" && (
                        <Badge variant="outline">{d.interventionStatus}</Badge>
                      )}
                    </div>
                    <a
                      href={d.publishedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline flex items-center gap-1"
                    >
                      Open <Eye className="h-3 w-3" />
                    </a>
                  </div>
                  <div className="text-sm break-all">{d.publishedUrl}</div>
                  {ev && (
                    <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
                      <span>HTTP {ev.httpStatus}</span>
                      <span>Link found: {ev.linkFound ? "✓" : "✗"}</span>
                      <span>
                        Target matched: {ev.targetUrlMatched ? "✓" : "✗"}
                      </span>
                      <span>Anchor: {ev.anchorFound ? "✓" : "✗"}</span>
                      {ev.pageTitle && (
                        <span className="col-span-2">
                          Title: {ev.pageTitle}
                        </span>
                      )}
                    </div>
                  )}
                  {d.verificationFailureReason && (
                    <p className="text-xs text-destructive">
                      {d.verificationFailureReason}
                    </p>
                  )}
                  {!d.supersededByVersion && canFulfill && (
                    <div className="flex flex-wrap gap-2 pt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          act(
                            () => api.admin.reverifyDelivery(d.id),
                            "Re-verification queued",
                          )
                        }
                      >
                        <RefreshCw className="h-3 w-3 mr-1" /> Re-verify
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={reason.trim().length < 20}
                        onClick={() =>
                          act(
                            () => api.admin.manualApproveDelivery(d.id, reason),
                            "Approved",
                          )
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={reason.trim().length < 20}
                        onClick={() =>
                          act(
                            () => api.admin.manualRejectDelivery(d.id, reason),
                            "Rejected",
                          )
                        }
                      >
                        Reject
                      </Button>
                      {isSuperAdmin && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={reason.trim().length < 20}
                            onClick={() =>
                              act(
                                () =>
                                  api.admin.overrideDelivery(
                                    d.id,
                                    "VERIFIED",
                                    reason,
                                  ),
                                "Overridden -> VERIFIED",
                              )
                            }
                          >
                            Override→Verified
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={reason.trim().length < 20}
                            onClick={() =>
                              act(
                                () =>
                                  api.admin.overrideDelivery(
                                    d.id,
                                    "FAILED",
                                    reason,
                                  ),
                                "Overridden -> FAILED",
                              )
                            }
                          >
                            Override→Failed
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                  {d.fraudFlags?.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {d.fraudFlags.map((f: any) => (
                        <Badge key={f.id} variant="destructive">
                          {f.type}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {active && !active.supersededByVersion && (
          <div className="space-y-1">
            <Input
              placeholder="Reason for manual action (min 20 chars, required for approve/reject/override)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function FulfillmentPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [reviewOrderId, setReviewOrderId] = useState<string | null>(null)
  const [cancelOrder, setCancelOrder] = useState<any | null>(null)
  const [cancelReason, setCancelReason] = useState<CancellationReasonCode>(
    "CAPACITY_UNAVAILABLE",
  )
  const [cancelNote, setCancelNote] = useState("")

  const {
    data: cancellationPreview,
    isLoading: isPreviewLoading,
    error: previewError,
  } = useQuery({
    queryKey: ["platform-cancellation-preview", cancelOrder?.id],
    queryFn: () => api.admin.previewPlatformCancellation(cancelOrder.id),
    enabled: Boolean(cancelOrder),
    retry: false,
  })
  const isImmediateDecline = cancellationPreview?.action === "DECLINE_NOW"

  const {
    data: queue = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["fulfillment-queue"],
    queryFn: () => api.admin.fulfillmentQueue(),
  })

  const claim = useMutation({
    mutationFn: (orderId: string) => api.admin.claimOrder(orderId),
    onSuccess: () => {
      toast.success("Order claimed")
      qc.invalidateQueries({ queryKey: ["fulfillment-queue"] })
    },
    onError: (e: any) => toast.error(e?.message || "Failed to claim"),
  })

  const cancel = useMutation({
    mutationFn: () => {
      if (!cancelOrder) throw new Error("No order selected")
      const data = {
        reasonCode: cancelReason,
        note: cancelNote.trim() || undefined,
        expectedVersion: cancelOrder.version,
        idempotencyKey: `operations-${cancelOrder.id}-${cancelOrder.version}`,
      }
      if (!cancellationPreview)
        throw new Error("Cancellation policy unavailable")
      return isImmediateDecline
        ? api.admin.declinePlatformOrder(cancelOrder.id, data)
        : cancellationPreview.action === "REQUEST_CANCELLATION"
          ? api.admin.requestPlatformCancellation(cancelOrder.id, data)
          : Promise.reject(new Error(cancellationPreview.message))
    },
    onSuccess: () => {
      toast.success(
        isImmediateDecline
          ? "Order declined and customer refunded"
          : "Cancellation request sent to the customer",
      )
      setCancelOrder(null)
      setCancelNote("")
      qc.invalidateQueries({ queryKey: ["fulfillment-queue"] })
    },
    onError: (error: Error) =>
      toast.error(error.message || "Cancellation failed"),
  })

  if (error)
    return (
      <ErrorState
        title="Failed to load fulfillment queue"
        description={(error as Error).message}
        onRetry={() =>
          qc.invalidateQueries({ queryKey: ["fulfillment-queue"] })
        }
      />
    )

  // Group by current verification/assignment state
  const sections: Record<string, any[]> = {
    Assigned: [],
    "In Progress": [],
    "Awaiting Verification": [],
    "Failed Verification": [],
    "Manual Review": [],
  }
  for (const o of queue) {
    const dv = o.deliveryVersions?.[0]
    const asg = o.fulfillmentAssignments?.[0]
    if (dv?.verificationStatus === "MANUAL_REVIEW")
      sections["Manual Review"].push(o)
    else if (dv?.verificationStatus === "FAILED")
      sections["Failed Verification"].push(o)
    else if (dv && ["PENDING", "RETRYING"].includes(dv.verificationStatus))
      sections["Awaiting Verification"].push(o)
    else if (asg?.status === "IN_PROGRESS") sections["In Progress"].push(o)
    else sections.Assigned.push(o)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <ClipboardList className="h-7 w-7" /> Platform Fulfillment
        </h1>
        <p className="text-muted-foreground">
          Operations queue for platform-owned orders. Same verification +
          settlement path as publisher inventory.
        </p>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : queue.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No platform orders in the queue.
          </CardContent>
        </Card>
      ) : (
        Object.entries(sections).map(([name, orders]) => (
          <Card key={name}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {name}{" "}
                <span className="text-muted-foreground">({orders.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {orders.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>Website</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Verification</TableHead>
                      <TableHead>Assignee</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((o: any) => {
                      const dv = o.deliveryVersions?.[0]
                      const asg = o.fulfillmentAssignments?.[0]
                      const vb = dv
                        ? (verifyBadge[dv.verificationStatus] ??
                          verifyBadge.PENDING)
                        : null
                      const canActForOrder =
                        user?.staffRole === "SUPER_ADMIN" ||
                        asg?.assignedToUserId === user?.id
                      return (
                        <TableRow key={o.id}>
                          <TableCell className="font-mono text-xs">
                            {o.id.slice(0, 8)}
                          </TableCell>
                          <TableCell className="text-sm">
                            {o.website?.domain ?? o.website?.url ?? "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{o.status}</Badge>
                          </TableCell>
                          <TableCell>
                            {vb ? (
                              <Badge variant={vb.variant} className="gap-1">
                                <vb.Icon className="h-3 w-3" />
                                {dv.verificationStatus}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                —
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {asg && asg.status !== "CANCELLED" ? (
                              asg.assignedToUserId.slice(0, 8)
                            ) : (
                              <span className="text-muted-foreground">
                                unassigned
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              {(!asg || asg.status === "CANCELLED") && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => claim.mutate(o.id)}
                                >
                                  <UserPlus className="h-3 w-3 mr-1" />
                                  Claim
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setReviewOrderId(o.id)}
                              >
                                <Eye className="h-3 w-3 mr-1" />
                                Review
                              </Button>
                              {canActForOrder && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-destructive"
                                  onClick={() => setCancelOrder(o)}
                                >
                                  <XCircle className="h-3 w-3 mr-1" />
                                  Cancellation
                                </Button>
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
        ))
      )}

      {reviewOrderId && (
        <DeliveryReview
          orderId={reviewOrderId}
          onClose={() => setReviewOrderId(null)}
        />
      )}

      <Dialog
        open={Boolean(cancelOrder)}
        onOpenChange={(open) => !open && setCancelOrder(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isImmediateDecline
                ? "Decline platform order"
                : "Request platform cancellation"}
            </DialogTitle>
            <DialogDescription>
              {isPreviewLoading
                ? "Checking the current cancellation policy…"
                : previewError
                  ? (previewError as Error).message
                  : cancellationPreview?.message}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
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
                  <SelectItem value="CAPACITY_UNAVAILABLE">
                    Capacity unavailable
                  </SelectItem>
                  <SelectItem value="WEBSITE_UNAVAILABLE">
                    Website unavailable
                  </SelectItem>
                  <SelectItem value="POLICY_CONFLICT">
                    Policy conflict
                  </SelectItem>
                  <SelectItem value="PRICING_ERROR">Pricing error</SelectItem>
                  <SelectItem value="PLATFORM_ERROR">Platform error</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Textarea
              value={cancelNote}
              onChange={(event) => setCancelNote(event.target.value)}
              placeholder="Explain the operational reason"
              rows={4}
              maxLength={2000}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOrder(null)}>
              Keep Order
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancel.mutate()}
              disabled={
                cancel.isPending ||
                isPreviewLoading ||
                Boolean(previewError) ||
                !cancellationPreview ||
                cancellationPreview.action === "NOT_ALLOWED"
              }
            >
              {cancel.isPending
                ? "Submitting…"
                : isImmediateDecline
                  ? "Decline and Refund"
                  : "Send Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
