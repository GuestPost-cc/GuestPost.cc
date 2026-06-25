import { Injectable, Logger } from "@nestjs/common"
import type { PayoutProviderAdapter, CreateTransferParams, CreateTransferResult, CheckStatusResult, CancelTransferResult } from "./payout-provider.interface"

@Injectable()
export class StripeConnectPayoutAdapter implements PayoutProviderAdapter {
  readonly providerName = "stripe_connect"
  private readonly logger = new Logger(StripeConnectPayoutAdapter.name)

  private assertNotProductionMock(operation: string) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(`Stripe Connect ${operation} attempted without STRIPE_SECRET_KEY in production — refusing to fake a money movement`)
    }
  }

  async validateRecipient(details: Record<string, unknown>): Promise<{ valid: boolean; error?: string }> {
    if (!details.connectedAccountId) {
      return { valid: false, error: "Stripe Connect payout requires connectedAccountId" }
    }
    return { valid: true }
  }

  async createTransfer(params: CreateTransferParams): Promise<CreateTransferResult> {
    const apiKey = (params.providerConfig.apiKey ?? process.env.STRIPE_SECRET_KEY) as string
    if (!apiKey) {
      this.assertNotProductionMock("createTransfer")
      this.logger.warn("STRIPE_SECRET_KEY not configured — returning mock transfer")
      return {
        providerExecutionId: `stripe-mock-${Date.now()}`,
        status: "COMPLETED",
        fee: Math.round(params.amount * 0.025 * 100) / 100,
        metadata: { mock: true },
      }
    }

    // Stripe Connect: create a transfer to the connected account
    const response = await fetch("https://api.stripe.com/v1/transfers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        // Stripe deduplicates on this header — NOT a body field. Same key on
        // retry returns the original transfer instead of creating a second one.
        "Idempotency-Key": params.idempotencyKey,
      },
      body: new URLSearchParams({
        amount: String(Math.round(params.amount * 100)),
        currency: params.currency.toLowerCase(),
        destination: params.recipientDetails.connectedAccountId as string,
        description: params.description ?? "Publisher payout",
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Stripe Connect transfer failed: ${response.status} ${err}`)
    }

    const data = await response.json() as any
    return {
      providerExecutionId: data.id,
      status: data.status === "paid" ? "COMPLETED" : "PROCESSING",
      fee: Number(data.fee ?? 0),
      metadata: { stripeTransferId: data.id, stripeStatus: data.status },
    }
  }

  async checkTransferStatus(providerExecutionId: string): Promise<CheckStatusResult> {
    const apiKey = process.env.STRIPE_SECRET_KEY
    if (!apiKey) {
      this.assertNotProductionMock("checkTransferStatus")
      return { status: "COMPLETED", providerExecutionId }
    }

    const response = await fetch(`https://api.stripe.com/v1/transfers/${providerExecutionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })

    if (!response.ok) {
      throw new Error(`Stripe status check failed: ${response.status}`)
    }

    const data = await response.json() as any
    const statusMap: Record<string, "PROCESSING" | "COMPLETED" | "FAILED"> = {
      pending: "PROCESSING",
      in_transit: "PROCESSING",
      paid: "COMPLETED",
      canceled: "FAILED",
      failed: "FAILED",
    }

    return {
      status: statusMap[data.status as string] ?? "PROCESSING",
      providerExecutionId,
      fee: Number(data.fee ?? 0),
      metadata: { stripeStatus: data.status },
    }
  }

  async cancelTransfer(providerExecutionId: string, idempotencyKey: string): Promise<CancelTransferResult> {
    const apiKey = process.env.STRIPE_SECRET_KEY
    if (!apiKey) {
      this.assertNotProductionMock("cancelTransfer")
      return { success: true, providerExecutionId }
    }

    // Stripe transfers cannot be canceled once paid; attempt reversal
    try {
      const response = await fetch(`https://api.stripe.com/v1/transfers/${providerExecutionId}/reversals`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": idempotencyKey,
        },
      })
      const data = await response.json() as any
      return { success: response.ok, providerExecutionId, metadata: { reversalId: data.id } }
    } catch (err) {
      throw new Error(`Stripe transfer reversal failed: ${err}`)
    }
  }
}
