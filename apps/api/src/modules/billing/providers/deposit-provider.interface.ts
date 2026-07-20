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
  providerPaymentId: string | null
  url: string
  expiresAt: Date | null
  livemode: boolean
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
  retrieveSession(providerSessionId: string): Promise<Record<string, any>>
  verifyWebhook(signature: string, payload: Buffer): Record<string, any>
}
