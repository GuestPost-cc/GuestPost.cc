import { createHash } from "node:crypto"
import { Injectable } from "@nestjs/common"
import {
  CancelTransferResult,
  CheckStatusResult,
  CreateTransferParams,
  CreateTransferResult,
  PayoutProviderAdapter,
} from "./payout-provider.interface"

// Wise dedupes transfers on customerTransactionId, which must be a UUID.
// Derive one deterministically from our idempotency key so every retry of the
// same (withdrawal, version) presents the identical UUID to Wise.
export function idempotencyKeyToUuid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

@Injectable()
export class WisePayoutAdapter implements PayoutProviderAdapter {
  readonly providerName = "wise"
  readonly capabilities = {
    supportedCurrencies: [],
    supportsBankPayout: false,
    supportsCancellation: false,
    supportsWebhooks: false,
    supportsStatusPolling: false,
    supportsExternalReference: false,
    requiresRecipientOnboarding: false,
    maxReferenceLength: 32,
  }

  private uncertified(operation: string): never {
    throw new Error(
      `Wise ${operation} is disabled until the quote, transfer, funding, recovery, and returned-funds lifecycle is certified`,
    )
  }

  async validateRecipient(
    details: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    void details
    return {
      valid: false,
      error: "Wise payouts are not certified for money movement",
    }
  }

  async createTransfer(
    params: CreateTransferParams,
  ): Promise<CreateTransferResult> {
    void params
    return this.uncertified("createTransfer")
  }

  async checkTransferStatus(
    providerExecutionId: string,
  ): Promise<CheckStatusResult> {
    void providerExecutionId
    return this.uncertified("checkTransferStatus")
  }

  async cancelTransfer(
    providerExecutionId: string,
    _idempotencyKey: string,
  ): Promise<CancelTransferResult> {
    void providerExecutionId
    void _idempotencyKey
    return this.uncertified("cancelTransfer")
  }
}
