import { Injectable } from "@nestjs/common"
import {
  CancelTransferResult,
  CheckStatusResult,
  CreateTransferParams,
  CreateTransferResult,
  PayoutProviderAdapter,
} from "./payout-provider.interface"

@Injectable()
export class ManualPayoutAdapter implements PayoutProviderAdapter {
  readonly providerName = "manual"
  readonly capabilities = {
    supportedCurrencies: ["USD"],
    supportsBankPayout: true,
    supportsCancellation: true,
    supportsWebhooks: false,
    supportsStatusPolling: false,
    supportsExternalReference: true,
    requiresRecipientOnboarding: false,
    maxReferenceLength: 32,
  }

  async validateRecipient(
    details: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    if (!details.bankName || !details.accountNumber) {
      return {
        valid: false,
        error: "Manual payout requires bankName and accountNumber",
      }
    }
    return { valid: true }
  }

  async createTransfer(
    params: CreateTransferParams,
  ): Promise<CreateTransferResult> {
    return {
      providerExecutionId: `manual-${params.idempotencyKey}`,
      status: "PENDING",
      fee: 0,
      metadata: {
        note: "Manual payout — must be completed via bank interface",
      },
    }
  }

  async checkTransferStatus(
    providerExecutionId: string,
  ): Promise<CheckStatusResult> {
    return {
      status: "PROCESSING",
      providerExecutionId,
    }
  }

  async cancelTransfer(
    providerExecutionId: string,
    _idempotencyKey: string,
  ): Promise<CancelTransferResult> {
    return {
      success: true,
      providerExecutionId,
    }
  }
}
