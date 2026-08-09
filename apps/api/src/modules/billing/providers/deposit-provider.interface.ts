export interface CreateDepositSessionInput {
  attemptId: string
  publicReference: string
  walletId: string
  organizationId: string | null
  userId: string
  amountMinor: number
  currency: string
  idempotencyKey: string
  successUrl: string
  cancelUrl: string
}

export interface DepositSessionResult {
  providerSessionId: string
  providerObjectType: string | null
  providerPaymentId: string | null
  clientReferenceId: string | null
  metadata: {
    depositAttemptId: string | null
    publicReference: string | null
    walletId: string | null
    userId: string | null
    organizationId: string | null
  }
  amountTotalMinor: number | null
  currency: string | null
  mode: string | null
  status: string | null
  url: string | null
  expiresAt: Date | null
  livemode: boolean
}

export const DEPOSIT_PROVIDER_FAILURE_CODES = [
  "PROVIDER_AUTHENTICATION_FAILED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_REQUEST_REJECTED",
  "PROVIDER_RESPONSE_INVALID",
] as const

export type DepositProviderFailureCode =
  (typeof DEPOSIT_PROVIDER_FAILURE_CODES)[number]

/**
 * Sanitized provider-boundary failure. Never retain the provider response,
 * request headers, credential, or raw message on this error: callers persist
 * only `code` and expose one stable public availability response.
 */
export class DepositProviderError extends Error {
  readonly name = "DepositProviderError"

  constructor(
    readonly code: DepositProviderFailureCode,
    readonly retryable: boolean,
  ) {
    super(code)
  }
}

export interface DepositProviderAdapter {
  readonly providerName: string
  readonly capabilities: {
    supportedMethods: string[]
    supportedCurrencies: string[]
    supportsRefunds: boolean
    supportsDisputes: boolean
    supportsWebhooks: boolean
  }
  createSession(input: CreateDepositSessionInput): Promise<DepositSessionResult>
  retrieveSession(providerSessionId: string): Promise<DepositSessionResult>
  verifyWebhook(signature: string, payload: Buffer): Record<string, any>
}
