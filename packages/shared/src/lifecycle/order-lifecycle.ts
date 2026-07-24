import type { OrderStatus } from "../types"

export type OrderLifecycleStageKey =
  | "PAYMENT"
  | "CONTENT"
  | "REVIEW"
  | "PUBLICATION"
  | "VERIFICATION"
  | "DELIVERY"
  | "COMPLETION"

export interface OrderLifecycleStage {
  key: OrderLifecycleStageKey
  label: string
  statuses: readonly OrderStatus[]
}

export type OrderLifecycleException = "CANCELLED" | "REFUNDED" | "DISPUTED"

// Canonical order progression shared by customer, publisher, Operations,
// Finance, and Super Admin surfaces. Changes here must be covered by the
// completeness test so a new database status cannot silently render as the
// first stage in one application and a different stage in another.
export const ORDER_LIFECYCLE_STAGES: readonly OrderLifecycleStage[] = [
  {
    key: "PAYMENT",
    label: "Payment",
    statuses: ["DRAFT", "PENDING_PAYMENT", "PAID"],
  },
  {
    key: "CONTENT",
    label: "Content",
    statuses: [
      "SUBMITTED",
      "ACCEPTED",
      "CONTENT_REQUESTED",
      "CONTENT_CREATION",
      "CONTENT_READY",
    ],
  },
  {
    key: "REVIEW",
    label: "Review",
    statuses: ["CUSTOMER_REVIEW", "APPROVED"],
  },
  { key: "PUBLICATION", label: "Published", statuses: ["PUBLISHED"] },
  { key: "VERIFICATION", label: "Verified", statuses: ["VERIFIED"] },
  { key: "DELIVERY", label: "Delivered", statuses: ["DELIVERED"] },
  {
    key: "COMPLETION",
    label: "Complete",
    statuses: ["SETTLED", "COMPLETED"],
  },
] as const

export const ORDER_LIFECYCLE_EXCEPTIONS: Readonly<
  Record<OrderLifecycleException, { label: string; description: string }>
> = {
  CANCELLED: {
    label: "Cancelled",
    description: "This order was cancelled.",
  },
  REFUNDED: {
    label: "Refunded",
    description: "This order was refunded.",
  },
  DISPUTED: {
    label: "Disputed",
    description:
      "A dispute is open. Normal fulfillment and settlement progression is paused while it is reviewed.",
  },
}

export function isOrderLifecycleException(
  status: OrderStatus | string,
): status is OrderLifecycleException {
  return status in ORDER_LIFECYCLE_EXCEPTIONS
}

export function getOrderLifecycleStageIndex(
  status: OrderStatus | string,
): number | null {
  if (isOrderLifecycleException(status)) return null
  const index = ORDER_LIFECYCLE_STAGES.findIndex((stage) =>
    stage.statuses.includes(status as OrderStatus),
  )
  return index >= 0 ? index : null
}

export function getOrderLifecycleStage(
  status: OrderStatus | string,
): OrderLifecycleStage | null {
  const index = getOrderLifecycleStageIndex(status)
  return index == null ? null : ORDER_LIFECYCLE_STAGES[index]
}
