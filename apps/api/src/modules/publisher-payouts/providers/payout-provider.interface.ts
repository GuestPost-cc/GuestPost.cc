export interface CreateTransferParams {
  amount: number
  currency: string
  recipientDetails: Record<string, unknown>
  providerConfig: Record<string, unknown>
  idempotencyKey: string
  description?: string
}

export type PayoutProviderResponseKind = "STRIPE_TRANSFER" | "STRIPE_PAYOUT"

/**
 * The provider returned an object, but its immutable account/reference/amount
 * envelope did not match the command. Callers must never persist any field
 * from the rejected object.
 */
export class PayoutProviderResponseMismatchError extends Error {
  readonly name = "PayoutProviderResponseMismatchError"
  readonly code = "PAYOUT_PROVIDER_RESPONSE_MISMATCH"

  constructor(
    readonly responseKind: PayoutProviderResponseKind,
    message: string,
  ) {
    super(message)
  }
}

export interface CreateTransferResult {
  providerExecutionId: string
  providerTransferId?: string
  providerAmountMinor?: number
  providerCurrency?: string
  livemode?: boolean
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED"
  fee?: number
  metadata?: Record<string, unknown>
}

export interface CreateBankPayoutParams {
  amount: number
  currency: string
  connectedAccountId: string
  idempotencyKey: string
  description: string
  statementDescriptor: string
  publicReference: string
}

export interface CreateBankPayoutResult extends CreateTransferResult {
  providerPayoutId: string
  providerAmountMinor: number
  providerCurrency: string
  acceptedReference?: string
}

export interface ProviderExecutionContext {
  payoutExecutionId?: string
  connectedAccountId?: string
  providerTransferId?: string
  providerPayoutId?: string
  expectedAmountMinor?: number
  expectedCurrency?: string
  expectedPublicReference?: string
}

export interface PayoutProviderCapabilities {
  supportedCurrencies: string[]
  supportsBankPayout: boolean
  supportsCancellation: boolean
  supportsWebhooks: boolean
  supportsStatusPolling: boolean
  supportsExternalReference: boolean
  requiresRecipientOnboarding: boolean
  maxReferenceLength?: number
}

export interface CheckStatusResult {
  status: "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED"
  providerExecutionId: string
  providerAmountMinor?: number
  providerCurrency?: string
  livemode?: boolean
  fee?: number
  errorMessage?: string
  metadata?: Record<string, unknown>
}

export interface CancelTransferResult {
  success: boolean
  providerExecutionId: string
  livemode?: boolean
  metadata?: Record<string, unknown>
}

export interface PayoutProviderAdapter {
  readonly providerName: string
  readonly capabilities: PayoutProviderCapabilities

  validateRecipient(
    details: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }>

  createTransfer(params: CreateTransferParams): Promise<CreateTransferResult>

  /**
   * Replay an already-durable, exact provider-send claim with its original
   * idempotency key. This path may remain available while new sends are
   * disabled, so callers must never use it for an unclaimed command.
   */
  recoverClaimedTransfer?(
    params: CreateTransferParams,
  ): Promise<CreateTransferResult>

  createBankPayout?(
    params: CreateBankPayoutParams,
  ): Promise<CreateBankPayoutResult>

  /**
   * Replay an already-durable, exact bank-payout claim with its original
   * idempotency key. This is recovery-only and must not bypass new-send gates.
   */
  recoverClaimedBankPayout?(
    params: CreateBankPayoutParams,
  ): Promise<CreateBankPayoutResult>

  checkTransferStatus(
    providerExecutionId: string,
    context?: ProviderExecutionContext,
  ): Promise<CheckStatusResult>

  cancelTransfer(
    providerExecutionId: string,
    idempotencyKey: string,
    context?: ProviderExecutionContext,
  ): Promise<CancelTransferResult>
}
