import type { OrderResponse } from "@guestpost/api-client"
import { formatDistanceToNowStrict } from "date-fns"

export const PUBLISHER_ORDER_STAGE_GROUPS = [
  { key: "new", label: "New", statuses: ["SUBMITTED"] },
  {
    key: "production",
    label: "In production",
    statuses: [
      "ACCEPTED",
      "CONTENT_REQUESTED",
      "CONTENT_CREATION",
      "CONTENT_READY",
    ],
  },
  {
    key: "review",
    label: "Customer review",
    statuses: ["CUSTOMER_REVIEW"],
  },
  { key: "publish", label: "Ready to publish", statuses: ["APPROVED"] },
  {
    key: "verification",
    label: "Verification",
    statuses: ["PUBLISHED", "VERIFIED"],
  },
  {
    key: "delivered",
    label: "Delivered",
    statuses: ["DELIVERED", "SETTLED", "COMPLETED"],
  },
  {
    key: "closed",
    label: "Issues & closed",
    statuses: ["CANCELLED", "REFUNDED", "DISPUTED"],
  },
] as const

const ATTENTION_STATUSES = new Set([
  "SUBMITTED",
  "ACCEPTED",
  "CONTENT_REQUESTED",
  "CONTENT_CREATION",
  "APPROVED",
  "DISPUTED",
])

const CLOSED_STATUSES = new Set([
  "COMPLETED",
  "CANCELLED",
  "REFUNDED",
  "SETTLED",
])

export function getPublisherOrderStage(status: string) {
  return (
    PUBLISHER_ORDER_STAGE_GROUPS.find((group) =>
      group.statuses.some((candidate) => candidate === status),
    ) ?? PUBLISHER_ORDER_STAGE_GROUPS[0]
  )
}

export function getPublisherNextAction(order: OrderResponse) {
  const revisionRequested = order.revisions.some((revision) =>
    ["REQUESTED", "CHANGES_REQUESTED"].includes(revision.status),
  )
  const cancellationNeedsResponse = order.cancellationRequests.some(
    (request) =>
      request.requesterType === "CUSTOMER" && request.status === "REQUESTED",
  )

  if (cancellationNeedsResponse)
    return { label: "Respond to cancellation", tone: "urgent" as const }
  if (order.status === "SUBMITTED")
    return { label: "Review order", tone: "urgent" as const }
  if (revisionRequested)
    return { label: "Review requested changes", tone: "urgent" as const }
  if (
    ["ACCEPTED", "CONTENT_REQUESTED", "CONTENT_CREATION"].includes(order.status)
  )
    return { label: "Submit content", tone: "primary" as const }
  if (order.status === "CONTENT_READY")
    return { label: "Check submission", tone: "neutral" as const }
  if (order.status === "CUSTOMER_REVIEW")
    return { label: "Awaiting customer", tone: "neutral" as const }
  if (order.status === "APPROVED")
    return { label: "Add published URL", tone: "urgent" as const }
  if (order.status === "PUBLISHED")
    return { label: "Track verification", tone: "neutral" as const }
  if (["VERIFIED", "DELIVERED"].includes(order.status))
    return { label: "View settlement", tone: "neutral" as const }
  if (order.status === "DISPUTED")
    return { label: "Review dispute", tone: "urgent" as const }
  return { label: "View order", tone: "neutral" as const }
}

export function orderNeedsPublisherAttention(order: OrderResponse) {
  if (ATTENTION_STATUSES.has(order.status)) return true
  if (
    order.revisions.some((revision) =>
      ["REQUESTED", "CHANGES_REQUESTED"].includes(revision.status),
    )
  )
    return true
  return order.cancellationRequests.some(
    (request) =>
      request.requesterType === "CUSTOMER" && request.status === "REQUESTED",
  )
}

export function isOpenPublisherOrder(order: OrderResponse) {
  return !CLOSED_STATUSES.has(order.status)
}

export function getOrderDueState(order: OrderResponse, now = Date.now()) {
  if (!order.fulfillmentDueAt || !isOpenPublisherOrder(order)) {
    return {
      date: null,
      label: order.turnaroundDays
        ? `${order.turnaroundDays} day turnaround`
        : "No deadline",
      risk: "none" as const,
      millisecondsRemaining: Number.POSITIVE_INFINITY,
    }
  }

  const date = new Date(order.fulfillmentDueAt)
  const millisecondsRemaining = date.getTime() - now
  const absoluteLabel = formatDistanceToNowStrict(date, { addSuffix: true })
  const risk =
    millisecondsRemaining < 0
      ? ("overdue" as const)
      : millisecondsRemaining <= 48 * 60 * 60 * 1000
        ? ("soon" as const)
        : ("normal" as const)

  return {
    date,
    label:
      millisecondsRemaining < 0 ? `Overdue ${absoluteLabel}` : absoluteLabel,
    risk,
    millisecondsRemaining,
  }
}

export function sortOrdersByOperationalPriority(
  left: OrderResponse,
  right: OrderResponse,
) {
  const leftAttention = orderNeedsPublisherAttention(left) ? 0 : 1
  const rightAttention = orderNeedsPublisherAttention(right) ? 0 : 1
  if (leftAttention !== rightAttention) return leftAttention - rightAttention

  const leftDue = getOrderDueState(left).millisecondsRemaining
  const rightDue = getOrderDueState(right).millisecondsRemaining
  if (leftDue !== rightDue) return leftDue - rightDue

  return (
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  )
}

export function formatPublisherMoney(
  value: number | null | undefined,
  currency = "USD",
) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value ?? 0))
}
