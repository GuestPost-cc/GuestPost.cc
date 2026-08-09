import {
  isPositiveWholeCentUsdMoney,
  isSupportedMoneyCurrency,
  normalizePositiveUsdMoney,
  USD_CURRENCY,
} from "../money"

describe("money currency invariant", () => {
  it("accepts only the exact canonical USD value", () => {
    expect(USD_CURRENCY).toBe("USD")
    expect(isSupportedMoneyCurrency("USD")).toBe(true)

    for (const value of ["usd", "Usd", " USD", "USD ", "EUR", "GBP", null]) {
      expect(isSupportedMoneyCurrency(value)).toBe(false)
    }
  })

  it("normalizes only positive exact whole-cent USD amounts", () => {
    expect(normalizePositiveUsdMoney(125)).toBe("125.00")
    expect(normalizePositiveUsdMoney(19.9)).toBe("19.90")
    expect(normalizePositiveUsdMoney("0.01")).toBe("0.01")
    expect(isPositiveWholeCentUsdMoney("999999999999999999.99")).toBe(true)

    for (const value of [
      0,
      -1,
      0.001,
      "1.001",
      "01.00",
      " 1.00",
      "1e2",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
    ]) {
      expect(normalizePositiveUsdMoney(value)).toBeNull()
      expect(isPositiveWholeCentUsdMoney(value)).toBe(false)
    }
  })

  it("rejects JavaScript-number amounts whose cents are not safely representable", () => {
    expect(normalizePositiveUsdMoney(90_071_992_547_410)).toBeNull()
  })
})
