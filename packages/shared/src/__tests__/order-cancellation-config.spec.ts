import {
  ORDER_CANCELLATION_DEFAULTS,
  parseBoundedPositiveInteger,
  resolveOrderCancellationConfig,
} from "../order-cancellation-config"

describe("order cancellation configuration", () => {
  it("uses documented defaults", () => {
    expect(resolveOrderCancellationConfig({})).toEqual(
      ORDER_CANCELLATION_DEFAULTS,
    )
  })

  it("defaults the fraud-review SLA and stall cadence", () => {
    const config = resolveOrderCancellationConfig({})
    expect(config.fraudReviewWindowHours).toBe(48)
    expect(config.caseStallFirstReminderDays).toBe(3)
    expect(config.caseStallReminderIntervalDays).toBe(7)
  })

  it("accepts explicit fraud-review and stall overrides", () => {
    const config = resolveOrderCancellationConfig({
      FRAUD_REVIEW_WINDOW_HOURS: "72",
      CASE_STALL_FIRST_REMINDER_DAYS: "1",
      CASE_STALL_REMINDER_INTERVAL_DAYS: "2",
    })
    expect(config.fraudReviewWindowHours).toBe(72)
    expect(config.caseStallFirstReminderDays).toBe(1)
    expect(config.caseStallReminderIntervalDays).toBe(2)
  })

  it("clamps invalid and unsafe values", () => {
    expect(parseBoundedPositiveInteger("0", 15, { min: 1, max: 60 })).toBe(1)
    expect(parseBoundedPositiveInteger("500", 15, { min: 1, max: 60 })).toBe(60)
    expect(
      parseBoundedPositiveInteger("not-a-number", 15, {
        min: 1,
        max: 60,
      }),
    ).toBe(15)
  })
})
