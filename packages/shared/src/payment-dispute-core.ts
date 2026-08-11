// Server-only canonical payment-dispute transition.
//
// The API's signature-verified webhook path and the worker's durable inbox
// retry path both enter here. Keep this module out of the shared browser barrel.

import { createHash } from "node:crypto"
import {
  isWalletCreditBackedDepositStatus,
  type WalletCreditBackedDepositStatus,
} from "./deposit-status"
import {
  isPrismaUniqueConstraintError,
  isRetryablePrismaTransactionError,
  prismaTransactionRetryDelayMs,
} from "./prisma-transaction-retry"
import {
  assertStripeFinancialObjectMode,
  StripeConfigurationError,
} from "./stripe-key-mode"

export type PaymentDisputeDomainStatus = "OPEN" | "WON" | "LOST"
export type PaymentDisputeEventType =
  | "charge.dispute.created"
  | "charge.dispute.closed"

export interface NormalizedPaymentDisputeEvent {
  provider: "stripe"
  providerEventRowId: string
  // Fencing token for the exact durable-inbox lease that authorized this
  // transition. A recovered attempt must never be completed, failed, or
  // quarantined by the stale owner of an earlier lease.
  claimAttempt: number
  claimLockedAt: string
  providerEventId: string
  eventType: PaymentDisputeEventType
  providerDisputeId: string
  providerPaymentId: string
  providerChargeId: string | null
  amountMinor: bigint
  amount: string
  currency: string
  providerStatus: string
  livemode: boolean
  eventFingerprint: string
}

export type FingerprintablePaymentDisputeEvent = Omit<
  NormalizedPaymentDisputeEvent,
  "providerEventRowId" | "claimAttempt" | "claimLockedAt" | "eventFingerprint"
>

export interface PaymentDisputeOutcome {
  status: PaymentDisputeDomainStatus
  held: string
  shortfall: string
  walletId: string
  paymentDisputeId: string
  created: boolean
  resolved: boolean
}

export interface PaymentDisputeAuditInput {
  action: string
  entityType: "PaymentDispute"
  entityId: string
  metadata: Record<string, unknown>
  userId: null
  organizationId: string | null
}

export interface PaymentDisputeHooks {
  audit(tx: any, input: PaymentDisputeAuditInput): Promise<void>
  notifyFinance(
    tx: any,
    input: {
      type: string
      message: string
      dedupKeyPrefix: string
    },
  ): Promise<void>
  notifyCustomer?(tx: any, input: { depositAttemptId: string }): Promise<void>
}

export type PaymentDisputeErrorCode =
  | "EVENT_EVIDENCE_MISSING"
  | "EVENT_ENVELOPE_MISMATCH"
  | "DEPOSIT_NOT_LINKED"
  | "DEPOSIT_EVIDENCE_MISMATCH"
  | "DISPUTE_IDENTITY_REUSED"
  | "CUMULATIVE_AMOUNT_EXCEEDED"
  | "WALLET_CURRENCY_MISMATCH"
  | "WALLET_NEGATIVE"
  | "HOLD_MISSING"
  | "TERMINAL_CONTRADICTION"
  | "STRIPE_KEY_MISSING"
  | "STRIPE_KEY_INVALID"
  | "STRIPE_LIVE_MODE_DISABLED"
  | "STRIPE_PROVIDER_MODE_MISMATCH"
  | "CONCURRENT_CHANGE"

export class PaymentDisputeTransitionError extends Error {
  constructor(
    readonly code: PaymentDisputeErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = "PaymentDisputeTransitionError"
  }
}

class PaymentDisputeRaceError extends Error {}

interface LinkedDisputeDeposit {
  id: string
  walletId: string
  amount: unknown
  currency: string
  depositAttempt: {
    id: string
    walletId: string
    walletCredit: unknown
    currency: string
    provider: string
    providerPaymentId: string | null
    ledgerTransactionId: string | null
    status: string
  }
}

const PAYMENT_DISPUTE_MAX_ATTEMPTS = 4
const MONEY_SCALE = 30
const MONEY_FACTOR = 10n ** BigInt(MONEY_SCALE)
const STRIPE_OPEN_DISPUTE_STATUSES = new Set([
  "needs_response",
  "under_review",
  "warning_needs_response",
  "warning_under_review",
])
const REFUND_PROJECTED_DEPOSIT_STATUSES: ReadonlySet<WalletCreditBackedDepositStatus> =
  new Set(["PARTIALLY_REFUNDED", "REFUNDED"])

function scaledDecimal(value: unknown): bigint {
  const raw = String(value ?? "0").trim()
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw)
  if (!match) throw new Error(`Invalid decimal value: ${raw}`)
  const negative = match[1] === "-"
  const fraction = (match[3] ?? "")
    .padEnd(MONEY_SCALE, "0")
    .slice(0, MONEY_SCALE)
  const scaled =
    BigInt(match[2] || "0") * MONEY_FACTOR + BigInt(fraction || "0")
  return negative ? -scaled : scaled
}

function decimalString(value: bigint): string {
  const negative = value < 0n
  const absolute = negative ? -value : value
  const whole = absolute / MONEY_FACTOR
  const fractional = (absolute % MONEY_FACTOR)
    .toString()
    .padStart(MONEY_SCALE, "0")
    .replace(/0+$/, "")
  return `${negative ? "-" : ""}${whole}${fractional ? `.${fractional}` : ""}`
}

function moneyString(value: bigint): string {
  const decimal = decimalString(value)
  const [whole, fraction = ""] = decimal.split(".")
  return `${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`
}

function reference(
  input: NormalizedPaymentDisputeEvent,
  phase: "hold" | "won" | "lost",
): string {
  return `payment-dispute:${input.provider}:${input.providerDisputeId}:${phase}`
}

export function paymentDisputeEventFingerprint(
  input: FingerprintablePaymentDisputeEvent,
): string {
  const canonicalEnvelope = [
    "payment-dispute-envelope:v1",
    input.provider,
    input.providerEventId,
    input.eventType,
    input.providerDisputeId,
    input.providerPaymentId,
    input.providerChargeId ?? "",
    input.amountMinor.toString(),
    input.amount,
    input.currency,
    input.providerStatus,
    input.livemode ? "live" : "test",
  ]
  return createHash("sha256")
    .update(JSON.stringify(canonicalEnvelope))
    .digest("hex")
}

export function paymentDisputeTargetStatus(
  input: NormalizedPaymentDisputeEvent,
): PaymentDisputeDomainStatus {
  if (input.eventType === "charge.dispute.created") {
    if (STRIPE_OPEN_DISPUTE_STATUSES.has(input.providerStatus)) return "OPEN"
    throw new PaymentDisputeTransitionError(
      "EVENT_ENVELOPE_MISMATCH",
      "A dispute-created event does not contain a supported open status",
      false,
    )
  }
  if (
    input.providerStatus === "won" ||
    input.providerStatus === "prevented" ||
    input.providerStatus === "warning_closed"
  ) {
    return "WON"
  }
  if (input.providerStatus === "lost") return "LOST"
  throw new PaymentDisputeTransitionError(
    "EVENT_ENVELOPE_MISMATCH",
    "A dispute-closed event does not contain a supported terminal status",
    false,
  )
}

export function paymentDisputeEventFromStoredRow(
  event: any,
): NormalizedPaymentDisputeEvent {
  const lockedAt =
    event?.lockedAt instanceof Date
      ? event.lockedAt
      : typeof event?.lockedAt === "string" ||
          typeof event?.lockedAt === "number"
        ? new Date(event.lockedAt)
        : null
  if (
    event?.provider !== "stripe" ||
    (event.eventType !== "charge.dispute.created" &&
      event.eventType !== "charge.dispute.closed") ||
    typeof event.id !== "string" ||
    typeof event.providerEventId !== "string" ||
    typeof event.objectId !== "string" ||
    typeof event.providerPaymentId !== "string" ||
    (event.providerChargeId != null &&
      typeof event.providerChargeId !== "string") ||
    event.disputeAmountMinor == null ||
    event.disputeCurrency !== "USD" ||
    typeof event.providerStatus !== "string" ||
    typeof event.livemode !== "boolean" ||
    typeof event.eventFingerprint !== "string" ||
    !Number.isSafeInteger(event.attempts) ||
    event.attempts <= 0 ||
    !lockedAt ||
    Number.isNaN(lockedAt.getTime())
  ) {
    throw new PaymentDisputeTransitionError(
      "EVENT_EVIDENCE_MISSING",
      "Stored payment dispute event is missing normalized signed facts",
      false,
    )
  }

  let amountMinor: bigint
  try {
    amountMinor = BigInt(event.disputeAmountMinor)
  } catch {
    throw new PaymentDisputeTransitionError(
      "EVENT_ENVELOPE_MISMATCH",
      "Stored payment dispute amount is invalid",
      false,
    )
  }
  if (amountMinor <= 0n) {
    throw new PaymentDisputeTransitionError(
      "EVENT_ENVELOPE_MISMATCH",
      "Stored payment dispute amount is invalid",
      false,
    )
  }
  const fingerprintable: FingerprintablePaymentDisputeEvent = {
    provider: "stripe",
    providerEventId: event.providerEventId,
    eventType: event.eventType,
    providerDisputeId: event.objectId,
    providerPaymentId: event.providerPaymentId,
    providerChargeId: event.providerChargeId ?? null,
    amountMinor,
    amount: `${amountMinor / 100n}.${(amountMinor % 100n)
      .toString()
      .padStart(2, "0")}`,
    currency: "USD",
    providerStatus: event.providerStatus,
    livemode: event.livemode,
  }
  const input: NormalizedPaymentDisputeEvent = {
    providerEventRowId: event.id,
    claimAttempt: event.attempts,
    claimLockedAt: lockedAt.toISOString(),
    ...fingerprintable,
    eventFingerprint: event.eventFingerprint,
  }
  paymentDisputeTargetStatus(input)
  if (
    input.eventFingerprint !== paymentDisputeEventFingerprint(fingerprintable)
  ) {
    throw new PaymentDisputeTransitionError(
      "EVENT_ENVELOPE_MISMATCH",
      "Stored payment dispute fingerprint does not match its normalized facts",
      false,
    )
  }
  return input
}

async function readAndAssertEvent(
  tx: any,
  input: NormalizedPaymentDisputeEvent,
): Promise<void> {
  // The inbox row is the transaction's first lock. This serializes completion
  // against stale-lease recovery and competing API/worker claims.
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "PaymentProviderEvent" WHERE "id" = $1 FOR UPDATE',
    input.providerEventRowId,
  )
  const event = await tx.paymentProviderEvent.findUnique({
    where: { id: input.providerEventRowId },
  })
  const exact =
    event &&
    event.status === "PROCESSING" &&
    event.attempts === input.claimAttempt &&
    event.lockedAt != null &&
    new Date(event.lockedAt).toISOString() === input.claimLockedAt &&
    event.provider === input.provider &&
    event.providerEventId === input.providerEventId &&
    event.eventType === input.eventType &&
    event.objectId === input.providerDisputeId &&
    event.providerPaymentId === input.providerPaymentId &&
    (event.providerChargeId ?? null) === input.providerChargeId &&
    event.disputeAmountMinor != null &&
    BigInt(event.disputeAmountMinor) === input.amountMinor &&
    event.disputeCurrency === input.currency &&
    event.providerStatus === input.providerStatus &&
    event.livemode === input.livemode &&
    event.eventFingerprint === input.eventFingerprint
  if (!exact) {
    throw new PaymentDisputeTransitionError(
      event ? "EVENT_ENVELOPE_MISMATCH" : "EVENT_EVIDENCE_MISSING",
      "Payment dispute event evidence is missing or does not match its signed normalized envelope",
      false,
    )
  }
}

// Wallet mutations and dispute-case creation share this row lock. It is
// intentionally exported for the billing reservation boundary: querying
// PaymentDispute before taking the same lock is not sufficient because a
// zero-held dispute can create uncovered exposure without changing
// Wallet.version.
//
// SAFETY: call only from an existing interactive transaction. A top-level
// Prisma client would release the lock when this statement returns.
export async function lockWalletForUpdate(
  tx: any,
  walletId: string,
): Promise<void> {
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "Wallet" WHERE "id" = $1 FOR UPDATE',
    walletId,
  )
}

async function findLinkedDeposit(
  tx: any,
  input: NormalizedPaymentDisputeEvent,
): Promise<LinkedDisputeDeposit> {
  const row = await tx.transaction.findFirst({
    where: {
      provider: input.provider,
      providerRef: input.providerPaymentId,
      type: "DEPOSIT",
    },
    select: {
      id: true,
      walletId: true,
      amount: true,
      currency: true,
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
    },
  })
  if (!row?.walletId || !row.depositAttempt) {
    throw new PaymentDisputeTransitionError(
      "DEPOSIT_NOT_LINKED",
      "Stripe dispute is not yet linked to a durable deposit attempt",
      true,
    )
  }
  const amount = scaledDecimal(row.amount)
  const walletCredit = scaledDecimal(row.depositAttempt.walletCredit)
  if (
    row.currency.toUpperCase() !== input.currency ||
    row.depositAttempt.currency.toUpperCase() !== input.currency ||
    row.depositAttempt.provider !== input.provider ||
    row.depositAttempt.walletId !== row.walletId ||
    row.depositAttempt.providerPaymentId !== input.providerPaymentId ||
    row.depositAttempt.ledgerTransactionId !== row.id ||
    !isWalletCreditBackedDepositStatus(row.depositAttempt.status) ||
    amount !== walletCredit ||
    scaledDecimal(input.amount) > amount
  ) {
    throw new PaymentDisputeTransitionError(
      "DEPOSIT_EVIDENCE_MISMATCH",
      "Stripe dispute does not match an eligible originating deposit state, amount, currency, or identity",
      false,
    )
  }
  return row as LinkedDisputeDeposit
}

function assertCurrentStripeMode(input: NormalizedPaymentDisputeEvent): void {
  try {
    assertStripeFinancialObjectMode(input.livemode, {
      // Read both values at the mutation boundary. A stored event may have
      // waited in the inbox across a test/live credential rotation.
      secretKey: process.env.STRIPE_SECRET_KEY,
      liveModeEnabled: process.env.STRIPE_LIVE_MODE_ENABLED,
    })
  } catch (error) {
    if (
      error instanceof StripeConfigurationError &&
      (error.code === "STRIPE_KEY_MISSING" ||
        error.code === "STRIPE_KEY_INVALID" ||
        error.code === "STRIPE_LIVE_MODE_DISABLED" ||
        error.code === "STRIPE_PROVIDER_MODE_MISMATCH")
    ) {
      throw new PaymentDisputeTransitionError(error.code, error.message, false)
    }
    throw error
  }
}

function assertExactCase(
  existing: any,
  input: NormalizedPaymentDisputeEvent,
  deposit: LinkedDisputeDeposit,
): void {
  if (
    existing.provider !== input.provider ||
    existing.providerDisputeId !== input.providerDisputeId ||
    existing.providerPaymentId !== input.providerPaymentId ||
    (existing.providerChargeId ?? null) !== input.providerChargeId ||
    existing.depositAttemptId !== deposit.depositAttempt.id ||
    existing.depositTransactionId !== deposit.id ||
    existing.walletId !== deposit.walletId ||
    scaledDecimal(existing.amount) !== scaledDecimal(input.amount) ||
    String(existing.currency).toUpperCase() !== input.currency
  ) {
    throw new PaymentDisputeTransitionError(
      "DISPUTE_IDENTITY_REUSED",
      "A provider dispute identity was reused with different immutable financial inputs",
      false,
    )
  }
}

async function completeEvent(
  tx: any,
  depositAttemptId: string,
  paymentDisputeId: string,
  input: NormalizedPaymentDisputeEvent,
): Promise<void> {
  const cases = await tx.paymentDispute.findMany({
    where: { depositAttemptId },
    select: { status: true },
  })
  const attempt = await tx.depositAttempt.findUniqueOrThrow({
    where: { id: depositAttemptId },
    select: { status: true },
  })
  if (!attempt || typeof attempt.status !== "string") {
    throw new PaymentDisputeTransitionError(
      "DEPOSIT_EVIDENCE_MISMATCH",
      "The linked deposit attempt is unavailable while projecting dispute evidence",
      true,
    )
  }
  const statuses = new Set(
    cases.map((item: { status: PaymentDisputeDomainStatus }) => item.status),
  )
  // Refund and dispute facts are independent. Until customer-funding refunds
  // have their own normalized aggregate, never destroy an already-published
  // refund projection merely because a dispute event is replayed or closes.
  const attemptStatus = REFUND_PROJECTED_DEPOSIT_STATUSES.has(attempt.status)
    ? attempt.status
    : statuses.has("LOST")
      ? "CHARGEBACK"
      : statuses.has("OPEN")
        ? "DISPUTED"
        : "SUCCEEDED"
  if (attempt.status !== attemptStatus) {
    const projected = await tx.depositAttempt.updateMany({
      where: {
        id: depositAttemptId,
        status: attempt.status,
      },
      data: { status: attemptStatus },
    })
    if (projected.count !== 1) throw new PaymentDisputeRaceError()
  }
  const completed = await tx.paymentProviderEvent.updateMany({
    where: {
      id: input.providerEventRowId,
      status: "PROCESSING",
      attempts: input.claimAttempt,
      lockedAt: new Date(input.claimLockedAt),
      OR: [{ paymentDisputeId: null }, { paymentDisputeId }],
    },
    data: {
      status: "PROCESSED",
      processedAt: new Date(),
      lockedAt: null,
      depositAttemptId,
      paymentDisputeId,
      lastError: null,
    },
  })
  if (completed.count !== 1) throw new PaymentDisputeRaceError()
}

export async function transitionPaymentDispute(
  prisma: any,
  hooks: PaymentDisputeHooks,
  input: NormalizedPaymentDisputeEvent,
): Promise<PaymentDisputeOutcome> {
  if (input.eventFingerprint !== paymentDisputeEventFingerprint(input)) {
    throw new PaymentDisputeTransitionError(
      "EVENT_ENVELOPE_MISMATCH",
      "Payment dispute event fingerprint does not match its normalized signed facts",
      false,
    )
  }
  const desiredStatus = paymentDisputeTargetStatus(input)
  let lastRace: unknown
  let validatedDeposit: LinkedDisputeDeposit | undefined

  for (let attempt = 0; attempt < PAYMENT_DISPUTE_MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx: any): Promise<PaymentDisputeOutcome> => {
          await readAndAssertEvent(tx, input)
          const deposit = await findLinkedDeposit(tx, input)
          validatedDeposit = deposit
          // Signature verification proves the mode at receipt time. Re-check
          // the immutable bit against the current key and live-money gate
          // immediately before taking the wallet lock, because this durable
          // event may be replayed by either API or worker after a deployment
          // has switched Stripe environments.
          assertCurrentStripeMode(input)
          // Dispute and spend paths use one order:
          // PaymentProviderEvent -> Wallet -> PaymentDispute.
          // The deposit lookup above is immutable evidence, not a row lock.
          // Taking the wallet lock before reading/casing the dispute prevents a
          // reverse Wallet <-> PaymentDispute dependency with reservation.
          await lockWalletForUpdate(tx, deposit.walletId)
          const existing = await tx.paymentDispute.findUnique({
            where: {
              provider_providerDisputeId: {
                provider: input.provider,
                providerDisputeId: input.providerDisputeId,
              },
            },
          })

          if (existing) {
            assertExactCase(existing, input, deposit)
            const currentStatus = existing.status as PaymentDisputeDomainStatus

            if (desiredStatus === "OPEN") {
              if (!existing.openedByEventId) {
                const attached = await tx.paymentDispute.updateMany({
                  where: {
                    id: existing.id,
                    version: existing.version,
                    openedByEventId: null,
                    openedAt: null,
                  },
                  data: {
                    openedByEventId: input.providerEventRowId,
                    openedAt: new Date(),
                    version: { increment: 1 },
                  },
                })
                if (attached.count !== 1) throw new PaymentDisputeRaceError()
                await hooks.audit(tx, {
                  action: "STRIPE_CHARGEBACK_OPEN_EVIDENCE_ATTACHED",
                  entityType: "PaymentDispute",
                  entityId: existing.id,
                  metadata: {
                    providerDisputeId: input.providerDisputeId,
                    providerPaymentId: input.providerPaymentId,
                    providerEventRowId: input.providerEventRowId,
                    terminalStatus: currentStatus,
                  },
                  userId: null,
                  organizationId: null,
                })
              }
              if (currentStatus === "OPEN") {
                await hooks.notifyCustomer?.(tx, {
                  depositAttemptId: deposit.depositAttempt.id,
                })
              }
              await completeEvent(
                tx,
                deposit.depositAttempt.id,
                existing.id,
                input,
              )
              return {
                status: currentStatus,
                held: moneyString(scaledDecimal(existing.heldAmount)),
                shortfall: moneyString(
                  scaledDecimal(existing.currentExposureAmount),
                ),
                walletId: existing.walletId,
                paymentDisputeId: existing.id,
                created: false,
                resolved: false,
              }
            }

            if (currentStatus !== "OPEN") {
              if (currentStatus !== desiredStatus) {
                throw new PaymentDisputeTransitionError(
                  "TERMINAL_CONTRADICTION",
                  `Stripe dispute is already terminal as ${currentStatus}; refusing conflicting ${desiredStatus} outcome`,
                  false,
                )
              }
              await completeEvent(
                tx,
                deposit.depositAttempt.id,
                existing.id,
                input,
              )
              return {
                status: currentStatus,
                held: moneyString(scaledDecimal(existing.heldAmount)),
                shortfall: moneyString(
                  scaledDecimal(existing.currentExposureAmount),
                ),
                walletId: existing.walletId,
                paymentDisputeId: existing.id,
                created: false,
                resolved: false,
              }
            }

            const held = scaledDecimal(existing.heldAmount)
            const bookedShortfall = scaledDecimal(existing.shortfallAmount)
            const currentExposure =
              desiredStatus === "WON" ? 0n : bookedShortfall
            const wallet = await tx.wallet.findUniqueOrThrow({
              where: { id: existing.walletId },
            })
            if (String(wallet.currency).toUpperCase() !== input.currency) {
              throw new PaymentDisputeTransitionError(
                "WALLET_CURRENCY_MISMATCH",
                "Wallet currency changed after the dispute hold was created",
                false,
              )
            }
            if (held > 0n && scaledDecimal(wallet.reservedBalance) < held) {
              throw new PaymentDisputeTransitionError(
                "HOLD_MISSING",
                "Dispute hold is no longer present in the wallet reserved balance",
                false,
              )
            }
            if (held > 0n) {
              const updated = await tx.wallet.updateMany({
                where: { id: wallet.id, version: wallet.version },
                data:
                  desiredStatus === "WON"
                    ? {
                        reservedBalance: { decrement: decimalString(held) },
                        availableBalance: { increment: decimalString(held) },
                        version: { increment: 1 },
                      }
                    : {
                        reservedBalance: { decrement: decimalString(held) },
                        version: { increment: 1 },
                      },
              })
              if (updated.count !== 1) throw new PaymentDisputeRaceError()
            }

            let resolutionTransactionId: string | null = null
            if (held > 0n) {
              const resolution = await tx.transaction.create({
                data: {
                  walletId: wallet.id,
                  amount:
                    desiredStatus === "WON"
                      ? decimalString(held)
                      : decimalString(-held),
                  currency: input.currency,
                  type: desiredStatus === "WON" ? "RESERVATION" : "CHARGEBACK",
                  reference: reference(
                    input,
                    desiredStatus === "WON" ? "won" : "lost",
                  ),
                  description:
                    desiredStatus === "WON"
                      ? `Provider dispute ${input.providerDisputeId} won — ${moneyString(held)} released`
                      : `Provider dispute ${input.providerDisputeId} lost — ${moneyString(held)} debited`,
                },
              })
              resolutionTransactionId = resolution.id
            }

            const transitioned = await tx.paymentDispute.updateMany({
              where: {
                id: existing.id,
                status: "OPEN",
                version: existing.version,
                resolutionTransactionId: null,
              },
              data: {
                status: desiredStatus,
                providerStatus: input.providerStatus,
                resolvedByEventId: input.providerEventRowId,
                resolutionTransactionId,
                currentExposureAmount: decimalString(currentExposure),
                resolvedAt: new Date(),
                version: { increment: 1 },
              },
            })
            if (transitioned.count !== 1) throw new PaymentDisputeRaceError()

            await hooks.audit(tx, {
              action:
                desiredStatus === "WON"
                  ? "STRIPE_CHARGEBACK_WON_RELEASED"
                  : "STRIPE_CHARGEBACK_LOST_DEBITED",
              entityType: "PaymentDispute",
              entityId: existing.id,
              metadata: {
                providerDisputeId: input.providerDisputeId,
                providerPaymentId: input.providerPaymentId,
                depositTransactionId: deposit.id,
                walletId: wallet.id,
                amount: input.amount,
                heldAmount: moneyString(held),
                bookedShortfallAmount: moneyString(bookedShortfall),
                currentExposureAmount: moneyString(currentExposure),
                currency: input.currency,
                providerStatus: input.providerStatus,
              },
              userId: null,
              organizationId: wallet.organizationId,
            })
            await hooks.notifyFinance(tx, {
              type: "STRIPE_CHARGEBACK",
              message:
                desiredStatus === "WON"
                  ? `Chargeback ${input.providerDisputeId} WON — ${moneyString(held)} released back to the wallet`
                  : `Chargeback ${input.providerDisputeId} LOST — ${moneyString(held)} debited${currentExposure > 0n ? `, ${moneyString(currentExposure)} uncovered` : ""}`,
              dedupKeyPrefix: `chargeback:${input.providerDisputeId}:${desiredStatus.toLowerCase()}`,
            })
            await completeEvent(
              tx,
              deposit.depositAttempt.id,
              existing.id,
              input,
            )
            return {
              status: desiredStatus,
              held: moneyString(held),
              shortfall: moneyString(currentExposure),
              walletId: wallet.id,
              paymentDisputeId: existing.id,
              created: false,
              resolved: true,
            }
          }

          // Serialize case booking through the Wallet row before reading the
          // cumulative predicate or calculating the hold. This is required
          // even for zero-held and WON cases, which otherwise write no wallet
          // version and can race both another dispute and a customer spend.
          const aggregate = await tx.paymentDispute.aggregate({
            where: { depositTransactionId: deposit.id },
            _sum: { amount: true },
          })
          const cumulative =
            scaledDecimal(aggregate._sum.amount ?? 0) +
            scaledDecimal(input.amount)
          if (cumulative > scaledDecimal(deposit.amount)) {
            throw new PaymentDisputeTransitionError(
              "CUMULATIVE_AMOUNT_EXCEEDED",
              "Cumulative disputes exceed the originating deposit credit",
              false,
            )
          }

          const wallet = await tx.wallet.findUniqueOrThrow({
            where: { id: deposit.walletId },
          })
          if (String(wallet.currency).toUpperCase() !== input.currency) {
            throw new PaymentDisputeTransitionError(
              "WALLET_CURRENCY_MISMATCH",
              "Stripe dispute currency does not match the wallet",
              false,
            )
          }
          const available = scaledDecimal(wallet.availableBalance)
          if (available < 0n) {
            throw new PaymentDisputeTransitionError(
              "WALLET_NEGATIVE",
              "Wallet available balance is negative; reconcile before applying a dispute",
              false,
            )
          }
          const amount = scaledDecimal(input.amount)
          const held =
            desiredStatus === "WON"
              ? 0n
              : available < amount
                ? available
                : amount
          const bookedShortfall = amount - held
          const currentExposure = desiredStatus === "WON" ? 0n : bookedShortfall

          if (held > 0n) {
            const updated = await tx.wallet.updateMany({
              where: { id: wallet.id, version: wallet.version },
              data:
                desiredStatus === "OPEN"
                  ? {
                      availableBalance: { decrement: decimalString(held) },
                      reservedBalance: { increment: decimalString(held) },
                      version: { increment: 1 },
                    }
                  : {
                      availableBalance: { decrement: decimalString(held) },
                      version: { increment: 1 },
                    },
            })
            if (updated.count !== 1) throw new PaymentDisputeRaceError()
          }

          if (desiredStatus === "OPEN") {
            let holdTransactionId: string | null = null
            if (held > 0n) {
              const hold = await tx.transaction.create({
                data: {
                  walletId: wallet.id,
                  amount: decimalString(-held),
                  currency: input.currency,
                  type: "RESERVATION",
                  reference: reference(input, "hold"),
                  description:
                    `Provider dispute hold ${input.providerDisputeId}: ${moneyString(held)}` +
                    (currentExposure > 0n
                      ? ` (${moneyString(currentExposure)} uncovered)`
                      : ""),
                },
              })
              holdTransactionId = hold.id
            }
            const created = await tx.paymentDispute.create({
              data: {
                provider: input.provider,
                providerDisputeId: input.providerDisputeId,
                providerPaymentId: input.providerPaymentId,
                providerChargeId: input.providerChargeId,
                depositAttemptId: deposit.depositAttempt.id,
                depositTransactionId: deposit.id,
                walletId: wallet.id,
                amount: input.amount,
                currency: input.currency,
                heldAmount: decimalString(held),
                shortfallAmount: decimalString(bookedShortfall),
                currentExposureAmount: decimalString(currentExposure),
                status: "OPEN",
                providerStatus: input.providerStatus,
                openedByEventId: input.providerEventRowId,
                holdTransactionId,
                openedAt: new Date(),
              },
            })
            await hooks.audit(tx, {
              action: "STRIPE_CHARGEBACK_HOLD_PLACED",
              entityType: "PaymentDispute",
              entityId: created.id,
              metadata: {
                providerDisputeId: input.providerDisputeId,
                providerPaymentId: input.providerPaymentId,
                providerChargeId: input.providerChargeId,
                depositTransactionId: deposit.id,
                walletId: wallet.id,
                amount: input.amount,
                heldAmount: moneyString(held),
                bookedShortfallAmount: moneyString(bookedShortfall),
                currentExposureAmount: moneyString(currentExposure),
                currency: input.currency,
                providerStatus: input.providerStatus,
              },
              userId: null,
              organizationId: wallet.organizationId,
            })
            await hooks.notifyFinance(tx, {
              type: "STRIPE_CHARGEBACK",
              message: `Chargeback ${input.providerDisputeId} for ${input.amount} ${input.currency} — ${moneyString(held)} held${currentExposure > 0n ? `, ${moneyString(currentExposure)} uncovered` : ""}. Respond in Stripe dashboard.`,
              dedupKeyPrefix: `chargeback:${input.providerDisputeId}:opened`,
            })
            await hooks.notifyCustomer?.(tx, {
              depositAttemptId: deposit.depositAttempt.id,
            })
            await completeEvent(
              tx,
              deposit.depositAttempt.id,
              created.id,
              input,
            )
            return {
              status: "OPEN",
              held: moneyString(held),
              shortfall: moneyString(currentExposure),
              walletId: wallet.id,
              paymentDisputeId: created.id,
              created: true,
              resolved: false,
            }
          }

          let resolutionTransactionId: string | null = null
          if (held > 0n) {
            const resolution = await tx.transaction.create({
              data: {
                walletId: wallet.id,
                amount: decimalString(-held),
                currency: input.currency,
                type: "CHARGEBACK",
                reference: reference(input, "lost"),
                description: `Provider dispute ${input.providerDisputeId} lost before an open event was applied — ${moneyString(held)} debited`,
              },
            })
            resolutionTransactionId = resolution.id
          }
          const created = await tx.paymentDispute.create({
            data: {
              provider: input.provider,
              providerDisputeId: input.providerDisputeId,
              providerPaymentId: input.providerPaymentId,
              providerChargeId: input.providerChargeId,
              depositAttemptId: deposit.depositAttempt.id,
              depositTransactionId: deposit.id,
              walletId: wallet.id,
              amount: input.amount,
              currency: input.currency,
              heldAmount: decimalString(held),
              shortfallAmount: decimalString(bookedShortfall),
              currentExposureAmount: decimalString(currentExposure),
              status: desiredStatus,
              providerStatus: input.providerStatus,
              resolvedByEventId: input.providerEventRowId,
              resolutionTransactionId,
              resolvedAt: new Date(),
            },
          })
          await hooks.audit(tx, {
            action:
              desiredStatus === "WON"
                ? "STRIPE_CHARGEBACK_WON_BEFORE_OPEN"
                : "STRIPE_CHARGEBACK_LOST_BEFORE_OPEN",
            entityType: "PaymentDispute",
            entityId: created.id,
            metadata: {
              providerDisputeId: input.providerDisputeId,
              providerPaymentId: input.providerPaymentId,
              depositTransactionId: deposit.id,
              walletId: wallet.id,
              amount: input.amount,
              heldAmount: moneyString(held),
              bookedShortfallAmount: moneyString(bookedShortfall),
              currentExposureAmount: moneyString(currentExposure),
              currency: input.currency,
              providerStatus: input.providerStatus,
            },
            userId: null,
            organizationId: wallet.organizationId,
          })
          await hooks.notifyFinance(tx, {
            type: "STRIPE_CHARGEBACK",
            message:
              desiredStatus === "WON"
                ? `Chargeback ${input.providerDisputeId} WON before the open event was applied — no wallet funds moved`
                : `Chargeback ${input.providerDisputeId} LOST before the open event was applied — ${moneyString(held)} debited${currentExposure > 0n ? `, ${moneyString(currentExposure)} uncovered` : ""}`,
            dedupKeyPrefix: `chargeback:${input.providerDisputeId}:${desiredStatus.toLowerCase()}`,
          })
          await completeEvent(tx, deposit.depositAttempt.id, created.id, input)
          return {
            status: desiredStatus,
            held: moneyString(held),
            shortfall: moneyString(currentExposure),
            walletId: wallet.id,
            paymentDisputeId: created.id,
            created: true,
            resolved: true,
          }
        },
        { isolationLevel: "Serializable" },
      )
    } catch (error) {
      if (
        error instanceof PaymentDisputeRaceError ||
        isRetryablePrismaTransactionError(error)
      ) {
        lastRace = error
        await new Promise((resolve) =>
          setTimeout(resolve, prismaTransactionRetryDelayMs(attempt + 1)),
        )
        continue
      }
      if (isPrismaUniqueConstraintError(error)) {
        const existing = await prisma.paymentDispute.findUnique({
          where: {
            provider_providerDisputeId: {
              provider: input.provider,
              providerDisputeId: input.providerDisputeId,
            },
          },
        })
        if (!existing || !validatedDeposit) throw error
        assertExactCase(existing, input, validatedDeposit)
        lastRace = error
        await new Promise((resolve) =>
          setTimeout(resolve, prismaTransactionRetryDelayMs(attempt + 1)),
        )
        continue
      }
      throw error
    }
  }
  throw new PaymentDisputeTransitionError(
    "CONCURRENT_CHANGE",
    lastRace
      ? "Payment dispute changed concurrently; the durable inbox will retry it"
      : "Payment dispute could not be processed",
    true,
  )
}
