"use client"

import type {
  AdminDeliveryVerificationQueueItem,
  DeliveryFraudDisposition,
} from "@guestpost/api-client"
import {
  Badge,
  type BadgeProps,
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
  Input,
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
import { format } from "date-fns"
import {
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Ticket,
} from "lucide-react"
import Link from "next/link"
import { Fragment, useRef, useState } from "react"
import { toast } from "sonner"
import {
  AdminEmptyState,
  AdminPage,
  AdminPageHeader,
} from "../../../../components/admin-workspace"
import { api } from "../../../../lib/api"
import { ForbiddenPage, useRequireRole } from "../../../../lib/use-require-role"

const priorityBadge: Record<
  string,
  { variant: BadgeProps["variant"]; label: string }
> = {
  CRITICAL: { variant: "destructive", label: "Critical" },
  HIGH: { variant: "warning", label: "High" },
  MEDIUM: { variant: "secondary", label: "Medium" },
  LOW: { variant: "default", label: "Low" },
}

const verificationReasons = {
  CRAWLER_BLOCKED: "Crawler blocked",
  ROBOTS_TXT: "Blocked by robots.txt",
  LOGIN_REQUIRED: "Login required",
  JS_RENDERING: "JavaScript rendering",
  TEMPORARY_FAILURE: "Temporary verification failure",
  OTHER: "Other",
} as const

type VerificationReason = keyof typeof verificationReasons

const fraudDispositions: Record<DeliveryFraudDisposition, string> = {
  FALSE_POSITIVE: "False positive",
  AUTHORIZED_REUSE: "Authorized URL reuse (Finance or Super Admin)",
  RISK_ACCEPTED: "Risk accepted (Finance or Super Admin)",
}

export default function DeliveryVerificationQueuePage() {
  const { allowed, loading, user } = useRequireRole(
    "SUPER_ADMIN",
    "OPERATIONS",
    "FINANCE",
  )
  if (loading) return null
  if (!allowed)
    return <ForbiddenPage requires="Operations, Finance, or Super Admin" />
  return (
    <DeliveryVerificationQueuePageInner staffRole={user?.staffRole ?? null} />
  )
}

function DeliveryVerificationQueuePageInner({
  staffRole,
}: {
  staffRole: string | null
}) {
  const canOperate = staffRole === "SUPER_ADMIN" || staffRole === "OPERATIONS"
  const canResolveFraud = canOperate || staffRole === "FINANCE"
  const qc = useQueryClient()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [actionDialog, setActionDialog] = useState<{
    mode: "verify" | "reject" | "resolve-fraud" | "confirm-fraud"
    id: string
    orderId: string
    orderVersion: number
    verificationVersion: number
  } | null>(null)
  const confirmationIntentId = useRef<string | null>(null)
  const confirmationReason = useRef<string | null>(null)
  const [reason, setReason] = useState("")
  const [notes, setNotes] = useState("")
  const [verificationReason, setVerificationReason] =
    useState<VerificationReason>("CRAWLER_BLOCKED")
  const [fraudDisposition, setFraudDisposition] =
    useState<DeliveryFraudDisposition>("FALSE_POSITIVE")
  const [evidenceReference, setEvidenceReference] = useState("")
  const [ticketId, setTicketId] = useState("")
  const [reverifyId, setReverifyId] = useState<string | null>(null)

  const closeActionDialog = () => {
    setActionDialog(null)
    setReason("")
    setNotes("")
    setVerificationReason("CRAWLER_BLOCKED")
    setFraudDisposition("FALSE_POSITIVE")
    setEvidenceReference("")
    confirmationIntentId.current = null
    confirmationReason.current = null
  }

  const invalidateDecisionViews = (orderId: string) => {
    qc.invalidateQueries({ queryKey: ["delivery-verification-queue"] })
    qc.invalidateQueries({ queryKey: ["admin", "order", orderId] })
    qc.invalidateQueries({ queryKey: ["admin", "orders"] })
    qc.invalidateQueries({ queryKey: ["notifications"] })
  }

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
    mutationFn: (args: {
      id: string
      reason: VerificationReason
      notes?: string
    }) =>
      api.admin.markVerified(args.id, {
        reason: args.reason,
        notes: args.notes,
      }),
    onSuccess: (_result, variables) => {
      toast.success("Order marked as verified")
      closeActionDialog()
      invalidateDecisionViews(variables.id)
    },
    onError: () => toast.error("Failed to mark as verified"),
  })

  const reject = useMutation({
    mutationFn: (args: { id: string; reason: string }) =>
      api.admin.rejectVerification(args.id, { reason: args.reason }),
    onSuccess: (_result, variables) => {
      toast.success("Verification rejected")
      closeActionDialog()
      invalidateDecisionViews(variables.id)
    },
    onError: () => toast.error("Failed to reject verification"),
  })

  const requestReverify = useMutation({
    mutationFn: (args: { id: string; ticketId: string }) =>
      api.admin.requestReverify(args.id, { ticketId: args.ticketId }),
    onSuccess: (_result, variables) => {
      toast.success("Publisher requested to re-verify")
      setReverifyId(null)
      setTicketId("")
      invalidateDecisionViews(variables.id)
    },
    onError: () => toast.error("Failed to request re-verification"),
  })

  const resolveFraud = useMutation({
    mutationFn: (args: {
      id: string
      reason: string
      disposition: DeliveryFraudDisposition
      evidenceReference?: string
    }) => {
      if (args.disposition === "FALSE_POSITIVE") {
        return api.admin.resolveDeliveryFraudFlag(args.id, {
          reason: args.reason,
          disposition: args.disposition,
          evidenceReference: args.evidenceReference,
        })
      }
      if (!args.evidenceReference) {
        throw new Error(
          "An evidence or case reference is required for known delivery risk",
        )
      }
      return api.admin.resolveDeliveryFraudFlag(args.id, {
        reason: args.reason,
        disposition: args.disposition,
        evidenceReference: args.evidenceReference,
      })
    },
    onSuccess: () => {
      const orderId = actionDialog?.orderId
      toast.success("Fraud hold resolved with staff evidence")
      closeActionDialog()
      if (orderId) invalidateDecisionViews(orderId)
    },
    onError: (error: Error) =>
      toast.error(error.message || "Failed to resolve fraud hold"),
  })

  const confirmFraud = useMutation({
    mutationFn: (args: {
      id: string
      orderId: string
      reason: string
      expectedOrderVersion: number
      expectedVerificationVersion: number
      idempotencyKey: string
    }) =>
      api.admin.confirmDeliveryFraudFlag(args.id, {
        reason: args.reason,
        expectedOrderVersion: args.expectedOrderVersion,
        expectedVerificationVersion: args.expectedVerificationVersion,
        idempotencyKey: args.idempotencyKey,
      }),
    onSuccess: (result, variables) => {
      toast.success(
        result.replayed
          ? "Confirmed fraud decision and review case already recorded"
          : "Security violation confirmed; cancellation review created without moving money",
      )
      closeActionDialog()
      invalidateDecisionViews(variables.orderId)
    },
    onError: (error: Error, variables) => {
      toast.error(error.message || "Failed to confirm security violation")
      invalidateDecisionViews(variables.orderId)
    },
  })

  const items = queue ?? []
  const actionPending =
    markVerified.isPending ||
    reject.isPending ||
    resolveFraud.isPending ||
    confirmFraud.isPending
  const actionInvalid =
    actionDialog?.mode === "verify"
      ? notes.length > 800 ||
        (verificationReason === "OTHER" && notes.trim().length < 20)
      : reason.length > 1000 ||
        reason.trim().length < 20 ||
        (actionDialog?.mode === "resolve-fraud" &&
          fraudDisposition !== "FALSE_POSITIVE" &&
          evidenceReference.trim().length === 0)

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
                  const hasUnresolvedFraud =
                    (delivery?.fraudFlags.length ?? 0) > 0
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
                            {canOperate &&
                              item.status === "PUBLISHED" &&
                              ["FAILED", "MANUAL_REVIEW"].includes(
                                verificationStatus,
                              ) && (
                                <>
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
                                    disabled={hasUnresolvedFraud}
                                    title={
                                      hasUnresolvedFraud
                                        ? "Resolve every fraud hold before approving"
                                        : undefined
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setActionDialog({
                                        mode: "verify",
                                        id: item.orderId,
                                        orderId: item.orderId,
                                        orderVersion: item.orderVersion,
                                        verificationVersion:
                                          delivery?.verificationVersion ?? 0,
                                      })
                                      setVerificationReason("CRAWLER_BLOCKED")
                                      setNotes("")
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
                                        orderVersion: item.orderVersion,
                                        verificationVersion:
                                          delivery?.verificationVersion ?? 0,
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
                                <div className="space-y-3">
                                  <strong className="text-sm">
                                    Security review findings
                                  </strong>
                                  {delivery.fraudFlags.map((flag) => (
                                    <div
                                      key={flag.id}
                                      className="space-y-2 rounded border border-destructive/30 bg-destructive/5 p-3"
                                    >
                                      <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant="destructive">
                                          {flag.type.replace(/_/g, " ")}
                                        </Badge>
                                        {flag.deliveryVersionId !==
                                          delivery.id && (
                                          <Badge variant="warning">
                                            Historical delivery v
                                            {flag.deliveryVersion.version}
                                          </Badge>
                                        )}
                                        <span className="text-xs text-muted-foreground">
                                          {format(
                                            new Date(flag.createdAt),
                                            "MMM d, yyyy HH:mm",
                                          )}
                                        </span>
                                      </div>
                                      <p className="break-all text-xs">
                                        <strong>Flagged delivery:</strong>{" "}
                                        {flag.deliveryVersion.publishedUrl}
                                      </p>
                                      {flag.deliveryVersion.evidence && (
                                        <p className="text-xs text-muted-foreground">
                                          Evidence: HTTP{" "}
                                          {
                                            flag.deliveryVersion.evidence
                                              .httpStatus
                                          }
                                          , link{" "}
                                          {flag.deliveryVersion.evidence
                                            .linkFound
                                            ? "found"
                                            : "missing"}
                                          , target{" "}
                                          {flag.deliveryVersion.evidence
                                            .targetUrlMatched
                                            ? "matched"
                                            : "mismatched"}
                                          , anchor{" "}
                                          {flag.deliveryVersion.evidence
                                            .anchorFound
                                            ? "found"
                                            : "missing"}
                                        </p>
                                      )}
                                      <pre className="max-w-xl overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 text-xs">
                                        {JSON.stringify(flag.details, null, 2)}
                                      </pre>
                                      {flag.finding ? (
                                        <div className="space-y-3 rounded-md border border-destructive/40 bg-background p-3">
                                          <div className="flex flex-wrap items-center gap-2">
                                            <Badge variant="destructive">
                                              Confirmed violation
                                            </Badge>
                                            <span className="text-xs text-muted-foreground">
                                              Decided by{" "}
                                              {flag.finding.decidedByRole.replaceAll(
                                                "_",
                                                " ",
                                              )}{" "}
                                              on{" "}
                                              {format(
                                                new Date(
                                                  flag.finding.createdAt,
                                                ),
                                                "PPp",
                                              )}
                                            </span>
                                          </div>
                                          <p
                                            className="whitespace-pre-wrap break-words text-sm"
                                            dir="auto"
                                          >
                                            {flag.finding.reason}
                                          </p>
                                          <p className="text-xs text-muted-foreground">
                                            This confirmed evidence permanently
                                            denies settlement for the delivery.
                                            The separate refund and compensation
                                            workflow closes the financial case;
                                            it does not clear or erase this
                                            finding.
                                          </p>
                                          <div className="flex flex-wrap gap-2">
                                            {canResolveFraud ? (
                                              <Button
                                                size="sm"
                                                variant="outline"
                                                disabled
                                                title="A confirmed violation cannot be cleared"
                                              >
                                                Clear finding
                                              </Button>
                                            ) : null}
                                            <Button size="sm" asChild>
                                              <Link
                                                href={`/dashboard/cancellations?requestId=${flag.finding.cancellationRequestId}`}
                                              >
                                                Open cancellation review
                                              </Link>
                                            </Button>
                                          </div>
                                        </div>
                                      ) : canResolveFraud ? (
                                        <div className="flex flex-wrap gap-2">
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={resolveFraud.isPending}
                                            onClick={() => {
                                              setActionDialog({
                                                mode: "resolve-fraud",
                                                id: flag.id,
                                                orderId: item.orderId,
                                                orderVersion: item.orderVersion,
                                                verificationVersion:
                                                  delivery.verificationVersion,
                                              })
                                              setReason("")
                                              setFraudDisposition(
                                                "FALSE_POSITIVE",
                                              )
                                              setEvidenceReference("")
                                              confirmationIntentId.current =
                                                null
                                            }}
                                          >
                                            Clear finding
                                          </Button>
                                          {canOperate ? (
                                            <Button
                                              size="sm"
                                              variant="destructive"
                                              disabled={confirmFraud.isPending}
                                              onClick={() => {
                                                if (
                                                  !globalThis.crypto?.randomUUID
                                                ) {
                                                  toast.error(
                                                    "Secure confirmation is unavailable in this browser. Refresh or use a supported browser.",
                                                  )
                                                  return
                                                }
                                                confirmationIntentId.current =
                                                  globalThis.crypto.randomUUID()
                                                confirmationReason.current =
                                                  null
                                                setActionDialog({
                                                  mode: "confirm-fraud",
                                                  id: flag.id,
                                                  orderId: item.orderId,
                                                  orderVersion:
                                                    item.orderVersion,
                                                  verificationVersion:
                                                    flag.deliveryVersion
                                                      .verificationVersion,
                                                })
                                                setReason("")
                                              }}
                                            >
                                              Confirm violation
                                            </Button>
                                          ) : null}
                                        </div>
                                      ) : (
                                        <p className="text-xs text-muted-foreground">
                                          Awaiting an authorized staff decision.
                                        </p>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}

                              {canOperate && (
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
                              )}
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
        onOpenChange={(open) => !open && closeActionDialog()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionDialog?.mode === "verify"
                ? "Mark order as verified"
                : actionDialog?.mode === "resolve-fraud"
                  ? "Clear security finding"
                  : actionDialog?.mode === "confirm-fraud"
                    ? "Confirm security violation"
                    : "Reject verification"}
            </DialogTitle>
            <DialogDescription>
              {actionDialog?.mode === "verify"
                ? "Confirm that the delivery has been manually verified. This approves the delivery."
                : actionDialog?.mode === "resolve-fraud"
                  ? "Document why this immutable signal is safe to clear. Clearing it does not advance the order or release funds."
                  : actionDialog?.mode === "confirm-fraud"
                    ? "This records a durable security decision and keeps the financial hold in place."
                    : "Reject the delivery verification and require a publisher resubmission."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {actionDialog?.mode === "confirm-fraud" ? (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
                role="alert"
              >
                <p className="font-medium">Financial hold remains active</p>
                <p className="mt-1 text-muted-foreground">
                  Confirmation does not refund the customer, compensate the
                  publisher, cancel the order, or release funds. Open the order
                  after confirming and complete the appropriate financial
                  workflow.
                </p>
              </div>
            ) : null}
            {actionDialog?.mode === "verify" ? (
              <>
                <Select
                  value={verificationReason}
                  onValueChange={(value) =>
                    setVerificationReason(value as VerificationReason)
                  }
                >
                  <SelectTrigger aria-label="Manual verification reason">
                    <SelectValue placeholder="Select a reason" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(verificationReasons).map(
                      ([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
                <Textarea
                  placeholder={
                    verificationReason === "OTHER"
                      ? "Reviewer notes (required, min 20 characters)"
                      : "Reviewer notes (optional)"
                  }
                  value={notes}
                  maxLength={800}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </>
            ) : (
              <>
                {actionDialog?.mode === "resolve-fraud" && (
                  <>
                    <Select
                      value={fraudDisposition}
                      onValueChange={(value) =>
                        setFraudDisposition(value as DeliveryFraudDisposition)
                      }
                    >
                      <SelectTrigger aria-label="Fraud disposition">
                        <SelectValue placeholder="Select a disposition" />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(fraudDispositions).map(
                          ([value, label]) => (
                            <SelectItem
                              key={value}
                              value={value}
                              disabled={
                                staffRole === "OPERATIONS" &&
                                value !== "FALSE_POSITIVE"
                              }
                            >
                              {label}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                    <Input
                      placeholder={
                        fraudDisposition === "FALSE_POSITIVE"
                          ? "Evidence or case reference (optional)"
                          : "Evidence or case reference (required)"
                      }
                      value={evidenceReference}
                      maxLength={200}
                      onChange={(event) =>
                        setEvidenceReference(event.target.value)
                      }
                    />
                  </>
                )}
                <Textarea
                  placeholder="Reason (required, min 20 characters)"
                  value={reason}
                  maxLength={1000}
                  disabled={
                    actionDialog?.mode === "confirm-fraud" &&
                    confirmationReason.current !== null
                  }
                  onChange={(e) => setReason(e.target.value)}
                />
                {actionDialog?.mode === "confirm-fraud" &&
                confirmationReason.current !== null ? (
                  <p className="text-xs text-muted-foreground">
                    This decision text is locked for safe retry. Close and
                    reopen the dialog to start a different decision.
                  </p>
                ) : null}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeActionDialog}>
              Cancel
            </Button>
            <Button
              variant={
                actionDialog?.mode === "verify" ||
                actionDialog?.mode === "resolve-fraud"
                  ? "default"
                  : "destructive"
              }
              disabled={actionPending || actionInvalid}
              onClick={() => {
                if (!actionDialog) return
                if (actionDialog.mode === "verify") {
                  markVerified.mutate({
                    id: actionDialog.id,
                    reason: verificationReason,
                    notes: notes || undefined,
                  })
                } else if (actionDialog.mode === "resolve-fraud") {
                  resolveFraud.mutate({
                    id: actionDialog.id,
                    reason: reason.trim(),
                    disposition: fraudDisposition,
                    evidenceReference: evidenceReference.trim() || undefined,
                  })
                } else if (actionDialog.mode === "confirm-fraud") {
                  if (!canOperate || !confirmationIntentId.current) {
                    toast.error(
                      "Secure confirmation expired. Close this dialog and try again.",
                    )
                    return
                  }
                  const frozenReason =
                    confirmationReason.current ?? reason.trim()
                  confirmationReason.current = frozenReason
                  confirmFraud.mutate({
                    id: actionDialog.id,
                    orderId: actionDialog.orderId,
                    reason: frozenReason,
                    expectedOrderVersion: actionDialog.orderVersion,
                    expectedVerificationVersion:
                      actionDialog.verificationVersion,
                    idempotencyKey: confirmationIntentId.current,
                  })
                } else {
                  reject.mutate({
                    id: actionDialog.id,
                    reason: reason.trim(),
                  })
                }
              }}
            >
              {actionDialog?.mode === "verify"
                ? "Confirm verification"
                : actionDialog?.mode === "resolve-fraud"
                  ? "Clear finding"
                  : actionDialog?.mode === "confirm-fraud"
                    ? "Confirm violation"
                    : "Reject"}
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
