import {
  type CancellationActor,
  caseStalledDays,
  computeFraudHandoffDeadline,
  decideOrderCancellation,
  isCaseStallReminderDue,
} from "../order-cancellation-policy"

interface Case {
  actor: CancellationActor
  channel: "PUBLISHER" | "PLATFORM"
  status: string
  paymentStatus?: string
  expected: string
}

describe("order cancellation policy", () => {
  it.each<Case>([
    {
      actor: "CUSTOMER",
      channel: "PUBLISHER",
      status: "DRAFT",
      expected: "CANCEL_NOW",
    },
    {
      actor: "CUSTOMER",
      channel: "PLATFORM",
      status: "SUBMITTED",
      paymentStatus: "PAID",
      expected: "CANCEL_NOW",
    },
    {
      actor: "PUBLISHER",
      channel: "PUBLISHER",
      status: "SUBMITTED",
      paymentStatus: "PAID",
      expected: "DECLINE_NOW",
    },
    {
      actor: "STAFF",
      channel: "PLATFORM",
      status: "SUBMITTED",
      paymentStatus: "PAID",
      expected: "DECLINE_NOW",
    },
    {
      actor: "CUSTOMER",
      channel: "PUBLISHER",
      status: "ACCEPTED",
      paymentStatus: "PAID",
      expected: "REQUEST_CANCELLATION",
    },
    {
      actor: "PUBLISHER",
      channel: "PUBLISHER",
      status: "CONTENT_READY",
      paymentStatus: "PAID",
      expected: "REQUEST_CANCELLATION",
    },
    {
      actor: "STAFF",
      channel: "PLATFORM",
      status: "APPROVED",
      paymentStatus: "PAID",
      expected: "REQUEST_CANCELLATION",
    },
    {
      actor: "CUSTOMER",
      channel: "PLATFORM",
      status: "PUBLISHED",
      paymentStatus: "PAID",
      expected: "OPEN_DISPUTE",
    },
    {
      actor: "CUSTOMER",
      channel: "PUBLISHER",
      status: "REFUNDED",
      paymentStatus: "REFUNDED",
      expected: "NOT_ALLOWED",
    },
    {
      actor: "PUBLISHER",
      channel: "PLATFORM",
      status: "ACCEPTED",
      paymentStatus: "PAID",
      expected: "NOT_ALLOWED",
    },
  ])("$actor / $channel / $status -> $expected", (testCase) => {
    const decision = decideOrderCancellation({
      actor: testCase.actor,
      fulfillmentChannel: testCase.channel,
      status: testCase.status,
      paymentStatus: testCase.paymentStatus ?? "PENDING",
    })

    expect(decision.action).toBe(testCase.expected)
  })

  it("blocks duplicate active requests", () => {
    expect(
      decideOrderCancellation({
        actor: "CUSTOMER",
        fulfillmentChannel: "PUBLISHER",
        status: "ACCEPTED",
        paymentStatus: "PAID",
        hasActiveRequest: true,
      }).action,
    ).toBe("NOT_ALLOWED")
  })

  it.each([
    { warrantyEndsAt: null, label: "missing" },
    { warrantyEndsAt: "2026-07-16T00:00:00.000Z", label: "expired" },
  ])("blocks completed disputes when warranty is $label", (testCase) => {
    const decision = decideOrderCancellation({
      actor: "CUSTOMER",
      fulfillmentChannel: "PUBLISHER",
      status: "COMPLETED",
      paymentStatus: "PAID",
      warrantyEndsAt: testCase.warrantyEndsAt,
      now: new Date("2026-07-17T00:00:00.000Z"),
    })

    expect(decision.action).toBe("NOT_ALLOWED")
    expect(decision.message.toLowerCase()).toContain("warranty")
  })

  it("allows a completed dispute inside the warranty window", () => {
    expect(
      decideOrderCancellation({
        actor: "CUSTOMER",
        fulfillmentChannel: "PUBLISHER",
        status: "COMPLETED",
        paymentStatus: "PAID",
        warrantyEndsAt: "2026-07-18T00:00:00.000Z",
        now: new Date("2026-07-17T00:00:00.000Z"),
      }).action,
    ).toBe("OPEN_DISPUTE")
  })

  it("reports a verified fulfillment deadline miss", () => {
    const decision = decideOrderCancellation({
      actor: "CUSTOMER",
      fulfillmentChannel: "PLATFORM",
      status: "ACCEPTED",
      paymentStatus: "PAID",
      fulfillmentDueAt: "2026-07-16T00:00:00.000Z",
      now: new Date("2026-07-17T00:00:00.000Z"),
    })

    expect(decision.action).toBe("REQUEST_CANCELLATION")
    expect(decision.message).toContain("deadline was missed")
  })
})

describe("fraud-handoff SLA and stall-reminder policy", () => {
  it("computes the fraud-handoff review deadline from the window hours", () => {
    const now = new Date("2026-08-24T10:00:00.000Z")
    expect(computeFraudHandoffDeadline(now, 48).toISOString()).toBe(
      "2026-08-26T10:00:00.000Z",
    )
    expect(computeFraudHandoffDeadline(now, 1).toISOString()).toBe(
      "2026-08-24T11:00:00.000Z",
    )
  })

  it("counts whole stalled days and never goes negative", () => {
    const now = new Date("2026-08-24T12:00:00.000Z")
    expect(caseStalledDays(new Date("2026-08-21T12:00:00.000Z"), now)).toBe(3)
    expect(caseStalledDays(new Date("2026-08-24T11:59:00.000Z"), now)).toBe(0)
    expect(caseStalledDays(new Date("2026-08-25T00:00:00.000Z"), now)).toBe(0)
  })

  it("nudges on the first reminder day and every interval thereafter", () => {
    expect(isCaseStallReminderDue(2, 3, 7)).toBe(false)
    expect(isCaseStallReminderDue(3, 3, 7)).toBe(true)
    expect(isCaseStallReminderDue(9, 3, 7)).toBe(false)
    expect(isCaseStallReminderDue(10, 3, 7)).toBe(true)
    expect(isCaseStallReminderDue(17, 3, 7)).toBe(true)
  })

  it("supports a daily cadence when configured", () => {
    expect(isCaseStallReminderDue(5, 5, 1)).toBe(true)
    expect(isCaseStallReminderDue(6, 5, 1)).toBe(true)
    expect(isCaseStallReminderDue(4, 5, 1)).toBe(false)
  })
})
