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
    supportedCurrencies: ["USD"],
    supportsBankPayout: true,
    supportsCancellation: true,
    supportsWebhooks: true,
    supportsStatusPolling: true,
    supportsExternalReference: true,
    requiresRecipientOnboarding: true,
    maxReferenceLength: 32,
  }

  private missingKey(operation: string): never {
    throw new Error(
      `Wise ${operation} requires WISE_API_KEY; fake money movements are never permitted`,
    )
  }

  async validateRecipient(
    details: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    if (!details.recipientId) {
      return { valid: false, error: "Wise payout requires recipientId" }
    }
    return { valid: true }
  }

  async createTransfer(
    params: CreateTransferParams,
  ): Promise<CreateTransferResult> {
    const apiKey = (params.providerConfig.apiKey ??
      process.env.WISE_API_KEY) as string
    if (!apiKey) {
      this.missingKey("createTransfer")
    }

    const response = await fetch("https://api.transferwise.com/v1/transfers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetAccount: params.recipientDetails.recipientId,
        sourceCurrency: params.currency,
        targetCurrency:
          params.recipientDetails.targetCurrency ?? params.currency,
        amount: params.amount,
        customerTransactionId: idempotencyKeyToUuid(params.idempotencyKey),
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Wise transfer failed: ${response.status} ${err}`)
    }

    const data = (await response.json()) as any
    return {
      providerExecutionId: String(data.id),
      status: "PROCESSING",
      fee: Number(data.fee?.amount ?? 0),
      metadata: {
        wiseTransferId: data.id,
        estimatedDelivery: data.estimatedDelivery,
      },
    }
  }

  async checkTransferStatus(
    providerExecutionId: string,
  ): Promise<CheckStatusResult> {
    const apiKey = process.env.WISE_API_KEY
    if (!apiKey) {
      this.missingKey("checkTransferStatus")
    }

    const response = await fetch(
      `https://api.transferwise.com/v1/transfers/${providerExecutionId}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    )

    if (!response.ok) {
      throw new Error(`Wise status check failed: ${response.status}`)
    }

    const data = (await response.json()) as any
    const statusMap: Record<string, "PROCESSING" | "COMPLETED" | "FAILED"> = {
      processing: "PROCESSING",
      funds_converted: "PROCESSING",
      outgoing_payment_sent: "PROCESSING",
      completed: "COMPLETED",
      cancelled: "FAILED",
      failed: "FAILED",
    }

    return {
      status: statusMap[data.status as string] ?? "PROCESSING",
      providerExecutionId,
      fee: Number(data.fee?.amount ?? 0),
      metadata: {
        wiseStatus: data.status,
        estimatedDelivery: data.estimatedDelivery,
      },
    }
  }

  async cancelTransfer(
    providerExecutionId: string,
    _idempotencyKey: string,
  ): Promise<CancelTransferResult> {
    const apiKey = process.env.WISE_API_KEY
    if (!apiKey) {
      this.missingKey("cancelTransfer")
    }

    const response = await fetch(
      `https://api.transferwise.com/v1/transfers/${providerExecutionId}/cancel`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    )

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Wise cancel failed: ${response.status} ${err}`)
    }

    return { success: true, providerExecutionId }
  }
}
