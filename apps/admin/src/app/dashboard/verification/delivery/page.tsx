"use client"

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
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Ticket,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"

const priorityBadge: Record<string, { variant: any; label: string }> = {
  CRITICAL: { variant: "destructive", label: "Critical" },
  HIGH: { variant: "warning", label: "High" },
  MEDIUM: { variant: "secondary", label: "Medium" },
  LOW: { variant: "default", label: "Low" },
}

export default function DeliveryVerificationQueuePage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const canAct =
    user?.staffRole === "SUPER_ADMIN" || user?.staffRole === "OPERATIONS"

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

  const items: any[] = queue ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Delivery Verification Queue
          </h1>
          <p className="text-muted-foreground mt-1">
            Orders pending or failed delivery verification, sorted by priority
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <ErrorState
          title="Failed to load verification queue"
          onRetry={() => refetch()}
        />
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <CheckCircle2 className="h-12 w-12 text-green-500 mb-4" />
            <p className="text-lg font-medium">All caught up</p>
            <p className="text-muted-foreground text-sm">
              No orders pending delivery verification
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Publisher</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Last Verified</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item: any) => (
                  <>
                    <TableRow
                      key={item.id}
                      className="cursor-pointer"
                      onClick={() =>
                        setExpandedId(expandedId === item.id ? null : item.id)
                      }
                    >
                      <TableCell className="font-mono text-xs">
                        {item.orderId?.slice(0, 8)}
                      </TableCell>
                      <TableCell>
                        {item.publisherName ??
                          item.publisherId?.slice(0, 8) ??
                          "—"}
                      </TableCell>
                      <TableCell>
                        {item.priority ? (
                          <Badge
                            variant={
                              priorityBadge[item.priority.label]?.variant ??
                              "default"
                            }
                          >
                            {priorityBadge[item.priority.label]?.label ??
                              item.priority.label}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            item.status === "VERIFIED"
                              ? "success"
                              : item.status === "FAILED"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {item.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {item.attempts ?? 0}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {item.lastVerifiedAt
                          ? format(
                              new Date(item.lastVerifiedAt),
                              "MMM d, HH:mm",
                            )
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canAct || retry.isPending}
                            onClick={(e) => {
                              e.stopPropagation()
                              retry.mutate(item.id)
                            }}
                          >
                            <RefreshCw className="h-3.5 w-3.5 mr-1" />
                            Retry
                          </Button>
                          {canAct && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-green-600"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setActionDialog({
                                    mode: "verify",
                                    id: item.id,
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
                                    id: item.id,
                                    orderId: item.orderId,
                                  })
                                }}
                              >
                                <ShieldX className="h-3.5 w-3.5 mr-1" />
                                Reject
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {expandedId === item.id && (
                      <TableRow key={`${item.id}-detail`}>
                        <TableCell colSpan={7} className="bg-muted/30 p-4">
                          <div className="space-y-3">
                            <div className="flex items-center gap-2">
                              <strong className="text-sm">Order:</strong>
                              <span className="font-mono text-xs">
                                {item.orderId}
                              </span>
                            </div>

                            {item.diagnostics && (
                              <div className="space-y-1">
                                <strong className="text-sm">Diagnostics</strong>
                                <div className="bg-background rounded border p-3 space-y-1 text-xs font-mono">
                                  {item.diagnostics.reason && (
                                    <p>
                                      <span className="text-muted-foreground">
                                        Reason:
                                      </span>{" "}
                                      {item.diagnostics.reason}
                                    </p>
                                  )}
                                  {item.diagnostics.httpStatus && (
                                    <p>
                                      <span className="text-muted-foreground">
                                        HTTP Status:
                                      </span>{" "}
                                      {item.diagnostics.httpStatus}
                                    </p>
                                  )}
                                  {item.diagnostics.error && (
                                    <p>
                                      <span className="text-muted-foreground">
                                        Error:
                                      </span>{" "}
                                      {item.diagnostics.error}
                                    </p>
                                  )}
                                  {item.diagnostics.redirectChain && (
                                    <p>
                                      <span className="text-muted-foreground">
                                        Redirect Chain:
                                      </span>{" "}
                                      {item.diagnostics.redirectChain}
                                    </p>
                                  )}
                                </div>
                              </div>
                            )}

                            {item.url && (
                              <div className="flex items-center gap-2">
                                <strong className="text-sm">URL:</strong>
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:underline text-xs flex items-center gap-1"
                                >
                                  {item.url}
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </div>
                            )}

                            <div className="flex items-center gap-2 pt-1">
                              {canAct && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setReverifyId(item.id)
                                    setTicketId("")
                                  }}
                                >
                                  <Ticket className="h-3.5 w-3.5 mr-1" />
                                  Request Re-verify
                                </Button>
                              )}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                ))}
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
    </div>
  )
}
