import {
  isExactMoneyAtMost,
  normalizeExactNonNegativeMoney,
} from "../exact-money"

describe("exact non-negative money", () => {
  it.each([
    ["0", "0.00"],
    ["0.1", "0.10"],
    ["125.40", "125.40"],
    ["9007199254740991.99", "9007199254740991.99"],
  ])("normalizes %s without Number coercion", (input, expected) => {
    expect(normalizeExactNonNegativeMoney(input)).toBe(expected)
  })

  it.each([
    "",
    " 1",
    "01.00",
    "-1",
    "1.001",
    "1e3",
    "NaN",
    0.01,
    1.5,
    {},
  ])("rejects the non-canonical input %s", (input) => {
    expect(normalizeExactNonNegativeMoney(input)).toBeNull()
  })

  it("accepts safe whole-number inputs", () => {
    expect(normalizeExactNonNegativeMoney(0)).toBe("0.00")
    expect(normalizeExactNonNegativeMoney(42)).toBe("42.00")
  })

  it("compares exact minor units beyond Number's safe range", () => {
    expect(
      isExactMoneyAtMost("9007199254740991.98", "9007199254740991.99"),
    ).toBe(true)
    expect(
      isExactMoneyAtMost("9007199254740992.00", "9007199254740991.99"),
    ).toBe(false)
  })
})
