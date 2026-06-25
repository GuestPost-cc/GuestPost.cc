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
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED"
  fee?: number
  metadata?: Record<string, unknown>
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

  validateRecipient(details: Record<string, unknown>): Promise<{ valid: boolean; error?: string }>

  createTransfer(params: CreateTransferParams): Promise<CreateTransferResult>

  checkTransferStatus(providerExecutionId: string): Promise<CheckStatusResult>

  cancelTransfer(providerExecutionId: string, idempotencyKey: string): Promise<CancelTransferResult>
}
