export const STRIPE_INITIAL_FEE_POLICY_VERSION = "stripe-initial-v1"

const SAFE_REFERENCE = /[^A-Z0-9-]/g

/**
 * Keep external financial references compact, ASCII-only, and free of user
 * data. This formatter is browser-safe; generation happens server-side.
 */
export function normalizeFinancialReference(
  value: string,
  maxLength = 32,
): string {
  return value
    .normalize("NFKD")
    .toUpperCase()
    .replace(SAFE_REFERENCE, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, Math.max(1, maxLength))
}

export function compactFinancialReference(reference: string): string {
  const compact = normalizeFinancialReference(reference, 32).replace(/-/g, "")
  return compact.slice(-4).padStart(4, "0")
}

/** Complete card descriptor stays inside Stripe's 22-character limit. */
export function customerWalletStatementDescriptor(reference: string): string {
  return `GUESTPOST* ${customerWalletStatementSuffix(reference)}`.slice(0, 22)
}

export function customerWalletStatementSuffix(reference: string): string {
  return `WALLET ${compactFinancialReference(reference)}`
}

/** Ten characters fits restrictive ACH payout descriptor rails. */
export function publisherPayoutStatementDescriptor(reference: string): string {
  return `GP${compactFinancialReference(reference)}`.slice(0, 10)
}

export interface FeeDisclosure {
  grossMinor: number
  platformFeeMinor: number
  providerFeeMinor: number
  customerOrPublisherFeeMinor: number
  netMinor: number
  feePolicyVersion: string
}

/**
 * Initial Stripe rollout policy: provider fees are platform expenses. The
 * user-facing amount is never silently reduced.
 */
export function initialStripeFeeDisclosure(grossMinor: number): FeeDisclosure {
  if (!Number.isSafeInteger(grossMinor) || grossMinor <= 0) {
    throw new Error("grossMinor must be a positive safe integer")
  }
  return {
    grossMinor,
    platformFeeMinor: 0,
    providerFeeMinor: 0,
    customerOrPublisherFeeMinor: 0,
    netMinor: grossMinor,
    feePolicyVersion: STRIPE_INITIAL_FEE_POLICY_VERSION,
  }
}
