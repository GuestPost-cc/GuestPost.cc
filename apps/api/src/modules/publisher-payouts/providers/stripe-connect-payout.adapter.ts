import { isSupportedMoneyCurrency, USD_CURRENCY } from "@guestpost/shared"
import { Injectable } from "@nestjs/common"
import type Stripe from "stripe"
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
  PayoutProviderResponseMismatchError,
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

function reversalMatchesCommand(
  reversal: Stripe.TransferReversal,
  input: {
    transferId: string
    amountMinor: number
    currency: string
    publicReference: string
    payoutExecutionId: string
  },
): boolean {
  const reversalTransfer =
    typeof reversal.transfer === "string"
      ? reversal.transfer
      : reversal.transfer?.id
  return (
    typeof reversal.id === "string" &&
    reversal.id.startsWith("trr_") &&
    reversal.object === "transfer_reversal" &&
    reversalTransfer === input.transferId &&
    reversal.amount === input.amountMinor &&
    reversal.currency === "usd" &&
    input.currency === USD_CURRENCY &&
    reversal.metadata?.withdrawal_reference === input.publicReference &&
    reversal.metadata?.payout_execution_id === input.payoutExecutionId
  )
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
    const connectedAccountId = params.recipientDetails.connectedAccountId
    const publicReference = params.recipientDetails.publicReference
    const expectedAmountMinor = toMinorUnits(params.amount)
    const expectedCurrency = params.currency
    if (
      typeof connectedAccountId !== "string" ||
      !connectedAccountId ||
      typeof publicReference !== "string" ||
      !publicReference ||
      !isSupportedMoneyCurrency(expectedCurrency)
    ) {
      throw new Error(
        "Immutable Stripe account, amount, currency, and reference are required for transfer creation",
      )
    }
    const stripe = getStripeClient("connect")
    const transfer = await stripe.transfers.create(
      {
        amount: expectedAmountMinor,
        currency: "usd",
        destination: connectedAccountId,
        description: params.description,
        metadata: { withdrawal_reference: publicReference },
      },
      { idempotencyKey: params.idempotencyKey },
    )
    assertStripeObjectMode(transfer.livemode, "Stripe transfer")
    const transferDestination =
      typeof transfer.destination === "string"
        ? transfer.destination
        : transfer.destination?.id
    const transferCurrency = transfer.currency === "usd" ? USD_CURRENCY : null
    if (
      typeof transfer.id !== "string" ||
      !transfer.id.startsWith("tr_") ||
      transferDestination !== connectedAccountId ||
      transfer.amount !== expectedAmountMinor ||
      transferCurrency !== USD_CURRENCY ||
      transfer.metadata?.withdrawal_reference !== publicReference
    ) {
      throw new PayoutProviderResponseMismatchError(
        "STRIPE_TRANSFER",
        "Stripe Transfer response does not match the immutable payout command",
      )
    }

    return {
      providerExecutionId: transfer.id,
      providerTransferId: transfer.id,
      providerAmountMinor: transfer.amount,
      providerCurrency: transferCurrency,
      livemode: transfer.livemode,
      // A Transfer only means funds reached the connected Stripe balance.
      status: "PROCESSING",
      metadata: {
        stage: "TRANSFER_CREATED",
        connectedAccountId,
        providerAmountMinor: transfer.amount,
        providerCurrency: transferCurrency,
        providerPublicReference: publicReference,
        livemode: transfer.livemode,
      },
    }
  }

  async createBankPayout(
    params: CreateBankPayoutParams,
  ): Promise<CreateBankPayoutResult> {
    const expectedAmountMinor = toMinorUnits(params.amount)
    const expectedCurrency = params.currency
    if (
      !params.connectedAccountId ||
      !params.publicReference ||
      !isSupportedMoneyCurrency(expectedCurrency)
    ) {
      throw new Error(
        "Immutable Stripe account, amount, currency, and reference are required for bank payout creation",
      )
    }
    const stripe = getStripeClient("connect")
    const payout = await stripe.payouts.create(
      {
        amount: expectedAmountMinor,
        currency: "usd",
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
    const payoutCurrency = payout.currency === "usd" ? USD_CURRENCY : null
    if (
      typeof payout.id !== "string" ||
      !payout.id.startsWith("po_") ||
      payout.amount !== expectedAmountMinor ||
      payoutCurrency !== USD_CURRENCY ||
      payout.metadata?.withdrawal_reference !== params.publicReference
    ) {
      throw new PayoutProviderResponseMismatchError(
        "STRIPE_PAYOUT",
        "Stripe Payout response does not match the immutable payout command",
      )
    }

    return {
      providerExecutionId: payout.id,
      providerPayoutId: payout.id,
      providerAmountMinor: payout.amount,
      providerCurrency: payoutCurrency,
      livemode: payout.livemode,
      status: payoutCreateStatus(payout.status),
      acceptedReference: payout.statement_descriptor ?? undefined,
      metadata: {
        stage: "BANK_PAYOUT_CREATED",
        stripePayoutStatus: payout.status,
        connectedAccountId: params.connectedAccountId,
        providerAmountMinor: payout.amount,
        providerCurrency: payoutCurrency,
        providerPublicReference: params.publicReference,
        livemode: payout.livemode,
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
    if (
      !context?.connectedAccountId ||
      !Number.isSafeInteger(context.expectedAmountMinor) ||
      Number(context.expectedAmountMinor) <= 0 ||
      !isSupportedMoneyCurrency(context.expectedCurrency) ||
      !context.expectedPublicReference
    ) {
      throw new Error(
        "Immutable account, amount, currency, and reference context is required for payout status",
      )
    }

    const stripe = getStripeRecoveryClient()
    const payout = await stripe.payouts.retrieve(
      providerExecutionId,
      {},
      { stripeAccount: context.connectedAccountId },
    )
    assertStripeObjectMode(payout.livemode, "Stripe payout")
    if (
      payout.id !== providerExecutionId ||
      payout.amount !== context.expectedAmountMinor ||
      payout.currency !== "usd" ||
      payout.metadata?.withdrawal_reference !== context.expectedPublicReference
    ) {
      throw new Error(
        "Stripe payout status evidence does not match the immutable payout command",
      )
    }
    return {
      status: payoutStatus(payout.status),
      providerExecutionId,
      providerAmountMinor: payout.amount,
      providerCurrency: USD_CURRENCY,
      livemode: payout.livemode,
      errorMessage:
        payout.status === "failed" ? "Stripe bank payout failed" : undefined,
      metadata: {
        stage: payout.status === "paid" ? "BANK_PAID" : "BANK_PAYOUT_CREATED",
        stripePayoutStatus: payout.status,
        arrivalDate: payout.arrival_date,
        connectedAccountId: context.connectedAccountId,
        providerAmountMinor: payout.amount,
        providerCurrency: USD_CURRENCY,
        providerPublicReference: payout.metadata?.withdrawal_reference ?? "",
        livemode: payout.livemode,
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
    const expectedAmountMinor = context?.expectedAmountMinor
    const expectedCurrency = context?.expectedCurrency
    const expectedPublicReference = context?.expectedPublicReference
    if (
      !context?.connectedAccountId ||
      !context.payoutExecutionId ||
      !transferId ||
      !Number.isSafeInteger(expectedAmountMinor) ||
      Number(expectedAmountMinor) <= 0 ||
      !isSupportedMoneyCurrency(expectedCurrency) ||
      !expectedPublicReference
    ) {
      throw new Error(
        "Immutable Stripe transfer account, amount, currency, and reference context is required for cancellation",
      )
    }

    // Authenticate the complete object chain before issuing any mutation.
    // An append-once local ID is not enough: it could still be the wrong
    // Stripe object if a stale writer attached it before the DB transition
    // guards were deployed.
    const transfer = await stripe.transfers.retrieve(transferId)
    assertStripeObjectMode(transfer.livemode, "Stripe transfer")
    const transferLivemode = transfer.livemode
    const transferDestination =
      typeof transfer.destination === "string"
        ? transfer.destination
        : transfer.destination?.id
    if (
      transfer.id !== transferId ||
      transfer.amount !== expectedAmountMinor ||
      transfer.currency !== "usd" ||
      transferDestination !== context.connectedAccountId ||
      transfer.metadata?.withdrawal_reference !== expectedPublicReference
    ) {
      throw new Error(
        "Stripe transfer evidence does not match the immutable payout command",
      )
    }
    if (
      typeof transfer.reversed !== "boolean" ||
      !Number.isSafeInteger(transfer.amount_reversed) ||
      transfer.amount_reversed < 0 ||
      transfer.amount_reversed > expectedAmountMinor ||
      (transfer.reversed && transfer.amount_reversed !== expectedAmountMinor) ||
      (!transfer.reversed && transfer.amount_reversed !== 0)
    ) {
      throw new Error(
        "Stripe transfer reversal state is partial, malformed, or ambiguous",
      )
    }

    let recoveredReversal: Stripe.TransferReversal | null = null
    if (transfer.reversed) {
      const reversals = await stripe.transfers.listReversals(transferId, {
        limit: 100,
      })
      if (
        reversals.has_more ||
        reversals.data.length !== 1 ||
        !reversalMatchesCommand(reversals.data[0], {
          transferId,
          amountMinor: expectedAmountMinor,
          currency: expectedCurrency,
          publicReference: expectedPublicReference,
          payoutExecutionId: context.payoutExecutionId,
        })
      ) {
        throw new Error(
          "Existing Stripe transfer reversal cannot be authenticated to this payout execution",
        )
      }
      recoveredReversal = reversals.data[0]
    }

    let terminalPayout: Stripe.Payout | null = null
    if (payoutId) {
      const payout = await stripe.payouts.retrieve(
        payoutId,
        {},
        { stripeAccount: context.connectedAccountId },
      )
      assertStripeObjectMode(payout.livemode, "Stripe payout")
      if (
        payout.livemode !== transferLivemode ||
        payout.id !== payoutId ||
        payout.amount !== expectedAmountMinor ||
        payout.currency !== "usd" ||
        payout.metadata?.withdrawal_reference !== expectedPublicReference
      ) {
        throw new Error(
          "Stripe payout evidence does not match the immutable payout command",
        )
      }
      if (payout.status === "paid") {
        return {
          success: false,
          providerExecutionId,
          livemode: transferLivemode,
          metadata: {
            payoutId,
            payoutStatus: "paid",
            providerAmountMinor: payout.amount,
            providerCurrency: USD_CURRENCY,
            providerPublicReference: expectedPublicReference,
            payoutObservedAt: new Date().toISOString(),
            connectedAccountId: context.connectedAccountId,
            payoutExecutionId: context.payoutExecutionId,
            transferId,
            livemode: transferLivemode,
          },
        }
      }
      if (payout.status === "pending") {
        terminalPayout = await stripe.payouts.cancel(
          payoutId,
          {},
          {
            stripeAccount: context.connectedAccountId,
            idempotencyKey: `${idempotencyKey}-payout`,
          },
        )
        assertStripeObjectMode(
          terminalPayout?.livemode,
          "Cancelled Stripe payout",
        )
        if (
          terminalPayout?.livemode !== transferLivemode ||
          terminalPayout?.id !== payoutId ||
          terminalPayout?.status !== "canceled" ||
          terminalPayout?.amount !== expectedAmountMinor ||
          terminalPayout?.currency !== "usd" ||
          terminalPayout?.metadata?.withdrawal_reference !==
            expectedPublicReference
        ) {
          throw new Error(
            "Stripe payout cancellation response was not terminal",
          )
        }
      } else if (!["failed", "canceled"].includes(payout.status)) {
        throw new Error(
          `Bank payout is ${payout.status} and cannot be safely cancelled`,
        )
      } else {
        terminalPayout = payout
      }
    }

    if (transferId) {
      const reversal =
        recoveredReversal ??
        (await stripe.transfers.createReversal(
          transferId,
          {
            amount: expectedAmountMinor,
            metadata: {
              withdrawal_reference: expectedPublicReference,
              payout_execution_id: context.payoutExecutionId,
            },
          },
          { idempotencyKey: `${idempotencyKey}-transfer` },
        ))
      if (
        !reversalMatchesCommand(reversal, {
          transferId,
          amountMinor: expectedAmountMinor,
          currency: expectedCurrency,
          publicReference: expectedPublicReference,
          payoutExecutionId: context.payoutExecutionId,
        })
      ) {
        throw new Error(
          "Stripe transfer reversal evidence does not match the payout command",
        )
      }
      return {
        success: true,
        providerExecutionId,
        livemode: transferLivemode,
        metadata: {
          reversalId: reversal.id,
          reversalCreatedAt:
            typeof reversal.created === "number"
              ? new Date(reversal.created * 1000).toISOString()
              : null,
          reversalRecovered: recoveredReversal !== null,
          payoutId,
          payoutStatus: terminalPayout?.status ?? null,
          providerAmountMinor: terminalPayout?.amount ?? expectedAmountMinor,
          providerCurrency:
            typeof terminalPayout?.currency === "string"
              ? USD_CURRENCY
              : expectedCurrency,
          providerPublicReference: expectedPublicReference,
          payoutObservedAt: payoutId ? new Date().toISOString() : null,
          connectedAccountId: context?.connectedAccountId ?? null,
          payoutExecutionId: context.payoutExecutionId,
          transferId,
          livemode: transferLivemode,
        },
      }
    }

    throw new Error("Stripe transfer reference is missing")
  }
}
