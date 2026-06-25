// Order list prioritization — everyone who works or verifies orders should see
// the ones that still need action first, newest within each tier. Pure +
// shared so customer portal, publisher, and admin lists rank identically.

// Fully closed — money settled or order ended. These sink to the bottom.
export const TERMINAL_ORDER_STATUSES = [
  "SETTLED",
  "COMPLETED",
  "CANCELLED",
  "REFUNDED",
]

// Needs a human now — surfaced at the very top regardless of recency.
export const ATTENTION_ORDER_STATUSES = ["DISPUTED", "PENDING_PAYMENT"]

// Tier: lower = higher in the list.
//   0 = needs attention (disputed / awaiting payment)
//   1 = in-flight / unsettled (default working set)
//   2 = terminal (done)
export function orderPriorityTier(status: string): number {
  if (ATTENTION_ORDER_STATUSES.includes(status)) return 0
  if (TERMINAL_ORDER_STATUSES.includes(status)) return 2
  return 1
}

export function isActiveOrder(status: string): boolean {
  return !TERMINAL_ORDER_STATUSES.includes(status)
}

// Comparator: tier asc, then most-recently-touched first. Pass the field that
// best reflects "last activity" (updatedAt, else createdAt).
export function compareOrdersByPriority<
  T extends {
    status: string
    updatedAt?: string | Date | null
    createdAt?: string | Date | null
  },
>(a: T, b: T): number {
  const ta = orderPriorityTier(a.status)
  const tb = orderPriorityTier(b.status)
  if (ta !== tb) return ta - tb
  const da = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime()
  const db = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime()
  return db - da
}

// Sort a copy — never mutate the query cache array in place.
export function sortOrdersByPriority<
  T extends {
    status: string
    updatedAt?: string | Date | null
    createdAt?: string | Date | null
  },
>(orders: T[]): T[] {
  return [...orders].sort(compareOrdersByPriority)
}
