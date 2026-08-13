// Financial drift detection core — shared by the API's on-demand
// GET /admin/reconciliation endpoint and the worker's scheduled sweep.
// Takes any Prisma client (API's PrismaService or the worker's singleton) so
// the two paths can never diverge on what "drift" means.
//
// Modules:
//  1. Wallet Drift — cached balance vs ledger sum
//  2. Publisher Balance Drift — withdrawableBalance vs ledger sum
//  3. Settlement Integrity — amount consistency, ledger sync, completeness
//  4. Order Payment Reconciliation — PURCHASE transactions vs order state
//  5. Refund Reconciliation — REFUND transactions vs order state
//  6. Stuck Financial Orders — money-flow orders without settlements/payouts
//  7. Stuck Payouts — stale, orphaned, or duplicate payout executions
//
// All checks use set-based grouped queries — a fixed number of round trips
// regardless of row counts.

import {
  isWalletCreditBackedDepositStatus,
  WALLET_CREDIT_BACKED_DEPOSIT_STATUSES,
} from "./deposit-status"
import { evaluateSettlementReleaseEvidence } from "./settlement-release-evidence"

type AnyPrisma = any

// ─── Fixed-point money helpers (BigInt, 12 fractional digits) ───────────────

const SCALE = 12
const SCALE_FACTOR = 10n ** BigInt(SCALE)

function toScaled(value: unknown): bigint {
  const s = String(value ?? 0)
  const neg = s.startsWith("-")
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".")
  const scaled =
    BigInt(whole || "0") * SCALE_FACTOR +
    BigInt((frac + "0".repeat(SCALE)).slice(0, SCALE))
  return neg ? -scaled : scaled
}

function fromScaled(scaled: bigint): string {
  const neg = scaled < 0n
  const abs = neg ? -scaled : scaled
  const whole = abs / SCALE_FACTOR
  let frac = (abs % SCALE_FACTOR)
    .toString()
    .padStart(SCALE, "0")
    .replace(/0+$/, "")
  if (frac.length < 2) frac = frac.padEnd(2, "0")
  return `${neg ? "-" : ""}${whole}.${frac}`
}

// ─── Enums & types ─────────────────────────────────────────────────────────

export enum ReconciliationCode {
  WALLET_DRIFT = "WALLET_DRIFT",
  PUBLISHER_DRIFT = "PUBLISHER_DRIFT",
  SETTLEMENT_AMOUNT_MISMATCH = "SETTLEMENT_AMOUNT_MISMATCH",
  SETTLEMENT_RELEASED_NO_TX = "SETTLEMENT_RELEASED_NO_TX",
  SETTLEMENT_TX_NOT_RELEASED = "SETTLEMENT_TX_NOT_RELEASED",
  SETTLEMENT_RELEASE_AMOUNT = "SETTLEMENT_RELEASE_AMOUNT",
  SETTLEMENT_DUPLICATE_RELEASE = "SETTLEMENT_DUPLICATE_RELEASE",
  SETTLEMENT_ORDER_COMPLETED_NONE = "SETTLEMENT_ORDER_COMPLETED_NONE",
  SETTLEMENT_ORDER_COMPLETED_MULTI = "SETTLEMENT_ORDER_COMPLETED_MULTI",
  SETTLEMENT_ORDER_COMPLETED_NOT_RELEASED = "SETTLEMENT_ORDER_COMPLETED_NOT_RELEASED",
  SETTLEMENT_ORDER_COMPLETED_RELEASE_LEDGER_INVALID = "SETTLEMENT_ORDER_COMPLETED_RELEASE_LEDGER_INVALID",
  SETTLEMENT_ORDER_COMPLETED_RELEASE_EVENT_INVALID = "SETTLEMENT_ORDER_COMPLETED_RELEASE_EVENT_INVALID",
  SETTLEMENT_ORPHAN = "SETTLEMENT_ORPHAN",
  SETTLEMENT_MISSING_ORDER = "SETTLEMENT_MISSING_ORDER",
  SETTLEMENT_MISSING_PUBLISHER = "SETTLEMENT_MISSING_PUBLISHER",
  SETTLEMENT_RELEASED_BALANCE_NOT_CREDITED = "SETTLEMENT_RELEASED_BALANCE_NOT_CREDITED",
  PAYMENT_UNMATCHED = "PAYMENT_UNMATCHED",
  PAYMENT_MISSING_WALLET = "PAYMENT_MISSING_WALLET",
  PAYMENT_ORDER_PAID_NO_TX = "PAYMENT_ORDER_PAID_NO_TX",
  PAYMENT_DUPLICATE = "PAYMENT_DUPLICATE",
  PAYMENT_AMOUNT_MISMATCH = "PAYMENT_AMOUNT_MISMATCH",
  PAYMENT_RESERVATION_RELEASE_MISSING = "PAYMENT_RESERVATION_RELEASE_MISSING",
  PAYMENT_RESERVATION_RELEASE_INVALID = "PAYMENT_RESERVATION_RELEASE_INVALID",
  REFUND_NO_TRANSACTION = "REFUND_NO_TRANSACTION",
  REFUND_ORPHAN_TX = "REFUND_ORPHAN_TX",
  REFUND_DUPLICATE = "REFUND_DUPLICATE",
  REFUND_PARTIAL = "REFUND_PARTIAL",
  REFUND_SETTLEMENT_NOT_REVERSED = "REFUND_SETTLEMENT_NOT_REVERSED",
  REFUND_PUBLISHER_COMPENSATION_MISSING = "REFUND_PUBLISHER_COMPENSATION_MISSING",
  REFUND_PUBLISHER_COMPENSATION_INVALID = "REFUND_PUBLISHER_COMPENSATION_INVALID",
  ORDER_DELIVERED_NO_SETTLEMENT = "ORDER_DELIVERED_NO_SETTLEMENT",
  ORDER_PAID_NO_SETTLEMENT = "ORDER_PAID_NO_SETTLEMENT",
  ORDER_VERIFIED_NO_SETTLEMENT = "ORDER_VERIFIED_NO_SETTLEMENT",
  PAYOUT_STALE_PROCESSING = "PAYOUT_STALE_PROCESSING",
  PAYOUT_STALE_EXECUTION = "PAYOUT_STALE_EXECUTION",
  PAYOUT_FAILED_ORPHAN = "PAYOUT_FAILED_ORPHAN",
  PAYOUT_DUPLICATE_COMPLETED = "PAYOUT_DUPLICATE_COMPLETED",
  PAYOUT_LIFETIME_DRIFT = "PAYOUT_LIFETIME_DRIFT",
  PAYOUT_COMPLETED_NO_EXECUTION = "PAYOUT_COMPLETED_NO_EXECUTION",
  PAYOUT_COMPLETION_EVIDENCE_INVALID = "PAYOUT_COMPLETION_EVIDENCE_INVALID",
  PAYOUT_LEGACY_COMPLETION_UNVERIFIED = "PAYOUT_LEGACY_COMPLETION_UNVERIFIED",
  PAYOUT_CLAIM_STALE = "PAYOUT_CLAIM_STALE",
  PAYOUT_CLAIM_EXPIRED = "PAYOUT_CLAIM_EXPIRED",
  PAYOUT_STATUS_MISMATCH = "PAYOUT_STATUS_MISMATCH",
  PAYOUT_REQUESTER_PROVENANCE_MISSING = "PAYOUT_REQUESTER_PROVENANCE_MISSING",
  PAYOUT_WEBHOOK_QUARANTINED = "PAYOUT_WEBHOOK_QUARANTINED",
  DEPOSIT_SUCCEEDED_NO_LEDGER = "DEPOSIT_SUCCEEDED_NO_LEDGER",
  DEPOSIT_LEDGER_AMOUNT_MISMATCH = "DEPOSIT_LEDGER_AMOUNT_MISMATCH",
  DEPOSIT_LEDGER_WITHOUT_SUCCESS = "DEPOSIT_LEDGER_WITHOUT_SUCCESS",
  DEPOSIT_INBOX_STALE = "DEPOSIT_INBOX_STALE",
  DEPOSIT_INBOX_FAILED = "DEPOSIT_INBOX_FAILED",
  DEPOSIT_INBOX_QUARANTINED = "DEPOSIT_INBOX_QUARANTINED",
  DEPOSIT_PROCESSED_EVIDENCE_MISMATCH = "DEPOSIT_PROCESSED_EVIDENCE_MISMATCH",
  PAYMENT_PROVIDER_EVENT_MODE_UNVERIFIED = "PAYMENT_PROVIDER_EVENT_MODE_UNVERIFIED",
  PAYMENT_DISPUTE_PROCESSED_NO_CASE = "PAYMENT_DISPUTE_PROCESSED_NO_CASE",
  PAYMENT_DISPUTE_AMOUNT_MISMATCH = "PAYMENT_DISPUTE_AMOUNT_MISMATCH",
  PAYMENT_DISPUTE_EXPOSURE_MISMATCH = "PAYMENT_DISPUTE_EXPOSURE_MISMATCH",
  PAYMENT_DISPUTE_OPEN_HOLD_MISMATCH = "PAYMENT_DISPUTE_OPEN_HOLD_MISMATCH",
  PAYMENT_DISPUTE_TERMINAL_HOLD_MISMATCH = "PAYMENT_DISPUTE_TERMINAL_HOLD_MISMATCH",
  PAYMENT_DISPUTE_TERMINAL_RESOLUTION_MISMATCH = "PAYMENT_DISPUTE_TERMINAL_RESOLUTION_MISMATCH",
  PAYMENT_DISPUTE_DEPOSIT_EVIDENCE_MISMATCH = "PAYMENT_DISPUTE_DEPOSIT_EVIDENCE_MISMATCH",
  PAYMENT_DISPUTE_EVENT_EVIDENCE_MISMATCH = "PAYMENT_DISPUTE_EVENT_EVIDENCE_MISMATCH",
  PAYMENT_DISPUTE_CUMULATIVE_AMOUNT_EXCEEDED = "PAYMENT_DISPUTE_CUMULATIVE_AMOUNT_EXCEEDED",
  PAYMENT_DISPUTE_UNCOVERED_EXPOSURE = "PAYMENT_DISPUTE_UNCOVERED_EXPOSURE",
  PAYMENT_DISPUTE_INBOX_STALE = "PAYMENT_DISPUTE_INBOX_STALE",
  PAYMENT_DISPUTE_INBOX_FAILED = "PAYMENT_DISPUTE_INBOX_FAILED",
  PAYMENT_DISPUTE_INBOX_QUARANTINED = "PAYMENT_DISPUTE_INBOX_QUARANTINED",
  PAYMENT_DISPUTE_ORPHAN_LEDGER = "PAYMENT_DISPUTE_ORPHAN_LEDGER",
  WALLET_WITHDRAWAL_WITHOUT_EXECUTION = "WALLET_WITHDRAWAL_WITHOUT_EXECUTION",
  WITHDRAWAL_ALLOCATION_MISMATCH = "WITHDRAWAL_ALLOCATION_MISMATCH",
  STRIPE_COMPLETED_WITHOUT_BANK_PAYOUT = "STRIPE_COMPLETED_WITHOUT_BANK_PAYOUT",
  PLATFORM_REVENUE_MISSING = "PLATFORM_REVENUE_MISSING",
  PLATFORM_REVENUE_UNEXPECTED_SETTLEMENT = "PLATFORM_REVENUE_UNEXPECTED_SETTLEMENT",
  PLATFORM_REVENUE_AMOUNT_MISMATCH = "PLATFORM_REVENUE_AMOUNT_MISMATCH",
  PLATFORM_REVENUE_REVERSED_FINAL_ORDER = "PLATFORM_REVENUE_REVERSED_FINAL_ORDER",
}

export enum ReconciliationCategory {
  WALLET = "wallet",
  PUBLISHER = "publisher",
  SETTLEMENT = "settlement",
  PAYMENT = "payment",
  REFUND = "refund",
  ORDER = "order",
  PAYOUT = "payout",
}

export enum SettlementIntegrityGroup {
  AMOUNT = "amount",
  SYNC = "sync",
  COMPLETENESS = "completeness",
}

export interface DriftRow {
  id: string
  severity: "critical" | "warning" | "info"
  category: ReconciliationCategory
  group?: SettlementIntegrityGroup
  code: ReconciliationCode
  entityId: string
  entityType: string
  amount?: string
  message: string
  detectedAt: string
  metadata?: {
    expectedAmount?: string
    actualAmount?: string
    expectedStatus?: string
    actualStatus?: string
    duplicateCount?: number
    transactionId?: string
    settlementId?: string
    publisherCompensationId?: string
    orderId?: string
    publisherId?: string
    walletId?: string
    publicReference?: string
    payoutExecutionId?: string
    completionSource?: string
    payoutWebhookEventId?: string
    providerDisputeId?: string
    providerEventId?: string
    paymentDisputeId?: string
    depositAttemptId?: string
    depositTransactionId?: string
    providerStatus?: string
  }
  action?: {
    type: "wallet" | "order" | "settlement" | "publisher" | "payout"
    id: string
  }
}

async function checkProviderNeutralDeposits(
  prisma: AnyPrisma,
): Promise<DriftRow[]> {
  if (!prisma.depositAttempt?.findMany) return []
  const attempts = await prisma.depositAttempt.findMany({
    where: {
      OR: [
        { status: { in: [...WALLET_CREDIT_BACKED_DEPOSIT_STATUSES] } },
        { ledgerTransactionId: { not: null } },
      ],
    },
    select: {
      id: true,
      publicReference: true,
      status: true,
      walletCredit: true,
      currency: true,
      ledgerTransactionId: true,
      ledgerTransaction: {
        select: { id: true, amount: true, currency: true, type: true },
      },
      paymentDisputes: {
        select: { status: true },
      },
    },
  })
  const drift: DriftRow[] = []
  for (const attempt of attempts) {
    const disputeStatuses = Array.isArray(attempt.paymentDisputes)
      ? attempt.paymentDisputes.map((item: any) => item.status)
      : []
    if (
      (attempt.status === "DISPUTED" && !disputeStatuses.includes("OPEN")) ||
      (attempt.status === "CHARGEBACK" && !disputeStatuses.includes("LOST"))
    ) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DISPUTE_DEPOSIT_EVIDENCE_MISMATCH,
          entityId: attempt.id,
          entityType: "DepositAttempt",
          message: `Deposit ${attempt.publicReference} is ${attempt.status} without the required durable dispute case`,
          metadata: {
            publicReference: attempt.publicReference,
            depositAttemptId: attempt.id,
            actualStatus: attempt.status,
          },
        }),
      )
    }
    const walletWasCredited = isWalletCreditBackedDepositStatus(attempt.status)
    if (walletWasCredited && !attempt.ledgerTransaction) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.DEPOSIT_SUCCEEDED_NO_LEDGER,
          entityId: attempt.id,
          entityType: "DepositAttempt",
          message: `Deposit ${attempt.publicReference} is ${attempt.status} without an attached wallet-credit ledger transaction`,
          metadata: { publicReference: attempt.publicReference },
        }),
      )
      continue
    }
    if (!walletWasCredited && attempt.ledgerTransaction) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.DEPOSIT_LEDGER_WITHOUT_SUCCESS,
          entityId: attempt.id,
          entityType: "DepositAttempt",
          message: `Deposit ${attempt.publicReference} has wallet credit while status is ${attempt.status}`,
          metadata: {
            publicReference: attempt.publicReference,
            transactionId: attempt.ledgerTransaction.id,
          },
        }),
      )
      continue
    }
    const ledger = attempt.ledgerTransaction
    if (
      ledger &&
      (toScaled(ledger.amount) !== toScaled(attempt.walletCredit) ||
        ledger.currency !== attempt.currency ||
        ledger.type !== "DEPOSIT")
    ) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.DEPOSIT_LEDGER_AMOUNT_MISMATCH,
          entityId: attempt.id,
          entityType: "DepositAttempt",
          amount: String(attempt.walletCredit),
          message: `Deposit ${attempt.publicReference} does not match its wallet ledger row`,
          metadata: {
            publicReference: attempt.publicReference,
            transactionId: ledger.id,
            expectedAmount: String(attempt.walletCredit),
            actualAmount: String(ledger.amount),
          },
        }),
      )
    }
  }
  return drift
}

async function checkDepositProviderEvents(
  prisma: AnyPrisma,
): Promise<DriftRow[]> {
  if (!prisma.paymentProviderEvent?.findMany) return []
  const successEventTypes = new Set([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
  ])
  const events = await prisma.paymentProviderEvent.findMany({
    where: {
      eventType: { in: [...successEventTypes] },
    },
    select: {
      id: true,
      provider: true,
      providerEventId: true,
      eventType: true,
      objectId: true,
      depositAttemptId: true,
      livemode: true,
      status: true,
      attempts: true,
      availableAt: true,
      lockedAt: true,
      receivedAt: true,
      lastError: true,
      depositAttempt: {
        select: {
          id: true,
          walletId: true,
          provider: true,
          providerSessionId: true,
          providerPaymentId: true,
          walletCredit: true,
          currency: true,
          status: true,
          ledgerTransactionId: true,
          ledgerTransaction: {
            select: {
              id: true,
              walletId: true,
              amount: true,
              currency: true,
              type: true,
              provider: true,
              providerRef: true,
            },
          },
        },
      },
    },
  })
  const now = Date.now()
  const drift: DriftRow[] = []
  for (const event of events.filter((item: any) =>
    successEventTypes.has(item.eventType),
  )) {
    const metadata = {
      providerEventId: event.providerEventId,
      depositAttemptId: event.depositAttemptId ?? undefined,
      actualStatus: event.status,
    }
    if (event.provider === "stripe" && typeof event.livemode !== "boolean") {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_PROVIDER_EVENT_MODE_UNVERIFIED,
          entityId: event.id,
          entityType: "PaymentProviderEvent",
          message: `Stripe deposit event ${event.providerEventId} is legacy evidence without a durable test/live mode`,
          metadata,
        }),
      )
    }
    if (event.status === "QUARANTINED") {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.DEPOSIT_INBOX_QUARANTINED,
          entityId: event.id,
          entityType: "PaymentProviderEvent",
          message: `Deposit success event ${event.providerEventId} is quarantined and requires Finance review`,
          metadata,
        }),
      )
      continue
    }
    if (event.status === "PROCESSED") {
      const attempt = event.depositAttempt
      const ledger = attempt?.ledgerTransaction
      const exact =
        attempt &&
        ledger &&
        attempt.id === event.depositAttemptId &&
        attempt.provider === event.provider &&
        attempt.providerSessionId === event.objectId &&
        isWalletCreditBackedDepositStatus(attempt.status) &&
        attempt.ledgerTransactionId === ledger.id &&
        ledger.type === "DEPOSIT" &&
        ledger.walletId === attempt.walletId &&
        toScaled(ledger.amount) === toScaled(attempt.walletCredit) &&
        ledger.currency === attempt.currency &&
        ledger.provider === attempt.provider &&
        ledger.providerRef === attempt.providerPaymentId
      if (!exact) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.PAYMENT,
            code: ReconciliationCode.DEPOSIT_PROCESSED_EVIDENCE_MISMATCH,
            entityId: event.id,
            entityType: "PaymentProviderEvent",
            message: `Processed deposit success event ${event.providerEventId} lacks exact attempt and wallet-credit ledger evidence`,
            metadata,
          }),
        )
      }
      continue
    }
    if (event.status === "FAILED") {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.DEPOSIT_INBOX_FAILED,
          entityId: event.id,
          entityType: "PaymentProviderEvent",
          message: `Deposit success event ${event.providerEventId} failed and requires a signed provider redelivery`,
          metadata,
        }),
      )
      continue
    }
    const receivedAt = new Date(event.receivedAt).getTime()
    const lockedAt = event.lockedAt
      ? new Date(event.lockedAt).getTime()
      : Number.NaN
    const stale =
      (event.status === "PENDING" &&
        (!Number.isFinite(receivedAt) || now - receivedAt > 15 * 60 * 1000)) ||
      (event.status === "PROCESSING" &&
        (!Number.isFinite(lockedAt) || now - lockedAt > 15 * 60 * 1000))
    if (stale) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.DEPOSIT_INBOX_STALE,
          entityId: event.id,
          entityType: "PaymentProviderEvent",
          message: `Deposit success event ${event.providerEventId} has a stale ${event.status} inbox state`,
          metadata,
        }),
      )
    }
  }
  return drift
}

async function checkPaymentDisputes(prisma: AnyPrisma): Promise<DriftRow[]> {
  if (!prisma.paymentDispute?.findMany) return []
  const cases = await prisma.paymentDispute.findMany({
    select: {
      id: true,
      provider: true,
      providerDisputeId: true,
      providerPaymentId: true,
      providerChargeId: true,
      depositAttemptId: true,
      depositTransactionId: true,
      openedByEventId: true,
      resolvedByEventId: true,
      providerStatus: true,
      openedAt: true,
      resolvedAt: true,
      amount: true,
      currency: true,
      heldAmount: true,
      shortfallAmount: true,
      currentExposureAmount: true,
      status: true,
      walletId: true,
      depositAttempt: {
        select: {
          id: true,
          walletId: true,
          walletCredit: true,
          currency: true,
          provider: true,
          providerPaymentId: true,
          ledgerTransactionId: true,
          status: true,
        },
      },
      depositTransaction: {
        select: {
          id: true,
          walletId: true,
          amount: true,
          currency: true,
          type: true,
          provider: true,
          providerRef: true,
        },
      },
      openedByEvent: {
        select: {
          id: true,
          provider: true,
          providerEventId: true,
          eventType: true,
          objectId: true,
          depositAttemptId: true,
          paymentDisputeId: true,
          providerPaymentId: true,
          providerChargeId: true,
          disputeAmountMinor: true,
          disputeCurrency: true,
          providerStatus: true,
          livemode: true,
          eventFingerprint: true,
          status: true,
        },
      },
      resolvedByEvent: {
        select: {
          id: true,
          provider: true,
          providerEventId: true,
          eventType: true,
          objectId: true,
          depositAttemptId: true,
          paymentDisputeId: true,
          providerPaymentId: true,
          providerChargeId: true,
          disputeAmountMinor: true,
          disputeCurrency: true,
          providerStatus: true,
          livemode: true,
          eventFingerprint: true,
          status: true,
        },
      },
      holdTransaction: {
        select: {
          id: true,
          walletId: true,
          amount: true,
          currency: true,
          type: true,
          reference: true,
          provider: true,
          providerRef: true,
        },
      },
      resolutionTransaction: {
        select: {
          id: true,
          walletId: true,
          amount: true,
          currency: true,
          type: true,
          reference: true,
          provider: true,
          providerRef: true,
        },
      },
    },
  })
  const drift: DriftRow[] = []
  const casesById = new Map(cases.map((item: any) => [item.id, item]))
  const deposits = new Map<
    string,
    {
      amount: bigint
      disputed: bigint
      walletId: string
      statuses: string[]
      attempt: any
      providerDisputeId: string
    }
  >()
  const openStatuses = new Set([
    "needs_response",
    "under_review",
    "warning_needs_response",
    "warning_under_review",
  ])
  const wonStatuses = new Set(["won", "prevented", "warning_closed"])

  const eventAmountMatches = (event: any, amount: unknown): boolean => {
    try {
      return (
        event?.disputeAmountMinor != null &&
        toScaled(amount) * 100n ===
          BigInt(event.disputeAmountMinor) * SCALE_FACTOR
      )
    } catch {
      return false
    }
  }

  const eventMatchesCase = (
    event: any,
    paymentDispute: any,
    expectedType: "charge.dispute.created" | "charge.dispute.closed",
  ): boolean => {
    const validStatus =
      expectedType === "charge.dispute.created"
        ? openStatuses.has(event?.providerStatus)
        : paymentDispute.status === "WON"
          ? wonStatuses.has(event?.providerStatus)
          : event?.providerStatus === "lost"
    return Boolean(
      event &&
        event.status === "PROCESSED" &&
        event.eventType === expectedType &&
        event.provider === paymentDispute.provider &&
        event.objectId === paymentDispute.providerDisputeId &&
        event.paymentDisputeId === paymentDispute.id &&
        event.depositAttemptId === paymentDispute.depositAttemptId &&
        event.providerPaymentId === paymentDispute.providerPaymentId &&
        (event.providerChargeId ?? null) ===
          (paymentDispute.providerChargeId ?? null) &&
        event.disputeCurrency === paymentDispute.currency &&
        eventAmountMatches(event, paymentDispute.amount) &&
        typeof event.livemode === "boolean" &&
        typeof event.eventFingerprint === "string" &&
        /^[0-9a-f]{64}$/.test(event.eventFingerprint) &&
        validStatus,
    )
  }

  for (const paymentDispute of cases) {
    const amount = toScaled(paymentDispute.amount)
    const held = toScaled(paymentDispute.heldAmount)
    const bookedShortfall = toScaled(paymentDispute.shortfallAmount)
    const currentExposure = toScaled(paymentDispute.currentExposureAmount)
    if (
      amount <= 0n ||
      held < 0n ||
      held > amount ||
      bookedShortfall < 0n ||
      held + bookedShortfall !== amount
    ) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DISPUTE_AMOUNT_MISMATCH,
          entityId: paymentDispute.id,
          entityType: "PaymentDispute",
          amount: fromScaled(amount),
          message: `Payment dispute ${paymentDispute.providerDisputeId} has inconsistent amount, hold, or booked shortfall values`,
          metadata: {
            paymentDisputeId: paymentDispute.id,
            providerDisputeId: paymentDispute.providerDisputeId,
            walletId: paymentDispute.walletId,
            expectedAmount: fromScaled(amount),
            actualAmount: `${fromScaled(held)} held + ${fromScaled(bookedShortfall)} booked shortfall`,
          },
          action: { type: "wallet", id: paymentDispute.walletId },
        }),
      )
    }

    const expectedExposure =
      paymentDispute.status === "WON" ? 0n : bookedShortfall
    if (currentExposure < 0n || currentExposure !== expectedExposure) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DISPUTE_EXPOSURE_MISMATCH,
          entityId: paymentDispute.id,
          entityType: "PaymentDispute",
          amount: fromScaled(currentExposure),
          message: `Payment dispute ${paymentDispute.providerDisputeId} has inconsistent current exposure for ${paymentDispute.status}`,
          metadata: {
            paymentDisputeId: paymentDispute.id,
            providerDisputeId: paymentDispute.providerDisputeId,
            walletId: paymentDispute.walletId,
            expectedAmount: fromScaled(expectedExposure),
            actualAmount: fromScaled(currentExposure),
          },
          action: { type: "wallet", id: paymentDispute.walletId },
        }),
      )
    } else if (currentExposure > 0n) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DISPUTE_UNCOVERED_EXPOSURE,
          entityId: paymentDispute.id,
          entityType: "PaymentDispute",
          amount: fromScaled(currentExposure),
          message: `Payment dispute ${paymentDispute.providerDisputeId} has ${fromScaled(currentExposure)} ${paymentDispute.currency} of uncovered customer-wallet exposure`,
          metadata: {
            paymentDisputeId: paymentDispute.id,
            providerDisputeId: paymentDispute.providerDisputeId,
            walletId: paymentDispute.walletId,
            actualAmount: fromScaled(currentExposure),
          },
          action: { type: "wallet", id: paymentDispute.walletId },
        }),
      )
    }

    const attempt = paymentDispute.depositAttempt
    const deposit = paymentDispute.depositTransaction
    const hasDepositProjection = Object.hasOwn(
      paymentDispute,
      "depositAttemptId",
    )
    const exactDeposit =
      attempt &&
      deposit &&
      paymentDispute.currency === "USD" &&
      deposit.id === paymentDispute.depositTransactionId &&
      deposit.type === "DEPOSIT" &&
      deposit.walletId === paymentDispute.walletId &&
      deposit.currency === paymentDispute.currency &&
      deposit.provider === paymentDispute.provider &&
      deposit.providerRef === paymentDispute.providerPaymentId &&
      attempt.id === paymentDispute.depositAttemptId &&
      attempt.ledgerTransactionId === deposit.id &&
      attempt.walletId === paymentDispute.walletId &&
      attempt.currency === paymentDispute.currency &&
      attempt.provider === paymentDispute.provider &&
      attempt.providerPaymentId === paymentDispute.providerPaymentId &&
      isWalletCreditBackedDepositStatus(attempt.status) &&
      toScaled(attempt.walletCredit) === toScaled(deposit.amount) &&
      amount <= toScaled(deposit.amount)
    if (hasDepositProjection && !exactDeposit) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DISPUTE_DEPOSIT_EVIDENCE_MISMATCH,
          entityId: paymentDispute.id,
          entityType: "PaymentDispute",
          amount: fromScaled(amount),
          message: `Payment dispute ${paymentDispute.providerDisputeId} does not exactly match its credited deposit and funding attempt`,
          metadata: {
            paymentDisputeId: paymentDispute.id,
            providerDisputeId: paymentDispute.providerDisputeId,
            walletId: paymentDispute.walletId,
            depositAttemptId: paymentDispute.depositAttemptId,
            depositTransactionId: paymentDispute.depositTransactionId,
          },
          action: { type: "wallet", id: paymentDispute.walletId },
        }),
      )
    } else if (exactDeposit) {
      const grouped = deposits.get(deposit.id) ?? {
        amount: toScaled(deposit.amount),
        disputed: 0n,
        walletId: paymentDispute.walletId,
        statuses: [] as string[],
        attempt,
        providerDisputeId: paymentDispute.providerDisputeId,
      }
      grouped.disputed += amount
      grouped.statuses.push(paymentDispute.status)
      deposits.set(deposit.id, grouped)
    }

    const validProviderState =
      paymentDispute.status === "OPEN"
        ? openStatuses.has(paymentDispute.providerStatus)
        : paymentDispute.status === "WON"
          ? wonStatuses.has(paymentDispute.providerStatus)
          : paymentDispute.providerStatus === "lost"
    const openingEvidenceValid =
      paymentDispute.openedByEventId == null
        ? paymentDispute.status !== "OPEN" &&
          paymentDispute.openedAt == null &&
          paymentDispute.openedByEvent == null
        : paymentDispute.openedAt != null &&
          paymentDispute.openedByEvent?.id === paymentDispute.openedByEventId &&
          eventMatchesCase(
            paymentDispute.openedByEvent,
            paymentDispute,
            "charge.dispute.created",
          )
    const resolutionEvidenceValid =
      paymentDispute.status === "OPEN"
        ? paymentDispute.resolvedByEventId == null &&
          paymentDispute.resolvedAt == null &&
          paymentDispute.resolvedByEvent == null
        : paymentDispute.resolvedByEventId != null &&
          paymentDispute.resolvedAt != null &&
          paymentDispute.resolvedByEvent?.id ===
            paymentDispute.resolvedByEventId &&
          eventMatchesCase(
            paymentDispute.resolvedByEvent,
            paymentDispute,
            "charge.dispute.closed",
          )
    const hasEventProjection = Object.hasOwn(paymentDispute, "providerStatus")
    if (
      hasEventProjection &&
      (!validProviderState || !openingEvidenceValid || !resolutionEvidenceValid)
    ) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DISPUTE_EVENT_EVIDENCE_MISMATCH,
          entityId: paymentDispute.id,
          entityType: "PaymentDispute",
          message: `Payment dispute ${paymentDispute.providerDisputeId} has missing or contradictory normalized provider-event evidence`,
          metadata: {
            paymentDisputeId: paymentDispute.id,
            providerDisputeId: paymentDispute.providerDisputeId,
            providerStatus: paymentDispute.providerStatus,
            expectedStatus: paymentDispute.status,
          },
          action: { type: "wallet", id: paymentDispute.walletId },
        }),
      )
    }

    const hold = paymentDispute.holdTransaction
    const referencePrefix = `payment-dispute:${paymentDispute.provider}:${paymentDispute.providerDisputeId}`
    const hasExactHold =
      hold &&
      hold.walletId === paymentDispute.walletId &&
      hold.currency === paymentDispute.currency &&
      hold.type === "RESERVATION" &&
      hold.reference === `${referencePrefix}:hold` &&
      hold.provider == null &&
      hold.providerRef == null &&
      toScaled(hold.amount) === -held
    if (paymentDispute.status === "OPEN") {
      const validHold =
        paymentDispute.resolutionTransaction == null &&
        (held === 0n ? hold == null : hasExactHold)
      if (!validHold) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.PAYMENT,
            code: ReconciliationCode.PAYMENT_DISPUTE_OPEN_HOLD_MISMATCH,
            entityId: paymentDispute.id,
            entityType: "PaymentDispute",
            amount: fromScaled(held),
            message: `Open payment dispute ${paymentDispute.providerDisputeId} is missing exact wallet-hold evidence`,
            metadata: {
              paymentDisputeId: paymentDispute.id,
              providerDisputeId: paymentDispute.providerDisputeId,
              walletId: paymentDispute.walletId,
              transactionId: hold?.id,
              expectedAmount: fromScaled(-held),
              actualAmount: hold ? String(hold.amount) : undefined,
            },
            action: { type: "wallet", id: paymentDispute.walletId },
          }),
        )
      }
      continue
    }

    const validTerminalHold =
      held === 0n
        ? hold == null
        : paymentDispute.status === "WON"
          ? hasExactHold
          : hold == null || hasExactHold
    if (!validTerminalHold) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DISPUTE_TERMINAL_HOLD_MISMATCH,
          entityId: paymentDispute.id,
          entityType: "PaymentDispute",
          amount: fromScaled(held),
          message: `Terminal payment dispute ${paymentDispute.providerDisputeId} has invalid historical hold evidence for ${paymentDispute.status}`,
          metadata: {
            paymentDisputeId: paymentDispute.id,
            providerDisputeId: paymentDispute.providerDisputeId,
            walletId: paymentDispute.walletId,
            transactionId: hold?.id,
            expectedAmount: fromScaled(-held),
            actualAmount: hold ? String(hold.amount) : undefined,
          },
          action: { type: "wallet", id: paymentDispute.walletId },
        }),
      )
    }

    const resolution = paymentDispute.resolutionTransaction
    const expectedType =
      paymentDispute.status === "WON" ? "RESERVATION" : "CHARGEBACK"
    const expectedAmount = paymentDispute.status === "WON" ? held : -held
    const validResolution =
      held === 0n
        ? resolution == null
        : resolution &&
          resolution.walletId === paymentDispute.walletId &&
          resolution.currency === paymentDispute.currency &&
          resolution.type === expectedType &&
          resolution.reference ===
            `${referencePrefix}:${paymentDispute.status.toLowerCase()}` &&
          resolution.provider == null &&
          resolution.providerRef == null &&
          toScaled(resolution.amount) === expectedAmount
    if (!validResolution) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DISPUTE_TERMINAL_RESOLUTION_MISMATCH,
          entityId: paymentDispute.id,
          entityType: "PaymentDispute",
          amount: fromScaled(expectedAmount),
          message: `Terminal payment dispute ${paymentDispute.providerDisputeId} is missing exact ${paymentDispute.status} resolution evidence`,
          metadata: {
            paymentDisputeId: paymentDispute.id,
            providerDisputeId: paymentDispute.providerDisputeId,
            walletId: paymentDispute.walletId,
            transactionId: resolution?.id,
            expectedAmount: fromScaled(expectedAmount),
            actualAmount: resolution ? String(resolution.amount) : undefined,
            expectedStatus: expectedType,
            actualStatus: resolution?.type,
          },
          action: { type: "wallet", id: paymentDispute.walletId },
        }),
      )
    }
  }

  for (const [depositTransactionId, grouped] of deposits) {
    if (grouped.disputed > grouped.amount) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DISPUTE_CUMULATIVE_AMOUNT_EXCEEDED,
          entityId: depositTransactionId,
          entityType: "Transaction",
          amount: fromScaled(grouped.disputed - grouped.amount),
          message: `Cumulative disputes exceed originating deposit ${depositTransactionId}`,
          metadata: {
            providerDisputeId: grouped.providerDisputeId,
            walletId: grouped.walletId,
            depositTransactionId,
            expectedAmount: fromScaled(grouped.amount),
            actualAmount: fromScaled(grouped.disputed),
          },
          action: { type: "wallet", id: grouped.walletId },
        }),
      )
    }
    const expectedAttemptStatus = grouped.statuses.includes("LOST")
      ? "CHARGEBACK"
      : grouped.statuses.includes("OPEN")
        ? "DISPUTED"
        : "SUCCEEDED"
    const refundProjectionPreserved =
      grouped.attempt.status === "PARTIALLY_REFUNDED" ||
      grouped.attempt.status === "REFUNDED"
    if (
      grouped.attempt.status !== expectedAttemptStatus &&
      !refundProjectionPreserved
    ) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DISPUTE_DEPOSIT_EVIDENCE_MISMATCH,
          entityId: grouped.attempt.id,
          entityType: "DepositAttempt",
          message: `Deposit attempt ${grouped.attempt.id} is ${grouped.attempt.status} but its dispute cases require ${expectedAttemptStatus}`,
          metadata: {
            depositAttemptId: grouped.attempt.id,
            depositTransactionId,
            walletId: grouped.walletId,
            expectedStatus: expectedAttemptStatus,
            actualStatus: grouped.attempt.status,
          },
          action: { type: "wallet", id: grouped.walletId },
        }),
      )
    }
  }

  if (prisma.paymentProviderEvent?.findMany) {
    const events = await prisma.paymentProviderEvent.findMany({
      where: {
        eventType: {
          in: ["charge.dispute.created", "charge.dispute.closed"],
        },
      },
      select: {
        id: true,
        provider: true,
        providerEventId: true,
        eventType: true,
        objectId: true,
        depositAttemptId: true,
        paymentDisputeId: true,
        providerPaymentId: true,
        providerChargeId: true,
        disputeAmountMinor: true,
        disputeCurrency: true,
        providerStatus: true,
        livemode: true,
        eventFingerprint: true,
        status: true,
        attempts: true,
        availableAt: true,
        lockedAt: true,
        receivedAt: true,
        lastError: true,
      },
    })
    const now = Date.now()
    for (const event of events.filter((item: any) =>
      ["charge.dispute.created", "charge.dispute.closed"].includes(
        item.eventType,
      ),
    )) {
      if (event.status === "QUARANTINED") {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.PAYMENT,
            code: ReconciliationCode.PAYMENT_DISPUTE_INBOX_QUARANTINED,
            entityId: event.id,
            entityType: "PaymentProviderEvent",
            message: `Payment dispute event ${event.providerEventId} is quarantined and requires Finance review`,
            metadata: {
              providerEventId: event.providerEventId,
              providerDisputeId: event.objectId ?? undefined,
              paymentDisputeId: event.paymentDisputeId ?? undefined,
              actualStatus: event.status,
            },
          }),
        )
        continue
      }
      if (event.status === "FAILED") {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.PAYMENT,
            code: ReconciliationCode.PAYMENT_DISPUTE_INBOX_FAILED,
            entityId: event.id,
            entityType: "PaymentProviderEvent",
            message: `Payment dispute event ${event.providerEventId} failed and is awaiting durable retry`,
            metadata: {
              providerEventId: event.providerEventId,
              providerDisputeId: event.objectId ?? undefined,
              actualStatus: event.status,
            },
          }),
        )
        continue
      }
      const receivedAt = new Date(event.receivedAt).getTime()
      const lockedAt = event.lockedAt
        ? new Date(event.lockedAt).getTime()
        : Number.NaN
      const stale =
        (event.status === "PENDING" && now - receivedAt > 15 * 60 * 1000) ||
        (event.status === "PROCESSING" &&
          (!Number.isFinite(lockedAt) || now - lockedAt > 15 * 60 * 1000))
      if (stale) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.PAYMENT,
            code: ReconciliationCode.PAYMENT_DISPUTE_INBOX_STALE,
            entityId: event.id,
            entityType: "PaymentProviderEvent",
            message: `Payment dispute event ${event.providerEventId} has a stale ${event.status} inbox state`,
            metadata: {
              providerEventId: event.providerEventId,
              providerDisputeId: event.objectId ?? undefined,
              actualStatus: event.status,
            },
          }),
        )
        continue
      }
      if (event.status !== "PROCESSED") continue

      const paymentDispute = casesById.get(event.paymentDisputeId)
      if (!paymentDispute) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.PAYMENT,
            code: ReconciliationCode.PAYMENT_DISPUTE_PROCESSED_NO_CASE,
            entityId: event.id,
            entityType: "PaymentProviderEvent",
            message: `Processed ${event.eventType} event ${event.providerEventId} has no exact durable payment-dispute association`,
            metadata: {
              providerEventId: event.providerEventId,
              providerDisputeId: event.objectId ?? undefined,
              paymentDisputeId: event.paymentDisputeId ?? undefined,
            },
          }),
        )
        continue
      }
      if (
        !eventMatchesCase(
          event,
          paymentDispute,
          event.eventType as "charge.dispute.created" | "charge.dispute.closed",
        )
      ) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.PAYMENT,
            code: ReconciliationCode.PAYMENT_DISPUTE_EVENT_EVIDENCE_MISMATCH,
            entityId: event.id,
            entityType: "PaymentProviderEvent",
            message: `Processed payment dispute event ${event.providerEventId} does not exactly match its durable case`,
            metadata: {
              providerEventId: event.providerEventId,
              providerDisputeId: event.objectId ?? undefined,
              paymentDisputeId: event.paymentDisputeId,
            },
          }),
        )
      }
    }
  }

  if (prisma.transaction?.findMany) {
    const ledgerRows = await prisma.transaction.findMany({
      where: { reference: { startsWith: "payment-dispute:" } },
      select: {
        id: true,
        walletId: true,
        amount: true,
        reference: true,
        paymentDisputeHold: { select: { id: true } },
        paymentDisputeResolution: { select: { id: true } },
      },
    })
    for (const transaction of ledgerRows.filter((item: any) =>
      String(item.reference ?? "").startsWith("payment-dispute:"),
    )) {
      if (
        transaction.paymentDisputeHold ||
        transaction.paymentDisputeResolution
      ) {
        continue
      }
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DISPUTE_ORPHAN_LEDGER,
          entityId: transaction.id,
          entityType: "Transaction",
          amount: String(transaction.amount),
          message: `Payment dispute ledger transaction ${transaction.id} is not linked to a durable case`,
          metadata: {
            transactionId: transaction.id,
            walletId: transaction.walletId ?? undefined,
          },
          action: transaction.walletId
            ? { type: "wallet", id: transaction.walletId }
            : undefined,
        }),
      )
    }
  }

  return drift
}

async function checkLegacyWalletWithdrawals(
  prisma: AnyPrisma,
): Promise<DriftRow[]> {
  if (!prisma.transaction?.findMany) return []
  const transactions = await prisma.transaction.findMany({
    where: {
      type: "WITHDRAWAL",
      walletId: { not: null },
    },
    select: {
      id: true,
      type: true,
      walletId: true,
      amount: true,
      reference: true,
      createdAt: true,
    },
  })

  // Keep the defensive type check because lightweight reconciliation mocks do
  // not execute Prisma WHERE clauses. Production Prisma already filters it.
  return transactions
    .filter(
      (transaction: any) =>
        transaction.type === "WITHDRAWAL" && transaction.walletId,
    )
    .map((transaction: any) =>
      makeRow({
        severity: "critical",
        category: ReconciliationCategory.PAYMENT,
        code: ReconciliationCode.WALLET_WITHDRAWAL_WITHOUT_EXECUTION,
        entityId: transaction.id,
        entityType: "Transaction",
        amount: String(transaction.amount),
        message: `Wallet withdrawal transaction ${transaction.id} has no durable external refund or transfer evidence`,
        metadata: {
          transactionId: transaction.id,
          walletId: transaction.walletId,
          publicReference: transaction.reference ?? undefined,
        },
        action: { type: "wallet", id: transaction.walletId },
      }),
    )
}

async function checkWithdrawalTraceability(
  prisma: AnyPrisma,
): Promise<DriftRow[]> {
  if (!prisma.withdrawal?.findMany) return []
  const withdrawals = await prisma.withdrawal.findMany({
    where: {
      publicReference: { not: null },
      status: { in: ["PENDING", "APPROVED", "PROCESSING", "COMPLETED"] },
    },
    select: {
      id: true,
      publicReference: true,
      amount: true,
      publisherId: true,
      allocations: {
        where: { releasedAt: null },
        select: { amount: true },
      },
      executions: {
        where: { status: "COMPLETED" },
        select: {
          id: true,
          providerPayoutId: true,
          stage: true,
          provider: { select: { name: true } },
        },
      },
    },
  })
  const drift: DriftRow[] = []
  for (const withdrawal of withdrawals) {
    const allocated = withdrawal.allocations.reduce(
      (sum: bigint, item: any) => sum + toScaled(item.amount),
      0n,
    )
    if (allocated !== toScaled(withdrawal.amount)) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.WITHDRAWAL_ALLOCATION_MISMATCH,
          entityId: withdrawal.id,
          entityType: "Withdrawal",
          amount: fromScaled(allocated - toScaled(withdrawal.amount)),
          message: `Withdrawal ${withdrawal.publicReference} source allocations do not equal its gross amount`,
          metadata: {
            publicReference: withdrawal.publicReference,
            publisherId: withdrawal.publisherId,
            expectedAmount: String(withdrawal.amount),
            actualAmount: fromScaled(allocated),
          },
          action: { type: "payout", id: withdrawal.id },
        }),
      )
    }
    for (const execution of withdrawal.executions) {
      if (
        execution.provider.name === "stripe_connect" &&
        (!execution.providerPayoutId || execution.stage !== "BANK_PAID")
      ) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.PAYOUT,
            code: ReconciliationCode.STRIPE_COMPLETED_WITHOUT_BANK_PAYOUT,
            entityId: execution.id,
            entityType: "PayoutExecution",
            message: `Stripe execution for ${withdrawal.publicReference} is completed without bank-payout evidence`,
            metadata: {
              publicReference: withdrawal.publicReference,
              publisherId: withdrawal.publisherId,
              payoutExecutionId: execution.id,
            },
            action: { type: "payout", id: withdrawal.id },
          }),
        )
      }
    }
  }
  return drift
}

export interface ReconciliationReport {
  version: 1
  ranAt: string
  scanDurationMs: number
  ok: boolean
  summary: {
    critical: number
    warning: number
    info: number
    totalIssues: number
  }
  stats: {
    checkedWallets: number
    checkedSettlements: number
    checkedOrders: number
    checkedTransactions: number
    checkedPublishers: number
  }
  walletDrift: DriftRow[]
  publisherDrift: DriftRow[]
  settlementDrift: DriftRow[]
  orderPaymentRecon: DriftRow[]
  refundRecon: DriftRow[]
  stuckFinancialOrders: DriftRow[]
  stuckPayouts: DriftRow[]
}

interface DriftStats {
  checkedWallets: number
  checkedSettlements: number
  checkedOrders: number
  checkedTransactions: number
  checkedPublishers: number
}

function makeRow(
  overrides: Omit<DriftRow, "id" | "detectedAt"> & { id?: string },
): DriftRow {
  const stableId = [
    overrides.code,
    overrides.entityType,
    overrides.entityId,
    overrides.group ?? "all",
    overrides.metadata?.transactionId ??
      overrides.metadata?.settlementId ??
      overrides.metadata?.payoutExecutionId ??
      "",
  ].join(":")
  return {
    ...overrides,
    id: overrides.id ?? stableId,
    detectedAt: new Date().toISOString(),
  }
}

// ─── 1. Wallet Drift ───────────────────────────────────────────────────────

async function checkWallets(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
  const [wallets, sums] = await Promise.all([
    prisma.wallet.findMany({
      select: {
        id: true,
        organizationId: true,
        availableBalance: true,
        reservedBalance: true,
      },
    }),
    prisma.transaction.groupBy({
      by: ["walletId", "type"],
      where: { walletId: { not: null } },
      _sum: { amount: true },
    }),
  ])

  stats.checkedWallets = wallets.length
  stats.checkedTransactions += sums.length

  const expectedByWallet = new Map<string, bigint>()
  for (const s of sums) {
    // RESERVATION and RELEASE are bucket transfers between available and
    // reserved funds. They are append-only subledger evidence but do not alter
    // the wallet's combined cash balance.
    if (s.type === "RESERVATION" || s.type === "RELEASE" || !s.walletId)
      continue
    const current = expectedByWallet.get(s.walletId) ?? 0n
    expectedByWallet.set(s.walletId, current + toScaled(s._sum.amount ?? 0))
  }

  const drift: DriftRow[] = []
  for (const w of wallets) {
    const expected = expectedByWallet.get(w.id) ?? 0n
    const actual = toScaled(w.availableBalance) + toScaled(w.reservedBalance)
    if (actual !== expected) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.WALLET,
          code: ReconciliationCode.WALLET_DRIFT,
          entityId: w.id,
          entityType: "Wallet",
          amount: fromScaled(actual - expected),
          message: `Wallet ${w.id.slice(0, 8)} balance (${fromScaled(actual)}) differs from ledger (${fromScaled(expected)})`,
          metadata: {
            expectedAmount: fromScaled(expected),
            actualAmount: fromScaled(actual),
            walletId: w.id,
          },
          action: { type: "wallet", id: w.id },
        }),
      )
    }
  }
  return drift
}

// ─── 2. Publisher Balance Drift ────────────────────────────────────────────

async function checkPublisherBalances(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
  const LEDGER_TYPES = [
    "SETTLEMENT_RELEASE",
    "PUBLISHER_COMPENSATION",
    "DEBT_REPAYMENT",
    "SETTLEMENT_CLAWBACK",
    "WITHDRAWAL",
    "WITHDRAWAL_REVERSAL",
  ]
  const [balances, sums] = await Promise.all([
    prisma.publisherBalance.findMany({
      select: {
        publisherId: true,
        withdrawableBalance: true,
        debtBalance: true,
      },
    }),
    prisma.transaction.groupBy({
      by: ["publisherId"],
      where: { publisherId: { not: null }, type: { in: LEDGER_TYPES as any } },
      _sum: { amount: true },
    }),
  ])

  stats.checkedPublishers = balances.length
  stats.checkedTransactions += sums.length

  const expectedByPublisher = new Map<string, bigint>()
  for (const s of sums) {
    if (s.publisherId)
      expectedByPublisher.set(s.publisherId, toScaled(s._sum.amount ?? 0))
  }

  const drift: DriftRow[] = []
  for (const b of balances) {
    const expected = expectedByPublisher.get(b.publisherId) ?? 0n
    const actual = toScaled(b.withdrawableBalance)
    if (actual !== expected) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PUBLISHER,
          code: ReconciliationCode.PUBLISHER_DRIFT,
          entityId: b.publisherId,
          entityType: "PublisherBalance",
          amount: fromScaled(actual - expected),
          message: `Publisher ${b.publisherId.slice(0, 8)} withdrawable balance (${fromScaled(actual)}) differs from ledger (${fromScaled(expected)})`,
          metadata: {
            expectedAmount: fromScaled(expected),
            actualAmount: fromScaled(actual),
            publisherId: b.publisherId,
          },
          action: { type: "publisher", id: b.publisherId },
        }),
      )
    }
  }
  return drift
}

// ─── 3. Settlement Integrity ───────────────────────────────────────────────

async function checkSettlementDrift(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
  const drift: DriftRow[] = []
  const now = new Date().toISOString()

  // ── 3a. Amount Integrity ──────────────────────────────────────────────────

  const allSettlements = await prisma.settlement.findMany({
    where: { status: { not: "CANCELLED" } },
    select: {
      id: true,
      grossAmount: true,
      platformFee: true,
      publisherAmount: true,
      publisherId: true,
      orderId: true,
      status: true,
    },
  })
  stats.checkedSettlements = allSettlements.length

  for (const s of allSettlements) {
    const gross = toScaled(s.grossAmount)
    const fee = toScaled(s.platformFee)
    const pub = toScaled(s.publisherAmount)
    if (gross !== fee + pub) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.SETTLEMENT,
          group: SettlementIntegrityGroup.AMOUNT,
          code: ReconciliationCode.SETTLEMENT_AMOUNT_MISMATCH,
          entityId: s.id,
          entityType: "Settlement",
          amount: fromScaled(gross - (fee + pub)),
          message: `Settlement ${s.id.slice(0, 8)} gross (${fromScaled(gross)}) ≠ platformFee (${fromScaled(fee)}) + publisherAmount (${fromScaled(pub)})`,
          metadata: {
            expectedAmount: fromScaled(fee + pub),
            actualAmount: fromScaled(gross),
            settlementId: s.id,
          },
          action: { type: "settlement", id: s.id },
        }),
      )
    }
  }

  // ── 3b. Ledger Synchronization ───────────────────────────────────────────

  const releaseSettlements = allSettlements.filter(
    (s: any) => s.status === "RELEASED",
  )
  const settlementIds = releaseSettlements.map((s: any) => s.id)

  if (settlementIds.length > 0) {
    const releaseTxs = await prisma.transaction.groupBy({
      by: ["settlementId", "type"],
      where: {
        settlementId: { in: settlementIds },
        type: "SETTLEMENT_RELEASE" as any,
      },
      _sum: { amount: true },
      _count: true,
    })
    stats.checkedTransactions += releaseTxs.length

    const txBySettlement = new Map<string, { count: number; sum: bigint }>(
      releaseTxs.map((t: any) => [
        t.settlementId as string,
        {
          count: (t._count as any) ?? 1,
          sum: toScaled((t._sum as any).amount ?? 0),
        },
      ]),
    )

    for (const s of releaseSettlements) {
      const txInfo = txBySettlement.get(s.id)
      if (!txInfo) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.SETTLEMENT,
            group: SettlementIntegrityGroup.SYNC,
            code: ReconciliationCode.SETTLEMENT_RELEASED_NO_TX,
            entityId: s.id,
            entityType: "Settlement",
            message: `Settlement ${s.id.slice(0, 8)} is RELEASED but has no SETTLEMENT_RELEASE transaction`,
            metadata: { settlementId: s.id },
            action: { type: "settlement", id: s.id },
          }),
        )
      } else {
        const pubAmount = toScaled(s.publisherAmount)
        if (txInfo.sum !== pubAmount) {
          drift.push(
            makeRow({
              severity: "critical",
              category: ReconciliationCategory.SETTLEMENT,
              group: SettlementIntegrityGroup.SYNC,
              code: ReconciliationCode.SETTLEMENT_RELEASE_AMOUNT,
              entityId: s.id,
              entityType: "Settlement",
              amount: fromScaled(txInfo.sum - pubAmount),
              message: `Settlement ${s.id.slice(0, 8)} publisherAmount (${fromScaled(pubAmount)}) ≠ release transaction sum (${fromScaled(txInfo.sum)})`,
              metadata: {
                expectedAmount: fromScaled(pubAmount),
                actualAmount: fromScaled(txInfo.sum),
                settlementId: s.id,
              },
              action: { type: "settlement", id: s.id },
            }),
          )
        }
        if (txInfo.count > 1) {
          drift.push(
            makeRow({
              severity: "critical",
              category: ReconciliationCategory.SETTLEMENT,
              group: SettlementIntegrityGroup.SYNC,
              code: ReconciliationCode.SETTLEMENT_DUPLICATE_RELEASE,
              entityId: s.id,
              entityType: "Settlement",
              message: `Settlement ${s.id.slice(0, 8)} has ${txInfo.count} SETTLEMENT_RELEASE transactions`,
              metadata: { duplicateCount: txInfo.count, settlementId: s.id },
              action: { type: "settlement", id: s.id },
            }),
          )
        }
      }
    }
  }

  // Orphan release transactions (tx exists but settlement not RELEASED)
  const nonReleasedTxSettlements = await prisma.transaction.groupBy({
    by: ["settlementId"],
    where: {
      settlementId: {
        in: allSettlements
          .filter((s: any) => s.status !== "RELEASED")
          .map((s: any) => s.id),
      },
      type: "SETTLEMENT_RELEASE" as any,
    },
    _count: true,
  })
  for (const t of nonReleasedTxSettlements) {
    if (!t.settlementId) continue
    drift.push(
      makeRow({
        severity: "critical",
        category: ReconciliationCategory.SETTLEMENT,
        group: SettlementIntegrityGroup.SYNC,
        code: ReconciliationCode.SETTLEMENT_TX_NOT_RELEASED,
        entityId: t.settlementId,
        entityType: "Settlement",
        message: `Settlement ${t.settlementId.slice(0, 8)} has SETTLEMENT_RELEASE transaction but status is not RELEASED`,
        metadata: { settlementId: t.settlementId },
        action: { type: "settlement", id: t.settlementId },
      }),
    )
  }

  // RELEASED settlement but publisher balance not credited
  if (releaseSettlements.length > 0) {
    const releaseTxSums = await prisma.transaction.groupBy({
      by: ["publisherId"],
      where: {
        settlementId: { in: settlementIds },
        type: "SETTLEMENT_RELEASE" as any,
      },
      _sum: { amount: true },
    })
    const releasedByPublisher = new Map<string, bigint>()
    for (const settlement of releaseSettlements) {
      releasedByPublisher.set(
        settlement.publisherId,
        (releasedByPublisher.get(settlement.publisherId) ?? 0n) +
          toScaled(settlement.publisherAmount),
      )
    }
    const creditedByPublisher = new Map<string, bigint>()
    for (const t of releaseTxSums) {
      if (t.publisherId) {
        const existing = creditedByPublisher.get(t.publisherId) ?? 0n
        creditedByPublisher.set(
          t.publisherId,
          existing + toScaled((t._sum as any).amount ?? 0),
        )
      }
    }
    for (const [pubId, expected] of releasedByPublisher) {
      const credited = creditedByPublisher.get(pubId) ?? 0n
      if (credited < expected) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.SETTLEMENT,
            group: SettlementIntegrityGroup.SYNC,
            code: ReconciliationCode.SETTLEMENT_RELEASED_BALANCE_NOT_CREDITED,
            entityId: pubId,
            entityType: "Publisher",
            amount: fromScaled(expected - credited),
            message: `Publisher ${pubId.slice(0, 8)} has RELEASED settlements totaling ${fromScaled(expected)} but only ${fromScaled(credited)} credited via SETTLEMENT_RELEASE transactions`,
            metadata: {
              expectedAmount: fromScaled(expected),
              actualAmount: fromScaled(credited),
              publisherId: pubId,
            },
            action: { type: "publisher", id: pubId },
          }),
        )
      }
    }
  }

  // ── 3c. Completeness ─────────────────────────────────────────────────────

  // Completed publisher orders require exactly one active, released settlement
  // plus its exact release ledger and relational release event.
  // Platform-handled orders intentionally have no publisher settlement and
  // instead require one unreversed PlatformRevenue record.
  const completedOrders = await prisma.order.findMany({
    where: { status: "COMPLETED" },
    select: {
      id: true,
      status: true,
      amount: true,
      fulfillmentChannel: true,
      website: { select: { ownershipType: true } },
      settlements: {
        where: { status: { not: "CANCELLED" } },
        select: {
          id: true,
          orderId: true,
          publisherId: true,
          publisherAmount: true,
          currency: true,
          status: true,
          settledAt: true,
          transactions: {
            where: { type: "SETTLEMENT_RELEASE" },
            select: {
              type: true,
              settlementId: true,
              orderId: true,
              publisherId: true,
              amount: true,
              currency: true,
              walletId: true,
              provider: true,
              providerRef: true,
            },
          },
          events: {
            where: { eventType: "SETTLEMENT_RELEASED" },
            select: {
              eventType: true,
              settlementId: true,
              orderId: true,
            },
          },
        },
      },
      platformRevenue: {
        select: {
          id: true,
          amount: true,
          platformFee: true,
          netRevenue: true,
          reversedAt: true,
        },
      },
    },
  })
  for (const o of completedOrders) {
    const platformOrder =
      o.fulfillmentChannel === "PLATFORM" ||
      (o.fulfillmentChannel == null && o.website?.ownershipType === "PLATFORM")
    if (platformOrder) {
      if (o.settlements.length > 0) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.SETTLEMENT,
            group: SettlementIntegrityGroup.COMPLETENESS,
            code: ReconciliationCode.PLATFORM_REVENUE_UNEXPECTED_SETTLEMENT,
            entityId: o.id,
            entityType: "Order",
            message: `Platform order ${o.id.slice(0, 8)} has an unexpected publisher settlement`,
            metadata: {
              duplicateCount: o.settlements.length,
              orderId: o.id,
            },
            action: { type: "order", id: o.id },
          }),
        )
      }
      if (!o.platformRevenue) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.SETTLEMENT,
            group: SettlementIntegrityGroup.COMPLETENESS,
            code: ReconciliationCode.PLATFORM_REVENUE_MISSING,
            entityId: o.id,
            entityType: "Order",
            message: `Platform order ${o.id.slice(0, 8)} is ${o.status} but has no revenue record`,
            metadata: { orderId: o.id },
            action: { type: "order", id: o.id },
          }),
        )
      } else if (o.platformRevenue.reversedAt) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.SETTLEMENT,
            group: SettlementIntegrityGroup.COMPLETENESS,
            code: ReconciliationCode.PLATFORM_REVENUE_REVERSED_FINAL_ORDER,
            entityId: o.id,
            entityType: "Order",
            message: `Platform order ${o.id.slice(0, 8)} is final but its revenue is reversed`,
            metadata: { orderId: o.id },
            action: { type: "order", id: o.id },
          }),
        )
      } else {
        const expectedGross = toScaled(o.amount)
        const actualGross = toScaled(o.platformRevenue.amount)
        const splitGross =
          toScaled(o.platformRevenue.platformFee) +
          toScaled(o.platformRevenue.netRevenue)
        if (expectedGross !== actualGross || actualGross !== splitGross) {
          const orderGrossDelta =
            expectedGross >= actualGross
              ? expectedGross - actualGross
              : actualGross - expectedGross
          const splitDelta =
            actualGross >= splitGross
              ? actualGross - splitGross
              : splitGross - actualGross
          drift.push(
            makeRow({
              severity: "critical",
              category: ReconciliationCategory.SETTLEMENT,
              group: SettlementIntegrityGroup.AMOUNT,
              code: ReconciliationCode.PLATFORM_REVENUE_AMOUNT_MISMATCH,
              entityId: o.id,
              entityType: "Order",
              amount: fromScaled(
                orderGrossDelta >= splitDelta ? orderGrossDelta : splitDelta,
              ),
              message: `Platform revenue for order ${o.id.slice(0, 8)} does not reconcile to the order gross and revenue split`,
              metadata: {
                expectedAmount: fromScaled(expectedGross),
                actualAmount: fromScaled(actualGross),
                orderId: o.id,
              },
              action: { type: "order", id: o.id },
            }),
          )
        }
      }
    } else if (o.settlements.length === 0) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.SETTLEMENT,
          group: SettlementIntegrityGroup.COMPLETENESS,
          code: ReconciliationCode.SETTLEMENT_ORDER_COMPLETED_NONE,
          entityId: o.id,
          entityType: "Order",
          message: `Order ${o.id.slice(0, 8)} is ${o.status} but has no settlements`,
          metadata: { orderId: o.id },
          action: { type: "order", id: o.id },
        }),
      )
    } else if (o.settlements.length > 1) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.SETTLEMENT,
          group: SettlementIntegrityGroup.COMPLETENESS,
          code: ReconciliationCode.SETTLEMENT_ORDER_COMPLETED_MULTI,
          entityId: o.id,
          entityType: "Order",
          message: `Order ${o.id.slice(0, 8)} is ${o.status} but has ${o.settlements.length} settlements`,
          metadata: { duplicateCount: o.settlements.length, orderId: o.id },
          action: { type: "order", id: o.id },
        }),
      )
    } else {
      const settlement = o.settlements[0]
      const releaseEvidence = evaluateSettlementReleaseEvidence({
        settlement,
        transactions: settlement.transactions ?? [],
        events: settlement.events ?? [],
      })
      if (!releaseEvidence.stateValid) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.SETTLEMENT,
            group: SettlementIntegrityGroup.COMPLETENESS,
            code: ReconciliationCode.SETTLEMENT_ORDER_COMPLETED_NOT_RELEASED,
            entityId: o.id,
            entityType: "Order",
            message: `Completed publisher order ${o.id.slice(0, 8)} does not have a released settlement with a release timestamp`,
            metadata: {
              orderId: o.id,
              settlementId: settlement.id,
              expectedStatus: "RELEASED",
              actualStatus: settlement.status,
            },
            action: { type: "order", id: o.id },
          }),
        )
      }
      if (!releaseEvidence.ledgerValid) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.SETTLEMENT,
            group: SettlementIntegrityGroup.SYNC,
            code: ReconciliationCode.SETTLEMENT_ORDER_COMPLETED_RELEASE_LEDGER_INVALID,
            entityId: o.id,
            entityType: "Order",
            message: `Completed publisher order ${o.id.slice(0, 8)} lacks one exact settlement release ledger row`,
            metadata: { orderId: o.id, settlementId: settlement.id },
            action: { type: "order", id: o.id },
          }),
        )
      }
      if (!releaseEvidence.eventValid) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.SETTLEMENT,
            group: SettlementIntegrityGroup.COMPLETENESS,
            code: ReconciliationCode.SETTLEMENT_ORDER_COMPLETED_RELEASE_EVENT_INVALID,
            entityId: o.id,
            entityType: "Order",
            message: `Completed publisher order ${o.id.slice(0, 8)} lacks one exact settlement release event`,
            metadata: { orderId: o.id, settlementId: settlement.id },
            action: { type: "order", id: o.id },
          }),
        )
      }
    }
  }

  // Orphan settlement (referenced order doesn't exist)
  for (const s of allSettlements) {
    if (!s.orderId) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.SETTLEMENT,
          group: SettlementIntegrityGroup.COMPLETENESS,
          code: ReconciliationCode.SETTLEMENT_MISSING_ORDER,
          entityId: s.id,
          entityType: "Settlement",
          message: `Settlement ${s.id.slice(0, 8)} has no orderId`,
          metadata: { settlementId: s.id },
          action: { type: "settlement", id: s.id },
        }),
      )
    }
    if (!s.publisherId) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.SETTLEMENT,
          group: SettlementIntegrityGroup.COMPLETENESS,
          code: ReconciliationCode.SETTLEMENT_MISSING_PUBLISHER,
          entityId: s.id,
          entityType: "Settlement",
          message: `Settlement ${s.id.slice(0, 8)} has no publisherId`,
          metadata: { settlementId: s.id },
          action: { type: "settlement", id: s.id },
        }),
      )
    }
  }

  return drift
}

// ─── 4. Order Payment Reconciliation ──────────────────────────────────────

async function checkOrderPaymentReconciliation(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
  const drift: DriftRow[] = []

  const [purchaseTxs, paidOrders, cancelledReservationOrders] =
    await Promise.all([
      prisma.transaction.findMany({
        where: { type: "PURCHASE" as any },
        select: {
          id: true,
          amount: true,
          walletId: true,
          orderId: true,
        },
      }),
      prisma.order.findMany({
        where: { paymentStatus: "PAID" },
        select: { id: true, amount: true },
      }),
      prisma.order.findMany({
        where: {
          status: "CANCELLED",
          paymentStatus: "PENDING",
          transactions: {
            some: { type: { in: ["RESERVATION", "RELEASE"] as any } },
          },
        },
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          amount: true,
          currency: true,
          organizationId: true,
          transactions: {
            where: {
              type: { in: ["RESERVATION", "PURCHASE", "RELEASE"] as any },
            },
            select: {
              id: true,
              type: true,
              amount: true,
              currency: true,
              reference: true,
              walletId: true,
              publisherId: true,
              settlementId: true,
              provider: true,
              providerRef: true,
              wallet: { select: { organizationId: true } },
            },
          },
          events: {
            where: { eventType: "ORDER_CANCELLED" },
            select: { metadata: true },
          },
        },
      }),
    ])
  stats.checkedTransactions += purchaseTxs.length
  stats.checkedOrders += paidOrders.length + cancelledReservationOrders.length
  stats.checkedTransactions += cancelledReservationOrders.reduce(
    (count: number, order: any) => count + (order.transactions?.length ?? 0),
    0,
  )

  const paidOrderIds = new Set(paidOrders.map((o: any) => o.id))

  // Group PURCHASE txs by orderId
  const txsByOrder = new Map<
    string,
    { count: number; sum: bigint; txs: any[] }
  >()
  const orphanTxs: any[] = []

  for (const tx of purchaseTxs) {
    if (!tx.orderId) {
      orphanTxs.push(tx)
      continue
    }
    if (!tx.walletId) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_MISSING_WALLET,
          entityId: tx.id,
          entityType: "Transaction",
          amount: String(tx.amount ?? 0),
          message: `PURCHASE transaction ${tx.id.slice(0, 8)} has no walletId`,
          metadata: { transactionId: tx.id },
        }),
      )
    }
    const entry = txsByOrder.get(tx.orderId) ?? { count: 0, sum: 0n, txs: [] }
    entry.count++
    entry.sum += toScaled(tx.amount)
    entry.txs.push(tx)
    txsByOrder.set(tx.orderId, entry)
  }

  // Unmatched payments
  for (const tx of orphanTxs) {
    drift.push(
      makeRow({
        severity: "critical",
        category: ReconciliationCategory.PAYMENT,
        code: ReconciliationCode.PAYMENT_UNMATCHED,
        entityId: tx.id,
        entityType: "Transaction",
        amount: String(tx.amount ?? 0),
        message: `PURCHASE transaction ${tx.id.slice(0, 8)} has no orderId`,
        metadata: { transactionId: tx.id },
      }),
    )
  }

  // Orders marked PAID but no PURCHASE transaction
  for (const o of paidOrders) {
    if (!txsByOrder.has(o.id)) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_ORDER_PAID_NO_TX,
          entityId: o.id,
          entityType: "Order",
          message: `Order ${o.id.slice(0, 8)} is PAID but has no PURCHASE transaction`,
          metadata: { orderId: o.id },
          action: { type: "order", id: o.id },
        }),
      )
    }
  }

  // Duplicate payments and amount mismatches
  for (const [orderId, entry] of txsByOrder) {
    if (entry.count > 1) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DUPLICATE,
          entityId: orderId,
          entityType: "Order",
          amount: fromScaled(entry.sum),
          message: `Order ${orderId.slice(0, 8)} has ${entry.count} PURCHASE transactions`,
          metadata: { duplicateCount: entry.count, orderId },
          action: { type: "order", id: orderId },
        }),
      )
    }
    if (paidOrderIds.has(orderId)) {
      const order = paidOrders.find((o: any) => o.id === orderId)
      if (order) {
        const orderAmount = toScaled(order.amount ?? 0)
        // PURCHASE transactions are stored as negative amounts (debits).
        const txnSum = entry.sum < 0n ? -entry.sum : entry.sum
        if (txnSum !== orderAmount) {
          drift.push(
            makeRow({
              severity: "critical",
              category: ReconciliationCategory.PAYMENT,
              code: ReconciliationCode.PAYMENT_AMOUNT_MISMATCH,
              entityId: orderId,
              entityType: "Order",
              amount: fromScaled(txnSum - orderAmount),
              message: `Order ${orderId.slice(0, 8)} amount (${fromScaled(orderAmount)}) ≠ sum of PURCHASE transactions (${fromScaled(txnSum)})`,
              metadata: {
                expectedAmount: fromScaled(orderAmount),
                actualAmount: fromScaled(txnSum),
                orderId,
              },
              action: { type: "order", id: orderId },
            }),
          )
        }
      }
    }
  }

  for (const order of cancelledReservationOrders) {
    // Defensive for mocked/legacy clients: the database query above is the
    // authoritative scope, but never manufacture a finding from a row that
    // does not actually carry the requested terminal state.
    if (order.status !== "CANCELLED" || order.paymentStatus !== "PENDING") {
      continue
    }
    const transactions = order.transactions ?? []
    const reservations = transactions.filter(
      (entry: any) => entry.type === "RESERVATION",
    )
    const purchases = transactions.filter(
      (entry: any) => entry.type === "PURCHASE",
    )
    const releases = transactions.filter(
      (entry: any) => entry.type === "RELEASE",
    )
    const expected = toScaled(order.amount ?? 0)
    const reservation = reservations[0]
    const release = releases[0]
    const commonIdentityValid = (entry: any) =>
      entry?.walletId &&
      entry.currency === "USD" &&
      entry.wallet?.organizationId === order.organizationId &&
      entry.publisherId == null &&
      entry.settlementId == null &&
      entry.provider == null &&
      entry.providerRef == null
    const reservationValid =
      reservations.length === 1 &&
      purchases.length === 0 &&
      commonIdentityValid(reservation) &&
      toScaled(reservation.amount) === -expected
    const releaseMissing = releases.length === 0
    const releaseValid =
      releases.length === 1 &&
      commonIdentityValid(release) &&
      release.walletId === reservation?.walletId &&
      release.reference === `reservation-release:${order.id}` &&
      toScaled(release.amount) === expected
    const matchingEvents = (order.events ?? []).filter(
      (event: any) =>
        event.metadata?.reservationReleaseTransactionId === release?.id,
    )

    if (reservationValid && releaseMissing) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_RESERVATION_RELEASE_MISSING,
          entityId: order.id,
          entityType: "Order",
          amount: fromScaled(expected),
          message: `Cancelled order ${order.id.slice(0, 8)} has a reservation but no release ledger row`,
          metadata: {
            orderId: order.id,
            transactionId: reservation.id,
            walletId: reservation.walletId,
          },
          action: { type: "order", id: order.id },
        }),
      )
    } else if (
      !reservationValid ||
      !releaseValid ||
      matchingEvents.length !== 1
    ) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_RESERVATION_RELEASE_INVALID,
          entityId: order.id,
          entityType: "Order",
          amount: fromScaled(expected),
          message: `Cancelled order ${order.id.slice(0, 8)} has invalid reservation-release evidence`,
          metadata: {
            orderId: order.id,
            transactionId: release?.id ?? reservation?.id,
            walletId: release?.walletId ?? reservation?.walletId,
            duplicateCount: releases.length,
          },
          action: { type: "order", id: order.id },
        }),
      )
    }
  }

  return drift
}

// ─── 5. Refund Reconciliation ─────────────────────────────────────────────

async function checkRefundReconciliation(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
  const drift: DriftRow[] = []

  const [refundedOrders, refundTxs] = await Promise.all([
    prisma.order.findMany({
      where: { status: "REFUNDED" },
      select: {
        id: true,
        amount: true,
        fulfillmentChannel: true,
        website: { select: { ownershipType: true, publisherId: true } },
        dispute: { select: { previousStatus: true } },
        settlements: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            publisherId: true,
            publisherAmount: true,
            status: true,
          },
        },
        publisherCompensation: {
          select: {
            id: true,
            publisherId: true,
            refundTransactionId: true,
            compensationTransactionId: true,
            debtRepaymentTransactionId: true,
            disposition: true,
            amount: true,
            currency: true,
            responsibility: true,
            reason: true,
            effectiveOrderStatus: true,
            compensationTransaction: {
              select: {
                id: true,
                type: true,
                orderId: true,
                publisherId: true,
                amount: true,
                currency: true,
              },
            },
            debtRepaymentTransaction: {
              select: {
                id: true,
                type: true,
                orderId: true,
                publisherId: true,
                amount: true,
                currency: true,
              },
            },
          },
        },
      },
    }),
    prisma.transaction.findMany({
      where: { type: "REFUND" as any },
      select: { id: true, amount: true, orderId: true },
    }),
  ])
  stats.checkedOrders += refundedOrders.length
  stats.checkedTransactions += refundTxs.length

  const refundedOrderIds = new Set(refundedOrders.map((o: any) => o.id))
  const refundTxsByOrder = new Map<
    string,
    { count: number; sum: bigint; ids: Set<string> }
  >()
  const orphanRefundTxs: any[] = []

  for (const tx of refundTxs) {
    if (!tx.orderId) {
      orphanRefundTxs.push(tx)
      continue
    }
    const entry = refundTxsByOrder.get(tx.orderId) ?? {
      count: 0,
      sum: 0n,
      ids: new Set<string>(),
    }
    entry.count++
    entry.sum += toScaled(tx.amount)
    entry.ids.add(tx.id)
    refundTxsByOrder.set(tx.orderId, entry)
  }

  // Order REFUNDED but no REFUND transaction
  for (const o of refundedOrders) {
    if (!refundTxsByOrder.has(o.id)) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.REFUND,
          code: ReconciliationCode.REFUND_NO_TRANSACTION,
          entityId: o.id,
          entityType: "Order",
          message: `Order ${o.id.slice(0, 8)} is REFUNDED but has no REFUND transaction`,
          metadata: { orderId: o.id },
          action: { type: "order", id: o.id },
        }),
      )
    }
  }

  // A post-publication publisher refund must carry an explicit disposition,
  // including NONE. Validate the aggregate and every linked ledger fact so a
  // projection bug cannot silently over/understate publisher liability.
  for (const o of refundedOrders) {
    const effectiveStatus =
      o.dispute?.previousStatus ?? o.publisherCompensation?.effectiveOrderStatus
    const publisherOrder =
      o.fulfillmentChannel === "PUBLISHER" ||
      (o.fulfillmentChannel == null && o.website?.ownershipType === "PUBLISHER")
    const postPublication =
      publisherOrder &&
      (["PUBLISHED", "VERIFIED", "DELIVERED", "COMPLETED"].includes(
        String(effectiveStatus ?? ""),
      ) ||
        o.settlements.length > 0)
    if (!postPublication) continue

    const compensation = o.publisherCompensation
    const refundEntry = refundTxsByOrder.get(o.id)
    if (!compensation) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.REFUND,
          code: ReconciliationCode.REFUND_PUBLISHER_COMPENSATION_MISSING,
          entityId: o.id,
          entityType: "Order",
          message: `Post-publication publisher refund ${o.id.slice(0, 8)} has no explicit compensation disposition`,
          metadata: { orderId: o.id },
          action: { type: "order", id: o.id },
        }),
      )
      continue
    }

    const amount = toScaled(compensation.amount)
    const credit = compensation.compensationTransaction
    const debt = compensation.debtRepaymentTransaction
    const authoritativeSettlement = o.settlements[0]
    const publisherId =
      authoritativeSettlement?.publisherId ?? o.website?.publisherId
    const maximum = authoritativeSettlement
      ? toScaled(authoritativeSettlement.publisherAmount)
      : toScaled(o.amount)
    const validCredit =
      amount > 0n &&
      compensation.disposition === "EXACT_AMOUNT" &&
      credit?.id === compensation.compensationTransactionId &&
      credit.type === "PUBLISHER_COMPENSATION" &&
      credit.orderId === o.id &&
      credit.publisherId === compensation.publisherId &&
      credit.currency === compensation.currency &&
      toScaled(credit.amount) === amount
    const validDebt =
      (!compensation.debtRepaymentTransactionId && !debt) ||
      (debt?.id === compensation.debtRepaymentTransactionId &&
        debt.type === "DEBT_REPAYMENT" &&
        debt.orderId === o.id &&
        debt.publisherId === compensation.publisherId &&
        debt.currency === compensation.currency &&
        toScaled(debt.amount) < 0n &&
        -toScaled(debt.amount) <= amount)
    const validNone =
      amount === 0n &&
      compensation.disposition === "NONE" &&
      !compensation.compensationTransactionId &&
      !compensation.debtRepaymentTransactionId &&
      !credit &&
      !debt
    if (
      compensation.currency !== "USD" ||
      !refundEntry?.ids.has(compensation.refundTransactionId) ||
      refundEntry?.count !== 1 ||
      compensation.publisherId !== publisherId ||
      amount < 0n ||
      amount > maximum ||
      compensation.reason.trim().length < 20 ||
      compensation.responsibility === "UNDETERMINED" ||
      (compensation.responsibility === "PUBLISHER" && !validNone) ||
      (!validNone && !validCredit) ||
      !validDebt
    ) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.REFUND,
          code: ReconciliationCode.REFUND_PUBLISHER_COMPENSATION_INVALID,
          entityId: compensation.id,
          entityType: "PublisherCompensation",
          amount: fromScaled(amount),
          message: `Publisher compensation for refund ${o.id.slice(0, 8)} does not match its terminal order and ledger evidence`,
          metadata: {
            orderId: o.id,
            publisherCompensationId: compensation.id,
          },
          action: { type: "order", id: o.id },
        }),
      )
    }
  }

  // Orphan REFUND transaction (order not REFUNDED)
  for (const tx of orphanRefundTxs) {
    drift.push(
      makeRow({
        severity: "critical",
        category: ReconciliationCategory.REFUND,
        code: ReconciliationCode.REFUND_ORPHAN_TX,
        entityId: tx.id,
        entityType: "Transaction",
        amount: String(tx.amount ?? 0),
        message: `REFUND transaction ${tx.id.slice(0, 8)} has no orderId`,
        metadata: { transactionId: tx.id },
      }),
    )
  }
  for (const [orderId, _entry] of refundTxsByOrder) {
    if (!refundedOrderIds.has(orderId)) {
      const txSample = refundTxs.find((tx: any) => tx.orderId === orderId)
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.REFUND,
          code: ReconciliationCode.REFUND_ORPHAN_TX,
          entityId: orderId,
          entityType: "Order",
          message: `REFUND transaction exists for order ${orderId.slice(0, 8)} but order is not REFUNDED`,
          metadata: {
            transactionId: txSample?.id,
            orderId,
          },
          action: { type: "order", id: orderId },
        }),
      )
    }
  }

  // Duplicate refund and partial refund
  for (const [orderId, entry] of refundTxsByOrder) {
    if (entry.count > 1) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.REFUND,
          code: ReconciliationCode.REFUND_DUPLICATE,
          entityId: orderId,
          entityType: "Order",
          amount: fromScaled(entry.sum),
          message: `Order ${orderId.slice(0, 8)} has ${entry.count} REFUND transactions`,
          metadata: { duplicateCount: entry.count, orderId },
          action: { type: "order", id: orderId },
        }),
      )
    }
    const o = refundedOrders.find((o: any) => o.id === orderId)
    if (o && entry.sum !== toScaled(o.amount ?? 0)) {
      const isWarning = entry.sum < toScaled(o.amount ?? 0)
      drift.push(
        makeRow({
          severity: isWarning ? "warning" : "critical",
          category: ReconciliationCategory.REFUND,
          code: isWarning
            ? ReconciliationCode.REFUND_PARTIAL
            : ReconciliationCode.REFUND_PARTIAL,
          entityId: orderId,
          entityType: "Order",
          amount: fromScaled(toScaled(o.amount ?? 0) - entry.sum),
          message: `Order ${orderId.slice(0, 8)} refund sum (${fromScaled(entry.sum)}) ${isWarning ? "is less than" : "exceeds"} order amount (${fromScaled(toScaled(o.amount ?? 0))})`,
          metadata: {
            expectedAmount: fromScaled(toScaled(o.amount ?? 0)),
            actualAmount: fromScaled(entry.sum),
            orderId,
          },
          action: { type: "order", id: orderId },
        }),
      )
    }
  }

  // REFUNDED order with active RELEASED settlement
  for (const o of refundedOrders) {
    const releasedSettlements = o.settlements.filter(
      (settlement: any) => settlement.status === "RELEASED",
    )
    if (releasedSettlements.length > 0) {
      for (const s of releasedSettlements) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.REFUND,
            code: ReconciliationCode.REFUND_SETTLEMENT_NOT_REVERSED,
            entityId: s.id,
            entityType: "Settlement",
            message: `Order ${o.id.slice(0, 8)} is REFUNDED but settlement ${s.id.slice(0, 8)} is still RELEASED`,
            metadata: { settlementId: s.id, orderId: o.id },
            action: { type: "settlement", id: s.id },
          }),
        )
      }
    }
  }

  return drift
}

// ─── 6. Stuck Financial Orders ────────────────────────────────────────────

async function checkStuckFinancialOrders(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
  const drift: DriftRow[] = []

  // DELIVERED orders with no active settlement and no unreversed platform revenue
  const delivered = await prisma.order.findMany({
    where: { status: "DELIVERED" },
    select: {
      id: true,
      deliveredAt: true,
      settlements: {
        where: { status: { not: "CANCELLED" } },
        select: { id: true },
      },
      platformRevenue: { select: { id: true, reversedAt: true } },
    },
  })
  stats.checkedOrders += delivered.length

  for (const o of delivered) {
    const hasSettlement = o.settlements.length > 0
    const hasRevenue = o.platformRevenue && !o.platformRevenue.reversedAt
    if (!hasSettlement && !hasRevenue) {
      drift.push(
        makeRow({
          severity: "warning",
          category: ReconciliationCategory.ORDER,
          code: ReconciliationCode.ORDER_DELIVERED_NO_SETTLEMENT,
          entityId: o.id,
          entityType: "Order",
          message: `Order ${o.id.slice(0, 8)} is DELIVERED but has no active settlement or unreversed platform revenue`,
          metadata: { orderId: o.id },
          action: { type: "order", id: o.id },
        }),
      )
    }
  }

  // PAID for >N days with no settlement
  const staleDays = Math.max(
    Number(process.env.ORDER_SETTLEMENT_STALE_DAYS ?? 7),
    1,
  )
  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000)
  const paidNoSettlement = await prisma.order.findMany({
    where: {
      paymentStatus: "PAID",
      status: { notIn: ["COMPLETED", "CANCELLED", "REFUNDED"] },
      updatedAt: { lt: cutoff },
      settlements: { none: { status: { not: "CANCELLED" } } },
    },
    select: { id: true, amount: true, updatedAt: true },
  })
  stats.checkedOrders += paidNoSettlement.length

  for (const o of paidNoSettlement) {
    drift.push(
      makeRow({
        severity: "warning",
        category: ReconciliationCategory.ORDER,
        code: ReconciliationCode.ORDER_PAID_NO_SETTLEMENT,
        entityId: o.id,
        entityType: "Order",
        amount: String(o.amount ?? 0),
        message: `Order ${o.id.slice(0, 8)} is PAID for >${staleDays}d with no settlement created`,
        metadata: { orderId: o.id },
        action: { type: "order", id: o.id },
      }),
    )
  }

  // VERIFIED for >N days with no settlement
  const verifiedNoSettlement = await prisma.order.findMany({
    where: {
      status: "VERIFIED",
      updatedAt: { lt: cutoff },
      settlements: { none: { status: { not: "CANCELLED" } } },
    },
    select: { id: true, amount: true, verifiedAt: true },
  })
  stats.checkedOrders += verifiedNoSettlement.length

  for (const o of verifiedNoSettlement) {
    drift.push(
      makeRow({
        severity: "warning",
        category: ReconciliationCategory.ORDER,
        code: ReconciliationCode.ORDER_VERIFIED_NO_SETTLEMENT,
        entityId: o.id,
        entityType: "Order",
        amount: String(o.amount ?? 0),
        message: `Order ${o.id.slice(0, 8)} is VERIFIED for >${staleDays}d with no settlement created`,
        metadata: { orderId: o.id },
        action: { type: "order", id: o.id },
      }),
    )
  }

  return drift
}

// ─── 7. Stuck Payouts ─────────────────────────────────────────────────────

async function checkStuckPayouts(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
  const drift: DriftRow[] = []
  const claimLeaseExpiredAt = new Date(Date.now() - 15 * 60 * 1000)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  const claimedStages = [
    "PROVIDER_SEND_CLAIMED",
    "BANK_PAYOUT_SEND_CLAIMED",
    "BANK_PAYOUT_RESUME_CLAIMED",
  ]
  const expiredClaimStages = [
    "PROVIDER_SEND_CLAIM_EXPIRED",
    "BANK_PAYOUT_CLAIM_EXPIRED",
  ]

  // Stale PROCESSING withdrawals (>1h with no recent execution)
  const staleProcessing = await prisma.withdrawal.findMany({
    where: { status: "PROCESSING", updatedAt: { lt: oneHourAgo } },
    select: { id: true, publisherId: true, amount: true, updatedAt: true },
  })
  stats.checkedOrders += staleProcessing.length

  if (staleProcessing.length > 0) {
    const recentExecGroups = await prisma.payoutExecution.groupBy({
      by: ["withdrawalId"],
      where: {
        withdrawalId: { in: staleProcessing.map((w: any) => w.id) },
        createdAt: { gt: oneHourAgo },
      },
      _count: true,
    })
    const hasRecentExecution = new Set(
      recentExecGroups.map((g: any) => g.withdrawalId),
    )
    for (const w of staleProcessing) {
      if (!hasRecentExecution.has(w.id)) {
        drift.push(
          makeRow({
            severity: "warning",
            category: ReconciliationCategory.PAYOUT,
            code: ReconciliationCode.PAYOUT_STALE_PROCESSING,
            entityId: w.id,
            entityType: "Withdrawal",
            amount: String(w.amount),
            message: `Withdrawal ${w.id.slice(0, 8)} PROCESSING for >1h with no recent payout execution`,
            metadata: { publisherId: w.publisherId },
            action: { type: "payout", id: w.id },
          }),
        )
      }
    }
  }

  // Stale PROCESSING executions (>2h)
  const staleExecutions = await prisma.payoutExecution.findMany({
    where: {
      status: "PROCESSING",
      updatedAt: { lt: twoHoursAgo },
      stage: { notIn: [...claimedStages, ...expiredClaimStages] },
    },
    select: {
      id: true,
      withdrawalId: true,
      providerExecutionId: true,
      updatedAt: true,
    },
  })
  for (const e of staleExecutions) {
    drift.push(
      makeRow({
        severity: "warning",
        category: ReconciliationCategory.PAYOUT,
        code: ReconciliationCode.PAYOUT_STALE_EXECUTION,
        entityId: e.id,
        entityType: "PayoutExecution",
        message: `Payout execution ${e.id.slice(0, 8)} PROCESSING for >2h — manual intervention required`,
        metadata: { transactionId: e.providerExecutionId ?? undefined },
        action: { type: "payout", id: e.withdrawalId },
      }),
    )
  }

  const claimRecoveryExecutions = await prisma.payoutExecution.findMany({
    where: {
      OR: [
        {
          status: "PROCESSING",
          stage: { in: claimedStages },
          updatedAt: { lt: claimLeaseExpiredAt },
        },
        { stage: { in: expiredClaimStages } },
      ],
    },
    select: {
      id: true,
      withdrawalId: true,
      stage: true,
      updatedAt: true,
      providerExecutionId: true,
      providerPayoutId: true,
    },
  })
  for (const execution of claimRecoveryExecutions) {
    const expired = expiredClaimStages.includes(execution.stage)
    drift.push(
      makeRow({
        severity: expired ? "critical" : "warning",
        category: ReconciliationCategory.PAYOUT,
        code: expired
          ? ReconciliationCode.PAYOUT_CLAIM_EXPIRED
          : ReconciliationCode.PAYOUT_CLAIM_STALE,
        entityId: execution.id,
        entityType: "PayoutExecution",
        message: expired
          ? `Payout claim ${execution.id.slice(0, 8)} exceeded the safe idempotent replay window and requires provider lookup`
          : `Payout claim ${execution.id.slice(0, 8)} outlived its send lease and is eligible only for exact-key recovery`,
        metadata: {
          payoutExecutionId: execution.id,
          actualStatus: execution.stage,
          transactionId:
            execution.providerPayoutId ??
            execution.providerExecutionId ??
            undefined,
        },
        action: { type: "payout", id: execution.withdrawalId },
      }),
    )
  }

  const completedEvidence = await prisma.payoutExecution.findMany({
    where: { status: "COMPLETED" },
    select: {
      id: true,
      providerExecutionId: true,
      providerPayoutId: true,
      completionSource: true,
      completionEvidenceRef: true,
      completionEvidenceAt: true,
      completedAt: true,
      completionActorUserId: true,
      completionWebhookEventId: true,
      bankTraceReference: true,
      provider: { select: { name: true } },
      withdrawal: {
        select: {
          id: true,
          status: true,
          publisherId: true,
          amount: true,
        },
      },
    },
  })
  for (const execution of completedEvidence) {
    if (execution.withdrawal.status !== "COMPLETED") {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.PAYOUT_STATUS_MISMATCH,
          entityId: execution.id,
          entityType: "PayoutExecution",
          amount: String(execution.withdrawal.amount),
          message: `Completed payout execution ${execution.id.slice(0, 8)} has ${execution.withdrawal.status} withdrawal`,
          metadata: {
            payoutExecutionId: execution.id,
            publisherId: execution.withdrawal.publisherId,
            expectedStatus: "COMPLETED",
            actualStatus: execution.withdrawal.status,
          },
          action: { type: "payout", id: execution.withdrawal.id },
        }),
      )
    }
    const source = execution.completionSource
    const evidenceAt = execution.completionEvidenceAt
    const completedAt = execution.completedAt
    const automated = ["PROVIDER_RESPONSE", "PROVIDER_STATUS_POLL"].includes(
      source,
    )
    const valid =
      Boolean(source && completedAt) &&
      (source === "LEGACY_UNVERIFIED"
        ? !execution.completionActorUserId &&
          !execution.completionWebhookEventId
        : Boolean(
            execution.completionEvidenceRef &&
              evidenceAt &&
              evidenceAt.getTime() <= completedAt.getTime(),
          )) &&
      (source === "MANUAL_BANK_CONFIRMATION"
        ? Boolean(
            execution.completionActorUserId &&
              !execution.completionWebhookEventId &&
              execution.bankTraceReference === execution.completionEvidenceRef,
          )
        : source === "PROVIDER_WEBHOOK"
          ? Boolean(
              !execution.completionActorUserId &&
                execution.completionWebhookEventId,
            )
          : automated
            ? Boolean(
                !execution.completionActorUserId &&
                  !execution.completionWebhookEventId,
              )
            : source === "LEGACY_UNVERIFIED") &&
      (execution.provider.name !== "stripe_connect" ||
        source === "LEGACY_UNVERIFIED" ||
        execution.completionEvidenceRef?.startsWith("po_"))
    if (!valid) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.PAYOUT_COMPLETION_EVIDENCE_INVALID,
          entityId: execution.id,
          entityType: "PayoutExecution",
          message: `Completed payout execution ${execution.id.slice(0, 8)} has invalid or missing completion provenance`,
          metadata: {
            payoutExecutionId: execution.id,
            completionSource: source ?? undefined,
            publisherId: execution.withdrawal.publisherId,
          },
          action: { type: "payout", id: execution.withdrawal.id },
        }),
      )
    }
    if (source === "LEGACY_UNVERIFIED") {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.PAYOUT_LEGACY_COMPLETION_UNVERIFIED,
          entityId: execution.id,
          entityType: "PayoutExecution",
          amount: String(execution.withdrawal.amount),
          message: `Completed payout execution ${execution.id.slice(0, 8)} has legacy-unverified settlement evidence and requires Finance substantiation`,
          metadata: {
            payoutExecutionId: execution.id,
            completionSource: source,
            publisherId: execution.withdrawal.publisherId,
            transactionId:
              execution.completionEvidenceRef ??
              execution.providerPayoutId ??
              execution.providerExecutionId ??
              undefined,
          },
          action: { type: "payout", id: execution.withdrawal.id },
        }),
      )
    }
  }

  const missingRequester = await prisma.withdrawal.findMany({
    where: {
      status: { in: ["PENDING", "APPROVED"] },
      requestedBy: null,
    },
    select: { id: true, publisherId: true, amount: true, status: true },
  })
  for (const withdrawal of missingRequester) {
    drift.push(
      makeRow({
        severity: "critical",
        category: ReconciliationCategory.PAYOUT,
        code: ReconciliationCode.PAYOUT_REQUESTER_PROVENANCE_MISSING,
        entityId: withdrawal.id,
        entityType: "Withdrawal",
        amount: String(withdrawal.amount),
        message: `Withdrawal ${withdrawal.id.slice(0, 8)} is ${withdrawal.status} without requester provenance and is blocked`,
        metadata: { publisherId: withdrawal.publisherId },
        action: { type: "payout", id: withdrawal.id },
      }),
    )
  }

  if (prisma.payoutWebhookEvent?.findMany) {
    const quarantinedEvents = await prisma.payoutWebhookEvent.findMany({
      where: { status: "QUARANTINED" },
      select: { id: true, provider: true, providerExecutionId: true },
    })
    for (const event of quarantinedEvents) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.PAYOUT_WEBHOOK_QUARANTINED,
          entityId: event.id,
          entityType: "PayoutWebhookEvent",
          message: `Payout webhook ${event.id.slice(0, 8)} is quarantined after contradictory terminal evidence`,
          metadata: {
            payoutWebhookEventId: event.id,
            transactionId: event.providerExecutionId ?? undefined,
          },
        }),
      )
    }
  }

  // One grouped pass: FAILED-orphan / COMPLETED-orphan / duplicate-COMPLETED
  const execGroups = await prisma.payoutExecution.groupBy({
    by: ["withdrawalId", "status"],
    where: { status: { in: ["FAILED", "COMPLETED"] } },
    _count: { _all: true },
  })
  const hasFailedExec = new Set<string>()
  const hasCompletedExec = new Set<string>()
  const duplicateCompleted = new Map<string, number>()
  for (const g of execGroups) {
    if (g.status === "FAILED") hasFailedExec.add(g.withdrawalId)
    if (g.status === "COMPLETED") {
      hasCompletedExec.add(g.withdrawalId)
      if (g._count._all > 1)
        duplicateCompleted.set(g.withdrawalId, g._count._all)
    }
  }

  const failedWithdrawals = await prisma.withdrawal.findMany({
    where: { status: "FAILED" },
    select: { id: true, publisherId: true, amount: true },
  })
  for (const w of failedWithdrawals) {
    if (!hasFailedExec.has(w.id)) {
      drift.push(
        makeRow({
          severity: "warning",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.PAYOUT_FAILED_ORPHAN,
          entityId: w.id,
          entityType: "Withdrawal",
          amount: String(w.amount),
          message: `Withdrawal ${w.id.slice(0, 8)} is FAILED but has no FAILED PayoutExecution record`,
          metadata: { publisherId: w.publisherId },
          action: { type: "payout", id: w.id },
        }),
      )
    }
  }

  if (duplicateCompleted.size > 0) {
    const dupWithdrawals = await prisma.withdrawal.findMany({
      where: { id: { in: [...duplicateCompleted.keys()] } },
      select: { id: true, publisherId: true, amount: true },
    })
    const byId = new Map(dupWithdrawals.map((w: any) => [w.id, w]))
    for (const [withdrawalId, count] of duplicateCompleted) {
      const withdrawal: any = byId.get(withdrawalId)
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.PAYOUT_DUPLICATE_COMPLETED,
          entityId: withdrawalId,
          entityType: "Withdrawal",
          amount: withdrawal ? String(withdrawal.amount) : undefined,
          message: `Found ${count} COMPLETED executions for single withdrawal — potential double payout`,
          metadata: {
            duplicateCount: count,
            publisherId: withdrawal?.publisherId,
          },
          action: withdrawal ? { type: "payout", id: withdrawalId } : undefined,
        }),
      )
    }
  }

  // lifetimePaid drift vs COMPLETED withdrawal sums
  const [paidBalances, completedSums] = await Promise.all([
    prisma.publisherBalance.findMany({
      select: { publisherId: true, lifetimePaid: true },
    }),
    prisma.withdrawal.groupBy({
      by: ["publisherId"],
      where: { status: "COMPLETED" },
      _sum: { amount: true },
    }),
  ])
  const completedByPublisher = new Map<string, bigint>(
    completedSums.map((s: any) => [
      s.publisherId as string,
      toScaled(s._sum.amount ?? 0),
    ]),
  )
  const balanceByPublisher = new Map<string, any>(
    paidBalances.map((balance: any) => [
      balance.publisherId as string,
      balance,
    ]),
  )
  const payoutPublishers = new Set<string>([
    ...balanceByPublisher.keys(),
    ...completedByPublisher.keys(),
  ])
  for (const publisherId of payoutPublishers) {
    const balance: any = balanceByPublisher.get(publisherId)
    const expected = completedByPublisher.get(publisherId) ?? 0n
    const actual = balance ? toScaled(balance.lifetimePaid) : 0n
    if (actual !== expected) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.PAYOUT_LIFETIME_DRIFT,
          entityId: publisherId,
          entityType: "PublisherBalance",
          amount: fromScaled(actual - expected),
          message: `Publisher ${publisherId.slice(0, 8)} lifetimePaid (${fromScaled(actual)}) ≠ sum of COMPLETED withdrawals (${fromScaled(expected)})`,
          metadata: {
            expectedAmount: fromScaled(expected),
            actualAmount: fromScaled(actual),
            publisherId,
          },
          action: { type: "publisher", id: publisherId },
        }),
      )
    }
  }

  // COMPLETED withdrawal with no COMPLETED execution
  const completedWithdrawals = await prisma.withdrawal.findMany({
    where: { status: "COMPLETED" },
    select: { id: true, publisherId: true, amount: true },
  })
  for (const w of completedWithdrawals) {
    if (!hasCompletedExec.has(w.id)) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.PAYOUT_COMPLETED_NO_EXECUTION,
          entityId: w.id,
          entityType: "Withdrawal",
          amount: String(w.amount),
          message: `Withdrawal ${w.id.slice(0, 8)} is COMPLETED but has no COMPLETED PayoutExecution record`,
          metadata: { publisherId: w.publisherId },
          action: { type: "payout", id: w.id },
        }),
      )
    }
  }

  return drift
}

// ─── Orchestrator ─────────────────────────────────────────────────────────

export async function runReconciliation(
  prisma: AnyPrisma,
): Promise<ReconciliationReport> {
  const startedAt = Date.now()
  const stats: DriftStats = {
    checkedWallets: 0,
    checkedSettlements: 0,
    checkedOrders: 0,
    checkedTransactions: 0,
    checkedPublishers: 0,
  }

  const [
    walletDrift,
    publisherDrift,
    settlementDrift,
    orderPaymentRecon,
    refundRecon,
    stuckFinancialOrders,
    stuckPayouts,
    providerNeutralDeposits,
    depositProviderEvents,
    paymentDisputes,
    legacyWalletWithdrawals,
    withdrawalTraceability,
  ] = await Promise.all([
    checkWallets(prisma, stats),
    checkPublisherBalances(prisma, stats),
    checkSettlementDrift(prisma, stats),
    checkOrderPaymentReconciliation(prisma, stats),
    checkRefundReconciliation(prisma, stats),
    checkStuckFinancialOrders(prisma, stats),
    checkStuckPayouts(prisma, stats),
    checkProviderNeutralDeposits(prisma),
    checkDepositProviderEvents(prisma),
    checkPaymentDisputes(prisma),
    checkLegacyWalletWithdrawals(prisma),
    checkWithdrawalTraceability(prisma),
  ])

  orderPaymentRecon.push(
    ...providerNeutralDeposits,
    ...depositProviderEvents,
    ...paymentDisputes,
    ...legacyWalletWithdrawals,
  )
  stuckPayouts.push(...withdrawalTraceability)

  const allIssues = [
    ...walletDrift,
    ...publisherDrift,
    ...settlementDrift,
    ...orderPaymentRecon,
    ...refundRecon,
    ...stuckFinancialOrders,
    ...stuckPayouts,
  ]

  let critical = 0
  let warning = 0
  let info = 0
  for (const issue of allIssues) {
    if (issue.severity === "critical") critical++
    else if (issue.severity === "warning") warning++
    else info++
  }

  return {
    version: 1,
    ranAt: new Date().toISOString(),
    scanDurationMs: Date.now() - startedAt,
    ok: allIssues.length === 0,
    summary: { critical, warning, info, totalIssues: allIssues.length },
    stats,
    walletDrift,
    publisherDrift,
    settlementDrift,
    orderPaymentRecon,
    refundRecon,
    stuckFinancialOrders,
    stuckPayouts,
  }
}
