import { QUEUE_JOBS, QUEUES } from "../queues"

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
