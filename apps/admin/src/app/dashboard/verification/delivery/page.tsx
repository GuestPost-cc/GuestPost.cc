"use client"

import type { AdminDeliveryVerificationQueueItem } from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
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
import { format } from "date-fns"
import {
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Ticket,
} from "lucide-react"
import Link from "next/link"
import { Fragment, useState } from "react"
import { toast } from "sonner"
import {
  AdminEmptyState,
  AdminPage,
  AdminPageHeader,
} from "../../../../components/admin-workspace"
import { api } from "../../../../lib/api"
import { ForbiddenPage, useRequireRole } from "../../../../lib/use-require-role"

const priorityBadge: Record<string, { variant: any; label: string }> = {
  CRITICAL: { variant: "destructive", label: "Critical" },
  HIGH: { variant: "warning", label: "High" },
  MEDIUM: { variant: "secondary", label: "Medium" },
  LOW: { variant: "default", label: "Low" },
}

export default function DeliveryVerificationQueuePage() {
  const { allowed, loading } = useRequireRole("SUPER_ADMIN", "OPERATIONS")
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Operations or Super Admin" />
  return <DeliveryVerificationQueuePageInner />
}

function DeliveryVerificationQueuePageInner() {
  const qc = useQueryClient()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [actionDialog, setActionDialog] = useState<{
    mode: "verify" | "reject"
    id: string
    orderId: string
  } | null>(null)
  const [reason, setReason] = useState("")
  const [notes, setNotes] = useState("")
  const [ticketId, setTicketId] = useState("")
  const [reverifyId, setReverifyId] = useState<string | null>(null)

  const {
    data: queue,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["delivery-verification-queue"],
    queryFn: () => api.admin.listVerificationQueue(),
  })

  const retry = useMutation({
    mutationFn: (id: string) => api.admin.retryVerification(id),
    onSuccess: () => {
      toast.success("Verification queued for retry")
      qc.invalidateQueries({ queryKey: ["delivery-verification-queue"] })
    },
    onError: () => toast.error("Failed to retry verification"),
  })

  const markVerified = useMutation({
    mutationFn: (args: { id: string; reason: string; notes?: string }) =>
      api.admin.markVerified(args.id, {
        reason: args.reason,
        notes: args.notes,
      }),
    onSuccess: () => {
      toast.success("Order marked as verified")
      setActionDialog(null)
      setReason("")
      setNotes("")
      qc.invalidateQueries({ queryKey: ["delivery-verification-queue"] })
    },
    onError: () => toast.error("Failed to mark as verified"),
  })

  const reject = useMutation({
    mutationFn: (args: { id: string; reason: string }) =>
      api.admin.rejectVerification(args.id, { reason: args.reason }),
    onSuccess: () => {
      toast.success("Verification rejected")
      setActionDialog(null)
      setReason("")
      qc.invalidateQueries({ queryKey: ["delivery-verification-queue"] })
    },
    onError: () => toast.error("Failed to reject verification"),
  })

  const requestReverify = useMutation({
    mutationFn: (args: { id: string; ticketId: string }) =>
      api.admin.requestReverify(args.id, { ticketId: args.ticketId }),
    onSuccess: () => {
      toast.success("Publisher requested to re-verify")
      setReverifyId(null)
      setTicketId("")
      qc.invalidateQueries({ queryKey: ["delivery-verification-queue"] })
    },
    onError: () => toast.error("Failed to request re-verification"),
  })

  const items = queue ?? []

  return (
    <AdminPage>
      <AdminPageHeader
        eyebrow="Evidence review queue"
        title="Delivery verification"
        description="Review deliveries that failed automated checks or require manual evidence review, ordered by priority."
        icon={ShieldCheck}
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
        badges={
          !isLoading ? (
            <Badge variant="secondary">{items.length} queued</Badge>
          ) : null
        }
      />

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <ErrorState
          title="Failed to load verification queue"
          description={(error as Error).message}
          onRetry={() => refetch()}
        />
      ) : items.length === 0 ? (
        <Card>
          <AdminEmptyState
            title="No deliveries need review"
            description="Failed and manual-review deliveries will appear here automatically."
          />
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Website</TableHead>
                  <TableHead>Fulfilled By</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item: AdminDeliveryVerificationQueueItem) => {
                  const delivery = item.deliveryVersion
                  const verificationStatus =
                    delivery?.verificationStatus ?? "UNKNOWN"
                  const fulfilledBy =
                    item.website?.ownershipType === "PLATFORM"
                      ? "Platform"
                      : (item.publisher?.name ??
                        item.publisher?.email ??
                        "Publisher")

                  return (
                    <Fragment key={item.orderId}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() =>
                          setExpandedId(
                            expandedId === item.orderId ? null : item.orderId,
                          )
                        }
                      >
                        <TableCell>
                          <Link
                            href={`/dashboard/orders/${item.orderId}`}
                            className="block max-w-52 truncate text-sm font-medium hover:underline"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {item.title || `Order ${item.orderId.slice(0, 8)}`}
                          </Link>
                          <span className="font-mono text-xs text-muted-foreground">
                            {item.orderId.slice(0, 8)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="block max-w-48 truncate text-sm font-medium">
                            {item.website?.domain ?? item.website?.name ?? "—"}
                          </span>
                          {item.website?.url && (
                            <span className="block max-w-48 truncate text-xs text-muted-foreground">
                              {item.website.url}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <span className="text-sm">{fulfilledBy}</span>
                            {item.publisher?.tier && (
                              <Badge variant="outline">
                                {item.publisher.tier.replace(/_/g, " ")}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              priorityBadge[item.priority.label]?.variant ??
                              "default"
                            }
                          >
                            {priorityBadge[item.priority.label]?.label ??
                              item.priority.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              verificationStatus === "FAILED"
                                ? "destructive"
                                : verificationStatus === "MANUAL_REVIEW"
                                  ? "warning"
                                  : "secondary"
                            }
                          >
                            {verificationStatus.replace(/_/g, " ")}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {delivery?.version ?? "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {delivery?.submittedAt
                            ? format(
                                new Date(delivery.submittedAt),
                                "MMM d, HH:mm",
                              )
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={retry.isPending}
                              onClick={(e) => {
                                e.stopPropagation()
                                retry.mutate(item.orderId)
                              }}
                            >
                              <RefreshCw className="h-3.5 w-3.5 mr-1" />
                              Retry
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-green-600"
                              onClick={(e) => {
                                e.stopPropagation()
                                setActionDialog({
                                  mode: "verify",
                                  id: item.orderId,
                                  orderId: item.orderId,
                                })
                              }}
                            >
                              <ShieldCheck className="h-3.5 w-3.5 mr-1" />
                              Verify
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-red-600"
                              onClick={(e) => {
                                e.stopPropagation()
                                setActionDialog({
                                  mode: "reject",
                                  id: item.orderId,
                                  orderId: item.orderId,
                                })
                              }}
                            >
                              <ShieldX className="h-3.5 w-3.5 mr-1" />
                              Reject
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {expandedId === item.orderId && (
                        <TableRow>
                          <TableCell colSpan={8} className="bg-muted/30 p-4">
                            <div className="space-y-3">
                              <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                                <div>
                                  <p className="text-xs text-muted-foreground">
                                    Order
                                  </p>
                                  <p className="font-mono text-xs">
                                    {item.orderId}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground">
                                    Customer
                                  </p>
                                  <p>
                                    {item.customer?.name ??
                                      item.customer?.email ??
                                      "—"}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground">
                                    Target URL
                                  </p>
                                  <p className="break-all text-xs">
                                    {item.targetUrl ?? "—"}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground">
                                    Anchor text
                                  </p>
                                  <p>{item.anchorText ?? "—"}</p>
                                </div>
                              </div>

                              {delivery?.verificationFailureReason && (
                                <div>
                                  <strong className="text-sm">
                                    Failure reason
                                  </strong>
                                  <p className="mt-1 text-sm text-destructive">
                                    {delivery.verificationFailureReason}
                                  </p>
                                </div>
                              )}

                              {delivery?.evidence && (
                                <div className="space-y-1">
                                  <strong className="text-sm">
                                    Diagnostics
                                  </strong>
                                  <div className="grid gap-2 rounded border bg-background p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                                    <p>HTTP {delivery.evidence.httpStatus}</p>
                                    <p>
                                      Link{" "}
                                      {delivery.evidence.linkFound
                                        ? "found"
                                        : "missing"}
                                    </p>
                                    <p>
                                      Target{" "}
                                      {delivery.evidence.targetUrlMatched
                                        ? "matched"
                                        : "mismatched"}
                                    </p>
                                    <p>
                                      Anchor{" "}
                                      {delivery.evidence.anchorFound
                                        ? "found"
                                        : "missing"}
                                    </p>
                                  </div>
                                </div>
                              )}

                              {delivery?.publishedUrl && (
                                <div className="flex items-center gap-2">
                                  <strong className="text-sm">
                                    Published URL:
                                  </strong>
                                  <a
                                    href={delivery.publishedUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex min-w-0 items-center gap-1 break-all text-xs text-primary hover:underline"
                                  >
                                    {delivery.publishedUrl}
                                    <ExternalLink className="h-3 w-3 shrink-0" />
                                  </a>
                                </div>
                              )}

                              {delivery && delivery.fraudFlags.length > 0 && (
                                <div className="flex flex-wrap items-center gap-2">
                                  <strong className="text-sm">
                                    Fraud flags:
                                  </strong>
                                  {delivery.fraudFlags.map((flag, index) => (
                                    <Badge
                                      key={`${flag.type}-${index}`}
                                      variant="destructive"
                                    >
                                      {flag.type.replace(/_/g, " ")}
                                    </Badge>
                                  ))}
                                </div>
                              )}

                              <div className="flex items-center gap-2 pt-1">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setReverifyId(item.orderId)
                                    setTicketId("")
                                  }}
                                >
                                  <Ticket className="h-3.5 w-3.5 mr-1" />
                                  Request Re-verify
                                </Button>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={actionDialog !== null}
        onOpenChange={() => {
          setActionDialog(null)
          setReason("")
          setNotes("")
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionDialog?.mode === "verify"
                ? "Mark Order as Verified"
                : "Reject Verification"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              {actionDialog?.mode === "verify"
                ? "Confirm that the delivery has been manually verified. This will approve the order."
                : "Reject the delivery verification. This will require the publisher to resubmit."}
            </p>
            <Textarea
              placeholder="Reason (required, min 10 characters)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {actionDialog?.mode === "verify" && (
              <Textarea
                placeholder="Notes (optional)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setActionDialog(null)
                setReason("")
                setNotes("")
              }}
            >
              Cancel
            </Button>
            <Button
              variant={
                actionDialog?.mode === "verify" ? "default" : "destructive"
              }
              disabled={reason.length < 10}
              onClick={() => {
                if (!actionDialog) return
                if (actionDialog.mode === "verify") {
                  markVerified.mutate({
                    id: actionDialog.id,
                    reason,
                    notes: notes || undefined,
                  })
                } else {
                  reject.mutate({
                    id: actionDialog.id,
                    reason,
                  })
                }
              }}
            >
              {actionDialog?.mode === "verify" ? "Confirm Verify" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={reverifyId !== null}
        onOpenChange={() => {
          setReverifyId(null)
          setTicketId("")
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Re-verification</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              Link a support ticket to request the publisher re-verify their
              delivery.
            </p>
            <Textarea
              placeholder="Ticket ID"
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setReverifyId(null)
                setTicketId("")
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!ticketId.trim() || requestReverify.isPending}
              onClick={() => {
                if (reverifyId && ticketId.trim()) {
                  requestReverify.mutate({
                    id: reverifyId,
                    ticketId: ticketId.trim(),
                  })
                }
              }}
            >
              <Ticket className="h-4 w-4 mr-2" />
              Request Re-verify
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
