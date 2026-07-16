"use client"

import type {
  AdminCancellationRequestResponse,
  CancellationRequestStatus,
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
import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

type Resolution = "FULL_REFUND" | "CONTINUE_ORDER" | "ESCALATE_TO_DISPUTE"

export default function CancellationsPage() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const [status, setStatus] = useState<
    "active" | "all" | CancellationRequestStatus
  >("active")
  const [target, setTarget] = useState<AdminCancellationRequestResponse | null>(
    null,
  )
  const [resolution, setResolution] = useState<Resolution>("CONTINUE_ORDER")
  const [responsibility, setResponsibility] = useState("SYSTEM")
  const [reason, setReason] = useState("")
  const [responseAction, setResponseAction] = useState<"ACCEPT" | "CONTEST">(
    "ACCEPT",
  )

  const queryStatus =
    status === "active" || status === "all" ? undefined : status
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "cancellation-requests", status],
    queryFn: () => api.admin.listCancellationRequests({ status: queryStatus }),
  })
  const items = (data?.items ?? []).filter((item) =>
    status === "active"
      ? (ACTIVE_CANCELLATION_REQUEST_STATUSES as readonly string[]).includes(
          item.status,
        )
      : true,
  )

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ["admin", "cancellation-requests"],
    })

  const review = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("No cancellation selected")
      return api.admin.reviewCancellationRequest(target.id, {
        resolution,
        responsibility,
        reason: reason.trim(),
      })
    },
    onSuccess: () => {
      toast.success(
        resolution === "FULL_REFUND"
          ? "Refund recommendation sent to Finance"
          : "Cancellation case resolved",
      )
      setTarget(null)
      setReason("")
      refresh()
    },
    onError: (err: Error) => toast.error(err.message || "Review failed"),
  })

  const financeApprove = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("No cancellation selected")
      return api.admin.financeApproveCancellation(target.id, reason.trim())
    },
    onSuccess: () => {
      toast.success("Full wallet refund approved")
      setTarget(null)
      setReason("")
      refresh()
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
      setTarget(null)
      setReason("")
      refresh()
    },
    onError: (err: Error) => toast.error(err.message || "Response failed"),
  })

  if (error) {
    return (
      <ErrorState
        title="Failed to load cancellation cases"
        description={(error as Error).message}
        onRetry={() => refetch()}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Cancellations</h1>
          <p className="text-muted-foreground">
            Review contested requests; Finance approves every contested refund.
          </p>
        </div>
        <Select
          value={status}
          onValueChange={(value) =>
            setStatus(value as "active" | "all" | CancellationRequestStatus)
          }
        >
          <SelectTrigger className="w-48">
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
      </div>

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
                  <TableRow key={item.id}>
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
                      <Badge variant="outline">
                        {item.status.replaceAll("_", " ")}
                      </Badge>
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
                        <Button size="sm" onClick={() => setTarget(item)}>
                          {item.status === "PENDING_FINANCE"
                            ? "Finance Review"
                            : item.status === "REQUESTED"
                              ? "Respond"
                              : "Review"}
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
        onOpenChange={(open) => !open && setTarget(null)}
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
              The reason and responsibility are stored in the immutable audit
              trail.
            </DialogDescription>
          </DialogHeader>
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
              <Select
                value={resolution}
                onValueChange={(value) => setResolution(value as Resolution)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CONTINUE_ORDER">Continue order</SelectItem>
                  <SelectItem value="FULL_REFUND">
                    Recommend full refund
                  </SelectItem>
                  <SelectItem value="ESCALATE_TO_DISPUTE">
                    Open dispute
                  </SelectItem>
                </SelectContent>
              </Select>
              <Select value={responsibility} onValueChange={setResponsibility}>
                <SelectTrigger>
                  <SelectValue placeholder="Responsibility" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CUSTOMER">Customer</SelectItem>
                  <SelectItem value="PUBLISHER">Publisher</SelectItem>
                  <SelectItem value="PLATFORM">Platform</SelectItem>
                  <SelectItem value="SHARED">Shared</SelectItem>
                  <SelectItem value="SYSTEM">System</SelectItem>
                </SelectContent>
              </Select>
            </>
          ) : null}
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Evidence-based decision reason…"
            rows={4}
            maxLength={2000}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
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
                reason.trim().length < 3 ||
                review.isPending ||
                financeApprove.isPending ||
                respond.isPending
              }
            >
              {target?.status === "PENDING_FINANCE"
                ? "Approve Full Refund"
                : target?.status === "REQUESTED"
                  ? "Submit Response"
                  : "Save Decision"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
