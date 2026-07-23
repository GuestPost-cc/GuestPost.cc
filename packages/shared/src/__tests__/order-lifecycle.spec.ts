import {
  getOrderLifecycleStage,
  getOrderLifecycleStageIndex,
  isOrderLifecycleException,
  ORDER_LIFECYCLE_STAGES,
} from "../lifecycle/order-lifecycle"
import type { OrderStatus } from "../types"

const ALL_ORDER_STATUSES: OrderStatus[] = [
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
  "SETTLED",
  "COMPLETED",
  "CANCELLED",
  "REFUNDED",
  "DISPUTED",
]

describe("canonical order lifecycle", () => {
  it("covers every order status exactly once", () => {
    const mapped = ORDER_LIFECYCLE_STAGES.flatMap((stage) => stage.statuses)
    const exceptions = ALL_ORDER_STATUSES.filter(isOrderLifecycleException)
    expect([...mapped, ...exceptions].sort()).toEqual(
      [...ALL_ORDER_STATUSES].sort(),
    )
    expect(new Set([...mapped, ...exceptions]).size).toBe(
      ALL_ORDER_STATUSES.length,
    )
  })

  it("maps normal progress monotonically", () => {
    const normal = ALL_ORDER_STATUSES.filter(
      (status) => !isOrderLifecycleException(status),
    )
    const indexes = normal.map((status) => getOrderLifecycleStageIndex(status))
    expect(indexes.every((index) => index != null)).toBe(true)
    expect(indexes).toEqual([...indexes].sort((a, b) => Number(a) - Number(b)))
  })

  it("keeps exception states off the happy-path progress rail", () => {
    expect(getOrderLifecycleStage("CANCELLED")).toBeNull()
    expect(getOrderLifecycleStageIndex("REFUNDED")).toBeNull()
    expect(getOrderLifecycleStageIndex("DISPUTED")).toBeNull()
  })

  it("fails closed for an unknown future status", () => {
    expect(getOrderLifecycleStageIndex("UNKNOWN_STATUS")).toBeNull()
  })
})
