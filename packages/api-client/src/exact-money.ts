const NON_NEGATIVE_WHOLE_CENT_MONEY = /^(0|[1-9]\d{0,15})(?:\.(\d{1,2}))?$/

/** Normalize a non-negative, non-exponent decimal without using Number. */
export function normalizeExactNonNegativeMoney(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null
  const text = String(value)
  if (text !== text.trim()) return null
  const match = NON_NEGATIVE_WHOLE_CENT_MONEY.exec(text)
  if (!match) return null
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`
}

function minorUnits(value: unknown): bigint | null {
  const normalized = normalizeExactNonNegativeMoney(value)
  if (!normalized) return null
  return BigInt(normalized.replace(".", ""))
}

/** Exact client-side UX check; the server remains authoritative. */
export function isExactMoneyAtMost(value: unknown, maximum: unknown): boolean {
  const amountMinor = minorUnits(value)
  const maximumMinor = minorUnits(maximum)
  return (
    amountMinor !== null && maximumMinor !== null && amountMinor <= maximumMinor
  )
}
