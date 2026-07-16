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
