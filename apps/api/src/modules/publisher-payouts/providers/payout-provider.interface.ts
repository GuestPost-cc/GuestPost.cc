export interface CreateTransferParams {
  amount: number
  currency: string
  recipientDetails: Record<string, unknown>
  providerConfig: Record<string, unknown>
  idempotencyKey: string
  description?: string
}

export interface CreateTransferResult {
  providerExecutionId: string
  providerTransferId?: string
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
  acceptedReference?: string
}

export interface ProviderExecutionContext {
  connectedAccountId?: string
  providerTransferId?: string
  providerPayoutId?: string
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
  fee?: number
  errorMessage?: string
  metadata?: Record<string, unknown>
}

export interface CancelTransferResult {
  success: boolean
  providerExecutionId: string
  metadata?: Record<string, unknown>
}

export interface PayoutProviderAdapter {
  readonly providerName: string
  readonly capabilities: PayoutProviderCapabilities

  validateRecipient(
    details: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }>

  createTransfer(params: CreateTransferParams): Promise<CreateTransferResult>

  createBankPayout?(
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
