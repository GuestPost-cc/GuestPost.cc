import type { OrderResponse } from "@guestpost/api-client"
import type { OrderStatus } from "@guestpost/shared"
import { formatDistanceToNowStrict } from "date-fns"

export const CUSTOMER_ORDER_STAGE_GROUPS = [
  {
    key: "unpaid",
    label: "Unpaid drafts",
    statuses: ["DRAFT", "PENDING_PAYMENT"],
  },
  {
    key: "production",
    label: "In production",
    statuses: [
      "PAID",
      "SUBMITTED",
      "ACCEPTED",
      "CONTENT_REQUESTED",
      "CONTENT_CREATION",
      "CONTENT_READY",
      "APPROVED",
    ],
  },
  {
    key: "review",
    label: "Customer review",
    statuses: ["CUSTOMER_REVIEW"],
  },
  {
    key: "verification",
    label: "Published & verification",
    statuses: ["PUBLISHED", "VERIFIED"],
  },
  {
    key: "delivered",
    label: "Delivered",
    statuses: ["DELIVERED", "SETTLED"],
  },
  {
    key: "completed",
    label: "Completed",
    statuses: ["COMPLETED"],
  },
  {
    key: "issues",
    label: "Issues & closed",
    statuses: ["CANCELLED", "REFUNDED", "DISPUTED"],
  },
] as const

export const CUSTOMER_ACTIVE_STATUSES: OrderStatus[] = [
  "DRAFT",
  "PENDING_PAYMENT",
  "PAID",
  "SUBMITTED",
  "ACCEPTED",
  "CONTENT_REQUESTED",
  "CONTENT_CREATION",
  "CONTENT_READY",
  "CUSTOMER_REVIEW",
  "APPROVED",
  "PUBLISHED",
  "VERIFIED",
  "DELIVERED",
  "DISPUTED",
]

export const CUSTOMER_RESULT_STATUSES: OrderStatus[] = [
  "PUBLISHED",
  "VERIFIED",
  "DELIVERED",
  "SETTLED",
  "COMPLETED",
]

const CLOSED_STATUSES = new Set<OrderStatus>([
  "COMPLETED",
  "CANCELLED",
  "REFUNDED",
  "SETTLED",
])

export function customerCanMutateOrder(
  order: OrderResponse,
  user?: { id: string; customerRole: "OWNER" | "MEMBER" | null } | null,
) {
  if (!user) return false
  return user.customerRole === "OWNER" || order.customerId === user.id
}

export function customerCancellationNeedsResponse(order: OrderResponse) {
  return order.cancellationRequests.some(
    (request) =>
      request.status === "REQUESTED" && request.requesterType !== "CUSTOMER",
  )
}

export function getCustomerNextAction(
  order: OrderResponse,
  user?: { id: string; customerRole: "OWNER" | "MEMBER" | null } | null,
) {
  const canMutate = customerCanMutateOrder(order, user)

  if (customerCancellationNeedsResponse(order)) {
    return canMutate
      ? { label: "Respond to cancellation", tone: "urgent" as const }
      : { label: "View cancellation", tone: "neutral" as const }
  }
  if (["DRAFT", "PENDING_PAYMENT"].includes(order.status)) {
    return canMutate
      ? { label: "Complete payment", tone: "urgent" as const }
      : { label: "Awaiting payment", tone: "neutral" as const }
  }
  if (order.status === "CUSTOMER_REVIEW") {
    return canMutate
      ? { label: "Review content", tone: "urgent" as const }
      : { label: "Content in review", tone: "neutral" as const }
  }
  if (order.status === "VERIFIED") {
    return canMutate
      ? { label: "Confirm delivery", tone: "urgent" as const }
      : { label: "Delivery verified", tone: "neutral" as const }
  }
  if (order.status === "DISPUTED")
    return { label: "Review dispute", tone: "urgent" as const }
  if (["PAID", "SUBMITTED", "ACCEPTED"].includes(order.status))
    return { label: "Track fulfillment", tone: "neutral" as const }
  if (
    ["CONTENT_REQUESTED", "CONTENT_CREATION", "CONTENT_READY"].includes(
      order.status,
    )
  )
    return { label: "Track content", tone: "neutral" as const }
  if (order.status === "APPROVED")
    return { label: "Await publication", tone: "neutral" as const }
  if (order.status === "PUBLISHED")
    return { label: "Track verification", tone: "neutral" as const }
  if (["DELIVERED", "SETTLED"].includes(order.status))
    return { label: "View delivery", tone: "primary" as const }
  if (order.status === "COMPLETED")
    return { label: "View result", tone: "primary" as const }
  return { label: "View order", tone: "neutral" as const }
}

export function orderNeedsCustomerAttention(
  order: OrderResponse,
  user?: { id: string; customerRole: "OWNER" | "MEMBER" | null } | null,
) {
  if (!customerCanMutateOrder(order, user)) return false
  return (
    customerCancellationNeedsResponse(order) ||
    ["DRAFT", "PENDING_PAYMENT", "CUSTOMER_REVIEW", "VERIFIED"].includes(
      order.status,
    )
  )
}

export function isOpenCustomerOrder(order: OrderResponse) {
  return !CLOSED_STATUSES.has(order.status)
}

export function getCustomerOrderDeadline(
  order: OrderResponse,
  now = Date.now(),
) {
  const deadlineValue =
    order.status === "VERIFIED" && order.autoAcceptAt
      ? order.autoAcceptAt
      : order.fulfillmentDueAt
  const deadlineKind =
    order.status === "VERIFIED" && order.autoAcceptAt
      ? "Review window"
      : "Fulfillment"

  if (!deadlineValue || !isOpenCustomerOrder(order)) {
    return {
      date: null,
      label: order.turnaroundDays
        ? `${order.turnaroundDays} day turnaround`
        : "No active deadline",
      kind: "Schedule",
      risk: "none" as const,
      millisecondsRemaining: Number.POSITIVE_INFINITY,
    }
  }

  const date = new Date(deadlineValue)
  const millisecondsRemaining = date.getTime() - now
  const distance = formatDistanceToNowStrict(date, { addSuffix: true })
  const risk =
    millisecondsRemaining < 0
      ? ("overdue" as const)
      : millisecondsRemaining <= 48 * 60 * 60 * 1000
        ? ("soon" as const)
        : ("normal" as const)

  return {
    date,
    label: millisecondsRemaining < 0 ? `Overdue ${distance}` : distance,
    kind: deadlineKind,
    risk,
    millisecondsRemaining,
  }
}

export function sortCustomerOrdersByPriority(
  left: OrderResponse,
  right: OrderResponse,
  user?: { id: string; customerRole: "OWNER" | "MEMBER" | null } | null,
) {
  const leftAttention = orderNeedsCustomerAttention(left, user) ? 0 : 1
  const rightAttention = orderNeedsCustomerAttention(right, user) ? 0 : 1
  if (leftAttention !== rightAttention) return leftAttention - rightAttention

  const leftDue = getCustomerOrderDeadline(left).millisecondsRemaining
  const rightDue = getCustomerOrderDeadline(right).millisecondsRemaining
  if (leftDue !== rightDue) return leftDue - rightDue

  return (
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  )
}

export function formatCustomerMoney(
  value: number | string | null | undefined,
  currency = "USD",
) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value ?? 0))
}
