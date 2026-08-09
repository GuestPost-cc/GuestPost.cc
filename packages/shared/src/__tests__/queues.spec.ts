import { deliveryVerificationJobId, QUEUE_JOBS, QUEUES } from "../queues"

describe("settlement queue routing", () => {
  it("keeps auto-approve and auto-release on distinct BullMQ queues", () => {
    expect(QUEUES.SETTLEMENT_RELEASE).not.toBe(QUEUES.SETTLEMENT)
    expect(QUEUE_JOBS[QUEUES.SETTLEMENT].AUTO_APPROVE).toBe(
      "settlement-auto-approve",
    )
    expect(QUEUE_JOBS[QUEUES.SETTLEMENT_RELEASE].AUTO_RELEASE).toBe(
      "settlement-auto-release",
    )
  })
})

describe("delivery verification queue identity", () => {
  it("deduplicates each immutable delivery verification generation", () => {
    expect(deliveryVerificationJobId("delivery-1", 0)).toBe(
      "delivery-verify-delivery-1-v0",
    )
    expect(deliveryVerificationJobId("delivery-1", 1)).toBe(
      "delivery-verify-delivery-1-v1",
    )
    expect(QUEUE_JOBS[QUEUES.DELIVERY_VERIFICATION].DISPATCH_SWEEP).toBe(
      "delivery-verification-dispatch-sweep",
    )
  })

  it("rejects unsafe or ambiguous job identity inputs", () => {
    expect(() => deliveryVerificationJobId("", 0)).toThrow()
    expect(() => deliveryVerificationJobId("delivery:1", 0)).toThrow()
    expect(() => deliveryVerificationJobId("delivery-1", -1)).toThrow()
    expect(() => deliveryVerificationJobId("delivery-1", 0.5)).toThrow()
  })
})
