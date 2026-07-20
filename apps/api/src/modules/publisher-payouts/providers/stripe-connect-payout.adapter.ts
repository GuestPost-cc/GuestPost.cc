import { Injectable } from "@nestjs/common"
import {
  assertStripeObjectMode,
  getStripeClient,
  getStripeRecoveryClient,
} from "../../../common/stripe-client"
import {
  CancelTransferResult,
  CheckStatusResult,
  CreateBankPayoutParams,
  CreateBankPayoutResult,
  CreateTransferParams,
  CreateTransferResult,
  PayoutProviderAdapter,
  ProviderExecutionContext,
} from "./payout-provider.interface"

function toMinorUnits(amount: number): number {
  const minor = Math.round(amount * 100)
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new Error("Invalid payout amount")
  }
  return minor
}

function payoutStatus(status: string): CheckStatusResult["status"] {
  if (status === "paid") return "COMPLETED"
  if (status === "failed") return "FAILED"
  if (status === "canceled") return "CANCELLED"
  return "PROCESSING"
}

function payoutCreateStatus(status: string): CreateBankPayoutResult["status"] {
  const normalized = payoutStatus(status)
  return normalized === "CANCELLED" ? "FAILED" : normalized
}

/**
 * Stripe Connect uses two different money movements:
 *
 * 1. Transfer: platform balance -> connected Stripe balance.
 * 2. Payout: connected Stripe balance -> publisher bank account.
 *
 * A Transfer has no bank-settlement status and must never complete a
 * withdrawal. Only the Payout's `paid` state may do that.
 */
@Injectable()
export class StripeConnectPayoutAdapter implements PayoutProviderAdapter {
  readonly providerName = "stripe_connect"
  readonly capabilities = {
    supportedCurrencies: ["USD"],
    supportsBankPayout: true,
    supportsCancellation: true,
    supportsWebhooks: true,
    supportsStatusPolling: true,
    supportsExternalReference: true,
    requiresRecipientOnboarding: true,
    maxReferenceLength: 10,
  }

  async validateRecipient(
    details: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    if (typeof details.connectedAccountId !== "string") {
      return { valid: false, error: "Stripe connected account is missing" }
    }
    if (details.providerAccountStatus !== "ENABLED") {
      return { valid: false, error: "Stripe connected account is not enabled" }
    }
    if (details.payoutScheduleConfigured !== true) {
      return {
        valid: false,
        error: "Stripe connected account is not configured for manual payouts",
      }
    }
    return { valid: true }
  }

  async createTransfer(
    params: CreateTransferParams,
  ): Promise<CreateTransferResult> {
    const connectedAccountId = params.recipientDetails
      .connectedAccountId as string
    const stripe = getStripeClient("connect")
    const transfer = await stripe.transfers.create(
      {
        amount: toMinorUnits(params.amount),
        currency: params.currency.toLowerCase(),
        destination: connectedAccountId,
        description: params.description,
        metadata: {
          withdrawal_reference: String(
            params.recipientDetails.publicReference ?? "",
          ),
        },
      },
      { idempotencyKey: params.idempotencyKey },
    )
    assertStripeObjectMode(transfer.livemode, "Stripe transfer")

    return {
      providerExecutionId: transfer.id,
      providerTransferId: transfer.id,
      // A Transfer only means funds reached the connected Stripe balance.
      status: "PROCESSING",
      metadata: {
        stage: "TRANSFER_CREATED",
        connectedAccountId,
      },
    }
  }

  async createBankPayout(
    params: CreateBankPayoutParams,
  ): Promise<CreateBankPayoutResult> {
    const stripe = getStripeClient("connect")
    const payout = await stripe.payouts.create(
      {
        amount: toMinorUnits(params.amount),
        currency: params.currency.toLowerCase(),
        description: params.description,
        statement_descriptor: params.statementDescriptor,
        metadata: { withdrawal_reference: params.publicReference },
      },
      {
        stripeAccount: params.connectedAccountId,
        idempotencyKey: params.idempotencyKey,
      },
    )
    assertStripeObjectMode(payout.livemode, "Stripe payout")

    return {
      providerExecutionId: payout.id,
      providerPayoutId: payout.id,
      status: payoutCreateStatus(payout.status),
      acceptedReference: payout.statement_descriptor ?? undefined,
      metadata: {
        stage: "BANK_PAYOUT_CREATED",
        stripePayoutStatus: payout.status,
        connectedAccountId: params.connectedAccountId,
        arrivalDate: payout.arrival_date,
      },
    }
  }

  async checkTransferStatus(
    providerExecutionId: string,
    context?: ProviderExecutionContext,
  ): Promise<CheckStatusResult> {
    if (!providerExecutionId.startsWith("po_")) {
      return {
        status: "PROCESSING",
        providerExecutionId,
        metadata: { stage: "TRANSFER_CREATED" },
      }
    }
    if (!context?.connectedAccountId) {
      throw new Error("Connected account context is required for payout status")
    }

    const stripe = getStripeRecoveryClient()
    const payout = await stripe.payouts.retrieve(
      providerExecutionId,
      {},
      { stripeAccount: context.connectedAccountId },
    )
    assertStripeObjectMode(payout.livemode, "Stripe payout")
    return {
      status: payoutStatus(payout.status),
      providerExecutionId,
      errorMessage:
        payout.status === "failed" ? "Stripe bank payout failed" : undefined,
      metadata: {
        stage: payout.status === "paid" ? "BANK_PAID" : "BANK_PAYOUT_CREATED",
        stripePayoutStatus: payout.status,
        arrivalDate: payout.arrival_date,
        connectedAccountId: context.connectedAccountId,
      },
    }
  }

  async cancelTransfer(
    providerExecutionId: string,
    idempotencyKey: string,
    context?: ProviderExecutionContext,
  ): Promise<CancelTransferResult> {
    // Cancellation/reversal is a recovery operation. It must remain available
    // after the new-send kill switch is disabled for an incident.
    const stripe = getStripeRecoveryClient()
    const payoutId =
      context?.providerPayoutId ??
      (providerExecutionId.startsWith("po_") ? providerExecutionId : undefined)
    const transferId =
      context?.providerTransferId ??
      (providerExecutionId.startsWith("tr_") ? providerExecutionId : undefined)

    if (payoutId) {
      if (!context?.connectedAccountId) {
        throw new Error(
          "Connected account context is required to cancel payout",
        )
      }
      const payout = await stripe.payouts.retrieve(
        payoutId,
        {},
        { stripeAccount: context.connectedAccountId },
      )
      assertStripeObjectMode(payout.livemode, "Stripe payout")
      if (payout.status === "paid") {
        throw new Error("Bank payout is already paid and cannot be cancelled")
      }
      if (payout.status === "pending") {
        await (stripe.payouts.cancel as any)(
          payoutId,
          {},
          {
            stripeAccount: context.connectedAccountId,
            idempotencyKey: `${idempotencyKey}-payout`,
          },
        )
      } else if (!["failed", "canceled"].includes(payout.status)) {
        throw new Error(
          `Bank payout is ${payout.status} and cannot be safely cancelled`,
        )
      }
    }

    if (transferId) {
      const reversal = await stripe.transfers.createReversal(
        transferId,
        {},
        { idempotencyKey: `${idempotencyKey}-transfer` },
      )
      return {
        success: true,
        providerExecutionId,
        metadata: { reversalId: reversal.id, payoutId, transferId },
      }
    }

    throw new Error("Stripe transfer reference is missing")
  }
}
