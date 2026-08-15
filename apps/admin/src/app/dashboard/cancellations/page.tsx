"use client"

import type {
  AdminCancellationRequestResponse,
  CancellationRequestStatus,
} from "@guestpost/api-client"
import {
  isExactMoneyAtMost,
  normalizeExactNonNegativeMoney,
} from "@guestpost/api-client"
import { ACTIVE_CANCELLATION_REQUEST_STATUSES } from "@guestpost/shared"
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
import { format } from "date-fns"
import { FileWarning } from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"
import { toast } from "sonner"
import {
  AdminFilterBar,
  AdminPage,
  AdminPageHeader,
} from "../../../components/admin-workspace"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

type Resolution = "FULL_REFUND" | "CONTINUE_ORDER" | "ESCALATE_TO_DISPUTE"
type Responsibility =
  | "CUSTOMER"
  | "PUBLISHER"
  | "PLATFORM"
  | "SHARED"
  | "SYSTEM"
const CANCELLATION_REQUEST_LOOKUP_ID = /^[A-Za-z0-9_-]{1,128}$/

export default function CancellationsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-72 w-full" />}>
      <CancellationsPageInner />
    </Suspense>
  )
}

function CancellationsPageInner() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const searchParams = useSearchParams()
  const requestedRequestId = searchParams.get("requestId")
  const hasValidRequestId =
    requestedRequestId === null ||
    CANCELLATION_REQUEST_LOOKUP_ID.test(requestedRequestId)
  const linkedRequestId =
    requestedRequestId !== null && hasValidRequestId
      ? requestedRequestId
      : undefined
  const [status, setStatus] = useState<
    "active" | "all" | CancellationRequestStatus
  >("active")
  const [target, setTarget] = useState<AdminCancellationRequestResponse | null>(
    null,
  )
  const [resolution, setResolution] = useState<Resolution | "">("")
  const [responsibility, setResponsibility] = useState<Responsibility | "">("")
  const [reason, setReason] = useState("")
  const [publisherCompensationAmount, setPublisherCompensationAmount] =
    useState("")
  const [responseAction, setResponseAction] = useState<"ACCEPT" | "CONTEST">(
    "ACCEPT",
  )

  const queryStatus =
    status === "active" || status === "all" ? undefined : status
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "cancellation-requests", status, linkedRequestId],
    queryFn: () =>
      api.admin.listCancellationRequests({
        status: linkedRequestId ? undefined : queryStatus,
        requestId: linkedRequestId,
      }),
    enabled: hasValidRequestId,
  })
  const items = (data?.items ?? []).filter((item) =>
    linkedRequestId
      ? true
      : status === "active"
        ? (ACTIVE_CANCELLATION_REQUEST_STATUSES as readonly string[]).includes(
            item.status,
          )
        : true,
  )

  const refresh = (orderId?: string) => {
    queryClient.invalidateQueries({
      queryKey: ["admin", "cancellation-requests"],
    })
    queryClient.invalidateQueries({ queryKey: ["admin", "orders"] })
    if (orderId) {
      queryClient.invalidateQueries({ queryKey: ["admin", "order", orderId] })
    }
    queryClient.invalidateQueries({ queryKey: ["notifications"] })
  }

  const closeTarget = () => {
    setTarget(null)
    setResolution("")
    setResponsibility("")
    setReason("")
    setPublisherCompensationAmount("")
  }

  const openTarget = (item: AdminCancellationRequestResponse) => {
    setResolution(item.requiresConfirmedFraudFullRefund ? "FULL_REFUND" : "")
    setResponsibility("")
    setReason("")
    setPublisherCompensationAmount("")
    setResponseAction("ACCEPT")
    setTarget(item)
  }

  const review = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("No cancellation selected")
      const reviewResolution = target.requiresConfirmedFraudFullRefund
        ? "FULL_REFUND"
        : resolution
      if (!reviewResolution) throw new Error("Select a review outcome")
      if (!responsibility) throw new Error("Select financial responsibility")
      const decisionReason = reason.trim()
      if (decisionReason.length < 20 || decisionReason.length > 2000) {
        throw new Error(
          "Enter a decision reason between 20 and 2000 characters",
        )
      }
      return api.admin.reviewCancellationRequest(target.id, {
        resolution: reviewResolution,
        responsibility,
        reason: decisionReason,
      })
    },
    onSuccess: () => {
      toast.success(
        target?.requiresConfirmedFraudFullRefund || resolution === "FULL_REFUND"
          ? "Refund recommendation sent to Finance"
          : "Cancellation case resolved",
      )
      const orderId = target?.orderId
      closeTarget()
      refresh(orderId)
    },
    onError: (err: Error) => toast.error(err.message || "Review failed"),
  })

  const financeApprove = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("No cancellation selected")
      if (!["SUPER_ADMIN", "FINANCE"].includes(user?.staffRole ?? "")) {
        throw new Error("Finance approval requires Finance or Super Admin")
      }
      const decisionReason = reason.trim()
      if (decisionReason.length < 20 || decisionReason.length > 2000) {
        throw new Error(
          "Enter a decision reason between 20 and 2000 characters",
        )
      }
      const policy = target.publisherCompensationPolicy
      const exactCompensation = normalizeExactNonNegativeMoney(
        publisherCompensationAmount,
      )
      if (
        policy?.required &&
        (!exactCompensation ||
          !isExactMoneyAtMost(exactCompensation, policy.maximumAmount))
      ) {
        throw new Error(
          "Enter an exact publisher compensation amount within the allowed maximum.",
        )
      }
      return api.admin.financeApproveCancellation(target.id, {
        reason: decisionReason,
        publisherCompensation: policy?.required
          ? { amount: exactCompensation!, reason: decisionReason }
          : undefined,
      })
    },
    onSuccess: () => {
      const orderId = target?.orderId
      toast.success("Refund and publisher compensation decision completed")
      closeTarget()
      refresh(orderId)
    },
    onError: (err: Error) => toast.error(err.message || "Approval failed"),
  })

  const respond = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("No cancellation selected")
      return api.admin.respondToPlatformCancellation(
        target.orderId,
        target.id,
        responseAction,
        reason.trim() || undefined,
      )
    },
    onSuccess: () => {
      toast.success(
        responseAction === "ACCEPT"
          ? "Cancellation accepted and customer refunded"
          : "Cancellation contested and sent to review",
      )
      const orderId = target?.orderId
      closeTarget()
      refresh(orderId)
    },
    onError: (err: Error) => toast.error(err.message || "Response failed"),
  })

  if (!hasValidRequestId) {
    return (
      <CancellationLookupState
        title="Invalid cancellation link"
        description="This link does not contain a valid cancellation request ID. Open the cancellation queue and select the case again."
      />
    )
  }

  if (error) {
    return (
      <ErrorState
        title="Failed to load cancellation cases"
        description={(error as Error).message}
        onRetry={() => refetch()}
      />
    )
  }

  if (linkedRequestId && !isLoading && items.length === 0) {
    return (
      <CancellationLookupState
        title="Cancellation case not found"
        description="The linked cancellation case does not exist or is no longer available to this staff account."
      />
    )
  }

  return (
    <AdminPage>
      <AdminPageHeader
        eyebrow="Resolution workflow"
        title="Cancellations"
        description="Review contested requests through the role-separated workflow; Finance approves every contested refund."
        icon={FileWarning}
      />

      {linkedRequestId ? (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">Linked cancellation case</p>
              <p className="text-sm text-muted-foreground">
                Showing the exact case from the staff alert, including terminal
                cases that are not in the active queue.
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/cancellations">View full queue</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <AdminFilterBar
          activeCount={status === "active" ? 0 : 1}
          resultCount={items.length}
          resultLabel={items.length === 1 ? "case" : "cases"}
          onClear={() => setStatus("active")}
        >
          <Select
            value={status}
            onValueChange={(value) =>
              setStatus(value as "active" | "all" | CancellationRequestStatus)
            }
          >
            <SelectTrigger className="w-full bg-background sm:w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active cases</SelectItem>
              <SelectItem value="all">All cases</SelectItem>
              <SelectItem value="UNDER_REVIEW">Under review</SelectItem>
              <SelectItem value="PENDING_FINANCE">Pending Finance</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </AdminFilterBar>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {items.length} case{items.length === 1 ? "" : "s"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-56 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Requester</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Deadline</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow
                    key={item.id}
                    className={
                      linkedRequestId
                        ? "bg-primary/5 ring-1 ring-inset ring-primary/30"
                        : undefined
                    }
                  >
                    <TableCell>
                      <Link
                        className="font-mono text-xs hover:text-primary"
                        href={`/dashboard/orders/${item.orderId}`}
                      >
                        #{item.orderId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>{item.requesterType}</TableCell>
                    <TableCell>
                      {item.reasonCode.replaceAll("_", " ")}
                    </TableCell>
                    <TableCell>
                      {item.order.fulfillmentChannel ?? "LEGACY"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">
                          {item.status.replaceAll("_", " ")}
                        </Badge>
                        {linkedRequestId ? (
                          <Badge variant="info">Linked case</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      {item.responseDeadlineAt
                        ? format(new Date(item.responseDeadlineAt), "PPp")
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {(item.status === "REQUESTED" &&
                        item.order.fulfillmentChannel === "PLATFORM" &&
                        ["SUPER_ADMIN", "OPERATIONS"].includes(
                          user?.staffRole ?? "",
                        )) ||
                      (["UNDER_REVIEW", "ESCALATED"].includes(item.status) &&
                        ["SUPER_ADMIN", "OPERATIONS"].includes(
                          user?.staffRole ?? "",
                        )) ||
                      (item.status === "PENDING_FINANCE" &&
                        ["SUPER_ADMIN", "FINANCE"].includes(
                          user?.staffRole ?? "",
                        )) ? (
                        <Button size="sm" onClick={() => openTarget(item)}>
                          {item.status === "PENDING_FINANCE"
                            ? "Finance Review"
                            : item.status === "REQUESTED"
                              ? "Respond"
                              : "Review"}
                        </Button>
                      ) : linkedRequestId ? (
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/dashboard/orders/${item.orderId}`}>
                            View Order
                          </Link>
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(target)}
        onOpenChange={(open) => !open && closeTarget()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target?.status === "PENDING_FINANCE"
                ? "Approve cancellation refund"
                : target?.status === "REQUESTED"
                  ? "Respond to cancellation"
                  : "Review cancellation"}
            </DialogTitle>
            <DialogDescription>
              {target?.requiresConfirmedFraudFullRefund
                ? "Confirmed-fraud evidence requires a full customer refund recommendation. Record who bears the financial responsibility; Finance makes the money decision."
                : "The outcome, reason, and responsibility are stored in the immutable audit trail."}
            </DialogDescription>
          </DialogHeader>
          {target?.requiresConfirmedFraudFullRefund ? (
            <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="destructive">Full refund required</Badge>
                <span className="text-sm font-medium">
                  Confirmed delivery fraud
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                This review can only proceed to Finance for a full customer
                refund. The financial workflow does not clear or erase the
                confirmed evidence, which permanently denies settlement for this
                delivery.
              </p>
            </div>
          ) : null}
          {target?.status === "REQUESTED" ? (
            <Select
              value={responseAction}
              onValueChange={(value) =>
                setResponseAction(value as "ACCEPT" | "CONTEST")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACCEPT">Accept and refund</SelectItem>
                <SelectItem value="CONTEST">
                  Contest for staff review
                </SelectItem>
              </SelectContent>
            </Select>
          ) : target?.status !== "PENDING_FINANCE" ? (
            <>
              {target?.requiresConfirmedFraudFullRefund ? (
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  Review outcome: <strong>Recommend full refund</strong>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="cancellation-review-outcome">
                    Review outcome
                  </Label>
                  <Select
                    value={resolution}
                    onValueChange={(value) =>
                      setResolution(value as Resolution)
                    }
                  >
                    <SelectTrigger id="cancellation-review-outcome">
                      <SelectValue placeholder="Select an outcome" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CONTINUE_ORDER">
                        Continue order
                      </SelectItem>
                      <SelectItem value="FULL_REFUND">
                        Recommend full refund
                      </SelectItem>
                      <SelectItem value="ESCALATE_TO_DISPUTE">
                        Open dispute
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="cancellation-financial-responsibility">
                  Financial responsibility
                </Label>
                <Select
                  value={responsibility}
                  onValueChange={(value) =>
                    setResponsibility(value as Responsibility)
                  }
                >
                  <SelectTrigger id="cancellation-financial-responsibility">
                    <SelectValue placeholder="Select who bears the cost" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CUSTOMER">Customer</SelectItem>
                    <SelectItem value="PUBLISHER">Publisher</SelectItem>
                    <SelectItem value="PLATFORM">Platform</SelectItem>
                    <SelectItem value="SHARED">Shared</SelectItem>
                    <SelectItem value="SYSTEM">System</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Choose the party whose ledger and compensation consequences
                  Finance must apply. Do not infer responsibility solely from
                  the existence of the fraud finding.
                </p>
              </div>
            </>
          ) : null}
          {target?.status === "PENDING_FINANCE" &&
          target.publisherCompensationPolicy?.required ? (
            <div className="space-y-4 rounded-md border border-amber-300 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  Publisher compensation decision required
                </p>
                <p className="text-sm text-muted-foreground">
                  Enter the exact gross compensation approved for completed
                  publication work. Zero is allowed only as an explicit reviewed
                  decision.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cancellation-publisher-compensation">
                  Compensation amount (
                  {target.publisherCompensationPolicy.currency})
                </Label>
                <Input
                  id="cancellation-publisher-compensation"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  aria-describedby="cancellation-compensation-help"
                  value={publisherCompensationAmount}
                  onChange={(event) =>
                    setPublisherCompensationAmount(event.target.value)
                  }
                  placeholder="0.00"
                />
                <p
                  id="cancellation-compensation-help"
                  className="text-xs text-muted-foreground"
                >
                  Maximum: {target.publisherCompensationPolicy.maximumAmount}{" "}
                  {target.publisherCompensationPolicy.currency}. Existing
                  publisher debt may be repaid from this gross amount first; the
                  order page records both debt applied and the net balance
                  credit after the transaction commits.
                </p>
              </div>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="cancellation-decision-reason">
              {target?.status === "REQUESTED"
                ? "Response reason"
                : "Decision reason"}
            </Label>
            <Textarea
              id="cancellation-decision-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                target?.status === "PENDING_FINANCE"
                  ? "Finance decision reason (required, 20–2000 characters)…"
                  : target?.status === "REQUESTED"
                    ? "Evidence-based response reason…"
                    : "Evidence-based decision reason (required, 20–2000 characters)…"
              }
              rows={4}
              maxLength={2000}
            />
          </div>
          {target?.status !== "REQUESTED" ? (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {reason.trim().length}/2000 characters · minimum 20
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeTarget}>
              Back
            </Button>
            <Button
              onClick={() =>
                target?.status === "PENDING_FINANCE"
                  ? financeApprove.mutate()
                  : target?.status === "REQUESTED"
                    ? respond.mutate()
                    : review.mutate()
              }
              disabled={
                reason.trim().length <
                  (target?.status === "REQUESTED" ? 3 : 20) ||
                reason.trim().length > 2000 ||
                (target?.status !== "REQUESTED" &&
                  target?.status !== "PENDING_FINANCE" &&
                  (!responsibility ||
                    (!target?.requiresConfirmedFraudFullRefund &&
                      !resolution))) ||
                (target?.status === "PENDING_FINANCE" &&
                  target.publisherCompensationPolicy?.required === true &&
                  !isExactMoneyAtMost(
                    publisherCompensationAmount,
                    target.publisherCompensationPolicy.maximumAmount,
                  )) ||
                review.isPending ||
                financeApprove.isPending ||
                respond.isPending
              }
            >
              {target?.status === "PENDING_FINANCE"
                ? "Approve Full Refund"
                : target?.status === "REQUESTED"
                  ? "Submit Response"
                  : target?.requiresConfirmedFraudFullRefund
                    ? "Send Full Refund to Finance"
                    : "Save Decision"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}

function CancellationLookupState({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <AdminPage>
      <AdminPageHeader
        eyebrow="Resolution workflow"
        title="Cancellations"
        description="Review contested requests through the role-separated workflow; Finance approves every contested refund."
        icon={FileWarning}
      />
      <Card>
        <CardContent>
          <ErrorState title={title} description={description} />
          <div className="flex justify-center pb-8">
            <Button asChild variant="outline">
              <Link href="/dashboard/cancellations">
                Open cancellation queue
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </AdminPage>
  )
}
