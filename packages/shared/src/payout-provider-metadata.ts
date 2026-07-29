const SAFE_PROVIDER_FIELDS: Readonly<
  Record<string, number | "number" | "boolean">
> = Object.freeze({
  stage: 64,
  connectedAccountId: 191,
  arrivalDate: "number",
  stripePayoutStatus: 32,
  stripeStatus: 32,
  wiseTransferId: 191,
  wiseStatus: 32,
  estimatedDelivery: 100,
  note: 250,
  outcome: 64,
  fee: "number",
  provider: 32,
  event: 191,
  rawStatus: 100,
  providerAmountMinor: "number",
  providerCurrency: 3,
  providerPublicReference: 64,
  livemode: "boolean",
})

/**
 * Provider adapters are an external-data boundary. Persist only bounded,
 * explicitly understood scalar evidence; never provider response bodies.
 */
export function sanitizePayoutProviderMetadata(
  incoming: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
  if (!incoming) return {}
  const safe: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(incoming)) {
    const rule = SAFE_PROVIDER_FIELDS[key]
    if (rule === undefined) continue
    if (value === null) {
      safe[key] = null
    } else if (
      rule === "number" &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      safe[key] = value
    } else if (rule === "boolean" && typeof value === "boolean") {
      safe[key] = value
    } else if (typeof rule === "number" && typeof value === "string") {
      safe[key] = value.slice(0, rule)
    }
  }
  return safe
}

/**
 * Immutable routing/completion namespaces remain owned by application code.
 * Provider fields live under `providerEvidence` and therefore cannot replace
 * `destinationSnapshot`, `providerSnapshot`, `completion`, or cancellation
 * evidence.
 */
export function mergePayoutProviderMetadata(
  existing: unknown,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base = isRecord(existing) ? existing : {}
  const previousEvidence = isRecord(base.providerEvidence)
    ? base.providerEvidence
    : {}
  const nextEvidence = {
    ...previousEvidence,
    ...sanitizePayoutProviderMetadata(incoming),
  }
  return Object.keys(nextEvidence).length > 0
    ? { ...base, providerEvidence: nextEvidence }
    : { ...base }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
