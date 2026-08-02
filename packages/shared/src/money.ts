/**
 * The only currency currently supported by GuestPost money movements.
 *
 * This value is intentionally case-sensitive. Persisted/application currency
 * values must already be canonical; silently accepting `usd`, whitespace, or
 * another case would hide corrupt legacy rows and make a future multi-currency
 * rollout unsafe.
 */
export const USD_CURRENCY = "USD" as const

/** USD is currently represented with exactly two minor-unit decimal places. */
export const USD_MINOR_UNIT_DECIMALS = 2 as const

export type SupportedMoneyCurrency = typeof USD_CURRENCY

export function isSupportedMoneyCurrency(
  currency: unknown,
): currency is SupportedMoneyCurrency {
  return currency === USD_CURRENCY
}

const POSITIVE_USD_AMOUNT = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/

/**
 * Convert an exact, positive USD amount to a canonical two-decimal string.
 *
 * This deliberately rejects exponent notation, signs, whitespace, zero, and
 * hidden sub-cent precision. Callers may pass Prisma Decimal-like values; the
 * helper depends only on their stable `toString()` representation so shared
 * code stays independent from Prisma. JavaScript numbers whose minor units
 * exceed Number.MAX_SAFE_INTEGER are rejected because their original JSON
 * value can no longer be proven exact.
 */
export function normalizePositiveUsdMoney(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === "boolean") {
    return null
  }

  if (typeof value === "number" && !Number.isFinite(value)) return null

  let text: string
  try {
    text = String(value)
  } catch {
    return null
  }
  if (text.length === 0 || text !== text.trim()) return null

  const match = POSITIVE_USD_AMOUNT.exec(text)
  if (!match) return null

  const whole = match[1]
  const fraction = (match[2] ?? "").padEnd(USD_MINOR_UNIT_DECIMALS, "0")
  const minorUnits = BigInt(whole) * 100n + BigInt(fraction)
  if (minorUnits <= 0n) return null
  if (
    typeof value === "number" &&
    minorUnits > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null
  }

  return `${whole}.${fraction}`
}

export function isPositiveWholeCentUsdMoney(value: unknown): boolean {
  return normalizePositiveUsdMoney(value) !== null
}
