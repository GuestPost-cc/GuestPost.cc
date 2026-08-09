export type StripeKeyMode = "test" | "live" | "none" | "invalid"

/**
 * Classifies a Stripe credential without returning or logging any credential
 * material. Both full-access and restricted keys carry the same mode signal.
 */
export function classifyStripeKeyMode(
  rawKey: string | null | undefined,
): StripeKeyMode {
  const key = rawKey?.trim()
  if (!key) return "none"
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test"
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live"
  return "invalid"
}

export type StripeConfigurationErrorCode =
  | "STRIPE_KEY_MISSING"
  | "STRIPE_KEY_INVALID"
  | "STRIPE_LIVE_MODE_DISABLED"
  | "STRIPE_PAYOUT_CONTEXT_INVALID"
  | "STRIPE_PROVIDER_REQUEST_FAILED"
  | "STRIPE_PROVIDER_MODE_MISMATCH"
  | "STRIPE_PROVIDER_EVIDENCE_MISMATCH"

export class StripeConfigurationError extends Error {
  readonly name = "StripeConfigurationError"

  constructor(
    readonly code: StripeConfigurationErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface StripeFinancialObjectModeInput {
  /**
   * Pass the value read at the financial mutation boundary. Keeping this
   * helper pure avoids accidentally validating a durable object against a
   * key mode captured earlier in a long-lived API or worker process.
   */
  secretKey: string | null | undefined
  liveModeEnabled: string | null | undefined
}

/**
 * Proves that durable Stripe evidence belongs to the currently configured
 * Stripe environment before it is allowed to mutate financial state.
 *
 * This is deliberately stricter than classifying a key: live evidence also
 * requires the explicit live-money gate, and the object's immutable
 * `livemode` bit must exactly match the current key.
 */
export function assertStripeFinancialObjectMode(
  livemode: boolean | null | undefined,
  input: StripeFinancialObjectModeInput,
): "test" | "live" {
  const keyMode = classifyStripeKeyMode(input.secretKey)
  if (keyMode === "none") {
    throw new StripeConfigurationError(
      "STRIPE_KEY_MISSING",
      "Durable Stripe evidence cannot be applied without a configured secret or restricted key",
    )
  }
  if (keyMode === "invalid") {
    throw new StripeConfigurationError(
      "STRIPE_KEY_INVALID",
      "Durable Stripe evidence requires a valid Stripe secret or restricted key",
    )
  }
  if (
    keyMode === "live" &&
    input.liveModeEnabled?.trim().toLowerCase() !== "true"
  ) {
    throw new StripeConfigurationError(
      "STRIPE_LIVE_MODE_DISABLED",
      "Live Stripe evidence is refused while the live-money gate is disabled",
    )
  }
  if (typeof livemode !== "boolean" || livemode !== (keyMode === "live")) {
    throw new StripeConfigurationError(
      "STRIPE_PROVIDER_MODE_MISMATCH",
      "Durable Stripe evidence mode does not match the currently configured Stripe key",
    )
  }
  return keyMode
}
