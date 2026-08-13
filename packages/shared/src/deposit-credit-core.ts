// Server-only canonical customer deposit credit finalizer.
//
// A signature-verified webhook and authenticated provider retrieval both enter
// this exact serializable transition. Authority rows are locked first, then
// the wallet is locked before mutable deposit state is re-read. No caller may
// credit a wallet without durable provider authority and exact command facts.

import {
  isCreditablePreCreditDepositStatus,
  isWalletCreditBackedDepositStatus,
} from "./deposit-status"
import {
  isPrismaUniqueConstraintError,
  isRetryablePrismaTransactionError,
  prismaTransactionRetryDelayMs,
} from "./prisma-transaction-retry"
import {
  type StripeDepositRecoveryEvidence,
  stripeDepositRecoveryEvidenceFingerprint,
} from "./stripe-deposit-recovery"
import {
  assertStripeFinancialObjectMode,
  StripeConfigurationError,
} from "./stripe-key-mode"

export type DepositCreditSource =
  | "SIGNED_WEBHOOK"
  | "AUTHENTICATED_PROVIDER_RETRIEVAL"

export interface NormalizedDepositCreditFacts {
  source: DepositCreditSource
  provider: "stripe"
  providerSessionId: string
  providerPaymentId: string
  providerChargeId: string | null
  clientReferenceId: string
  checkoutStatus: string
  checkoutPaymentStatus: string
  checkoutMode: string
  checkoutAmountTotalMinor: bigint
  checkoutCurrency: string
  checkoutLivemode: boolean
  checkoutMetadataAttemptId: string
  checkoutMetadataReference: string
  checkoutMetadataWalletId: string
  checkoutMetadataUserId: string
  checkoutMetadataOrgId: string | null
  paymentIntentStatus: string | null
  paymentIntentAmountMinor: bigint | null
  paymentIntentReceivedMinor: bigint | null
  paymentIntentCurrency: string | null
  paymentIntentLivemode: boolean | null
  paymentMetadataAttemptId: string | null
  paymentMetadataReference: string | null
  paymentMetadataWalletId: string | null
  chargePaid: boolean | null
  chargeCaptured: boolean | null
  chargeRefunded: boolean | null
  chargeAmountMinor: bigint | null
  chargeAmountCapturedMinor: bigint | null
  chargeCurrency: string | null
  chargeLivemode: boolean | null
}

export interface DepositWebhookAuthority {
  kind: "WEBHOOK_EVENT"
  eventRowId: string
  lease:
    | { kind: "lease"; attempts: number; lockedAt: Date }
    | {
        kind: "snapshot"
        status: string
        attempts: number
        lockedAt: Date | null
        processedAt: Date | null
      }
}

export interface DepositRecoveryAuthority {
  kind: "RECOVERY"
  recoveryId: string
  evidenceId: string
  attempts: number
  lockedAt: Date
}

export type DepositCreditAuthority =
  | DepositWebhookAuthority
  | DepositRecoveryAuthority

export interface DepositCreditAuditInput {
  action: "WALLET_DEPOSIT"
  entityType: "Wallet"
  entityId: string
  metadata: Record<string, unknown>
  userId: string
  organizationId: string | null
}

export interface DepositCreditHooks {
  audit(tx: any, input: DepositCreditAuditInput): Promise<void>
  recordSuccess(
    tx: any,
    input: {
      depositAttemptId: string
      walletId: string
      organizationId: string | null
      createdByUserId: string
      amount: string
      currency: "USD"
    },
  ): Promise<string[]>
}

export interface DepositCreditOutcome {
  depositAttemptId: string
  walletId: string
  ledgerTransactionId: string
  credited: boolean
  communicationEventIds: string[]
}

export type DepositCreditErrorCode =
  | "AUTHORITY_MISSING"
  | "AUTHORITY_LEASE_LOST"
  | "AUTHORITY_EVIDENCE_MISMATCH"
  | "DEPOSIT_ATTEMPT_NOT_FOUND"
  | "DEPOSIT_ATTEMPT_EVIDENCE_MISMATCH"
  | "DEPOSIT_ATTEMPT_STATE_MISMATCH"
  | "DEPOSIT_PROVIDER_STATE_NOT_PAID"
  | "DEPOSIT_PROVIDER_EVIDENCE_CONTRADICTION"
  | "DEPOSIT_WALLET_CURRENCY_MISMATCH"
  | "DEPOSIT_IDEMPOTENCY_COLLISION"
  | "STRIPE_KEY_MISSING"
  | "STRIPE_KEY_INVALID"
  | "STRIPE_LIVE_MODE_DISABLED"
  | "STRIPE_PROVIDER_MODE_MISMATCH"
  | "CONCURRENT_CHANGE"

export class DepositCreditFinalizationError extends Error {
  readonly name = "DepositCreditFinalizationError"

  constructor(
    readonly code: DepositCreditErrorCode,
    readonly retryable: boolean,
  ) {
    super(code)
  }
}

class DepositCreditRaceError extends Error {}

const MAX_ATTEMPTS = 4
const USD_MINOR_FACTOR = 100n

function requiredString(value: unknown, max = 191): string {
  if (typeof value !== "string") {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_PROVIDER_EVIDENCE_CONTRADICTION",
      false,
    )
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > max) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_PROVIDER_EVIDENCE_CONTRADICTION",
      false,
    )
  }
  return normalized
}

function decimalToMinor(value: unknown): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(value ?? "").trim())
  if (!match) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_ATTEMPT_EVIDENCE_MISMATCH",
      false,
    )
  }
  const fraction = match[3] ?? ""
  if (fraction.slice(2).replace(/0/g, "") !== "") {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_ATTEMPT_EVIDENCE_MISMATCH",
      false,
    )
  }
  const result =
    BigInt(match[2]) * USD_MINOR_FACTOR +
    BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0")
  return match[1] === "-" ? -result : result
}

function minorToMoney(value: bigint): string {
  const whole = value / USD_MINOR_FACTOR
  const fraction = (value % USD_MINOR_FACTOR).toString().padStart(2, "0")
  return `${whole}.${fraction}`
}

function sameInstant(left: unknown, right: Date | null): boolean {
  if (left == null || right == null) return left == null && right == null
  const date = left instanceof Date ? left : new Date(left as any)
  return !Number.isNaN(date.getTime()) && date.getTime() === right.getTime()
}

function assertProviderFacts(facts: NormalizedDepositCreditFacts): void {
  requiredString(facts.providerSessionId)
  requiredString(facts.providerPaymentId)
  requiredString(facts.clientReferenceId)
  requiredString(facts.checkoutMetadataAttemptId)
  requiredString(facts.checkoutMetadataReference, 32)
  requiredString(facts.checkoutMetadataWalletId)
  requiredString(facts.checkoutMetadataUserId)
  if (
    facts.provider !== "stripe" ||
    facts.checkoutStatus !== "complete" ||
    facts.checkoutPaymentStatus !== "paid" ||
    facts.checkoutMode !== "payment" ||
    facts.checkoutAmountTotalMinor <= 0n ||
    facts.checkoutCurrency !== "usd"
  ) {
    throw new DepositCreditFinalizationError(
      facts.checkoutPaymentStatus === "paid"
        ? "DEPOSIT_PROVIDER_EVIDENCE_CONTRADICTION"
        : "DEPOSIT_PROVIDER_STATE_NOT_PAID",
      facts.checkoutPaymentStatus !== "paid",
    )
  }
  if (facts.source === "AUTHENTICATED_PROVIDER_RETRIEVAL") {
    if (
      !facts.providerChargeId ||
      facts.paymentIntentStatus !== "succeeded" ||
      facts.paymentIntentAmountMinor !== facts.checkoutAmountTotalMinor ||
      facts.paymentIntentReceivedMinor !== facts.checkoutAmountTotalMinor ||
      facts.paymentIntentCurrency !== "usd" ||
      facts.paymentIntentLivemode !== facts.checkoutLivemode ||
      facts.paymentMetadataAttemptId !== facts.checkoutMetadataAttemptId ||
      facts.paymentMetadataReference !== facts.checkoutMetadataReference ||
      facts.paymentMetadataWalletId !== facts.checkoutMetadataWalletId ||
      facts.chargePaid !== true ||
      facts.chargeCaptured !== true ||
      facts.chargeRefunded !== false ||
      facts.chargeAmountMinor !== facts.checkoutAmountTotalMinor ||
      facts.chargeAmountCapturedMinor !== facts.checkoutAmountTotalMinor ||
      facts.chargeCurrency !== "usd" ||
      facts.chargeLivemode !== facts.checkoutLivemode
    ) {
      throw new DepositCreditFinalizationError(
        "DEPOSIT_PROVIDER_EVIDENCE_CONTRADICTION",
        false,
      )
    }
  }
}

function recoveryEvidenceToFacts(row: any): NormalizedDepositCreditFacts {
  return {
    source: "AUTHENTICATED_PROVIDER_RETRIEVAL",
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    providerPaymentId: row.providerPaymentId,
    providerChargeId: row.providerChargeId,
    clientReferenceId: row.clientReferenceId,
    checkoutStatus: row.checkoutStatus,
    checkoutPaymentStatus: row.checkoutPaymentStatus,
    checkoutMode: row.checkoutMode,
    checkoutAmountTotalMinor: BigInt(row.checkoutAmountTotalMinor),
    checkoutCurrency: row.checkoutCurrency,
    checkoutLivemode: row.checkoutLivemode,
    checkoutMetadataAttemptId: row.checkoutMetadataAttemptId,
    checkoutMetadataReference: row.checkoutMetadataReference,
    checkoutMetadataWalletId: row.checkoutMetadataWalletId,
    checkoutMetadataUserId: row.checkoutMetadataUserId,
    checkoutMetadataOrgId: row.checkoutMetadataOrgId || null,
    paymentIntentStatus: row.paymentIntentStatus,
    paymentIntentAmountMinor:
      row.paymentIntentAmountMinor == null
        ? null
        : BigInt(row.paymentIntentAmountMinor),
    paymentIntentReceivedMinor:
      row.paymentIntentReceivedMinor == null
        ? null
        : BigInt(row.paymentIntentReceivedMinor),
    paymentIntentCurrency: row.paymentIntentCurrency,
    paymentIntentLivemode: row.paymentIntentLivemode,
    paymentMetadataAttemptId: row.paymentMetadataAttemptId,
    paymentMetadataReference: row.paymentMetadataReference,
    paymentMetadataWalletId: row.paymentMetadataWalletId,
    chargePaid: row.chargePaid,
    chargeCaptured: row.chargeCaptured,
    chargeRefunded: row.chargeRefunded,
    chargeAmountMinor:
      row.chargeAmountMinor == null ? null : BigInt(row.chargeAmountMinor),
    chargeAmountCapturedMinor:
      row.chargeAmountCapturedMinor == null
        ? null
        : BigInt(row.chargeAmountCapturedMinor),
    chargeCurrency: row.chargeCurrency,
    chargeLivemode: row.chargeLivemode,
  }
}

function factsFingerprintable(
  facts: NormalizedDepositCreditFacts,
): Omit<StripeDepositRecoveryEvidence, "evidenceFingerprint" | "retrievedAt"> {
  return {
    ...facts,
    source: "AUTHENTICATED_PROVIDER_RETRIEVAL",
  }
}

function factsEqual(
  left: NormalizedDepositCreditFacts,
  right: NormalizedDepositCreditFacts,
): boolean {
  const normalize = (value: unknown): unknown => {
    if (typeof value === "bigint") return value.toString()
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)]),
      )
    }
    return value
  }
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

async function assertAuthority(
  tx: any,
  authority: DepositCreditAuthority,
  facts: NormalizedDepositCreditFacts,
): Promise<void> {
  if (authority.kind === "WEBHOOK_EVENT") {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "PaymentProviderEvent" WHERE "id" = $1 FOR UPDATE',
      authority.eventRowId,
    )
    const event = await tx.paymentProviderEvent.findUnique({
      where: { id: authority.eventRowId },
    })
    if (!event) {
      throw new DepositCreditFinalizationError("AUTHORITY_MISSING", false)
    }
    const commonExact =
      event.provider === facts.provider &&
      event.objectId === facts.providerSessionId &&
      event.livemode === facts.checkoutLivemode &&
      (event.eventType === "checkout.session.completed" ||
        event.eventType === "checkout.session.async_payment_succeeded")
    const lease = authority.lease
    const ownershipExact =
      lease.kind === "lease"
        ? event.status === "PROCESSING" &&
          event.attempts === lease.attempts &&
          sameInstant(event.lockedAt, lease.lockedAt)
        : event.status === lease.status &&
          event.attempts === lease.attempts &&
          sameInstant(event.lockedAt, lease.lockedAt) &&
          sameInstant(event.processedAt, lease.processedAt)
    if (!commonExact || !ownershipExact) {
      throw new DepositCreditFinalizationError(
        ownershipExact ? "AUTHORITY_EVIDENCE_MISMATCH" : "AUTHORITY_LEASE_LOST",
        false,
      )
    }
    return
  }

  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "DepositCreditRecovery" WHERE "id" = $1 FOR UPDATE',
    authority.recoveryId,
  )
  const recovery = await tx.depositCreditRecovery.findUnique({
    where: { id: authority.recoveryId },
  })
  if (!recovery) {
    throw new DepositCreditFinalizationError("AUTHORITY_MISSING", false)
  }
  if (
    recovery.status !== "PROCESSING" ||
    recovery.attempts !== authority.attempts ||
    !sameInstant(recovery.lockedAt, authority.lockedAt)
  ) {
    throw new DepositCreditFinalizationError("AUTHORITY_LEASE_LOST", false)
  }
  const evidence = await tx.depositCreditEvidence.findUnique({
    where: { id: authority.evidenceId },
  })
  if (
    !evidence ||
    evidence.recoveryId !== recovery.id ||
    evidence.depositAttemptId !== recovery.depositAttemptId ||
    evidence.claimAttempt !== authority.attempts ||
    !sameInstant(evidence.claimLockedAt, authority.lockedAt) ||
    evidence.source !== "AUTHENTICATED_PROVIDER_RETRIEVAL"
  ) {
    throw new DepositCreditFinalizationError(
      "AUTHORITY_EVIDENCE_MISMATCH",
      false,
    )
  }
  let storedFacts: NormalizedDepositCreditFacts
  try {
    storedFacts = recoveryEvidenceToFacts(evidence)
  } catch {
    throw new DepositCreditFinalizationError(
      "AUTHORITY_EVIDENCE_MISMATCH",
      false,
    )
  }
  if (
    !factsEqual(storedFacts, facts) ||
    evidence.evidenceFingerprint !==
      stripeDepositRecoveryEvidenceFingerprint(
        factsFingerprintable(storedFacts),
      )
  ) {
    throw new DepositCreditFinalizationError(
      "AUTHORITY_EVIDENCE_MISMATCH",
      false,
    )
  }
}

async function completeAuthority(
  tx: any,
  authority: DepositCreditAuthority,
  depositAttemptId: string,
): Promise<void> {
  if (authority.kind === "WEBHOOK_EVENT") {
    if (authority.lease.kind === "snapshot") {
      if (authority.lease.status !== "PROCESSED") {
        throw new DepositCreditFinalizationError(
          "AUTHORITY_EVIDENCE_MISMATCH",
          false,
        )
      }
      const event = await tx.paymentProviderEvent.findUnique({
        where: { id: authority.eventRowId },
        select: { depositAttemptId: true },
      })
      if (event?.depositAttemptId !== depositAttemptId) {
        throw new DepositCreditFinalizationError(
          "AUTHORITY_EVIDENCE_MISMATCH",
          false,
        )
      }
      return
    }
    const completed = await tx.paymentProviderEvent.updateMany({
      where: {
        id: authority.eventRowId,
        status: "PROCESSING",
        attempts: authority.lease.attempts,
        lockedAt: authority.lease.lockedAt,
      },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
        lockedAt: null,
        depositAttemptId,
        lastError: null,
      },
    })
    if (completed.count !== 1) throw new DepositCreditRaceError()
    return
  }
  const completed = await tx.depositCreditRecovery.updateMany({
    where: {
      id: authority.recoveryId,
      depositAttemptId,
      status: "PROCESSING",
      attempts: authority.attempts,
      lockedAt: authority.lockedAt,
      evidenceId: null,
    },
    data: {
      status: "PROCESSED",
      processedAt: new Date(),
      lockedAt: null,
      evidenceId: authority.evidenceId,
      lastError: null,
    },
  })
  if (completed.count !== 1) throw new DepositCreditRaceError()
}

function assertAttemptExact(
  attempt: any,
  facts: NormalizedDepositCreditFacts,
): void {
  const orgMetadata = facts.checkoutMetadataOrgId || null
  if (
    attempt.provider !== "stripe" ||
    attempt.providerSessionId !== facts.providerSessionId ||
    (attempt.providerPaymentId != null &&
      attempt.providerPaymentId !== facts.providerPaymentId) ||
    ((facts.source === "AUTHENTICATED_PROVIDER_RETRIEVAL" ||
      facts.providerChargeId != null) &&
      attempt.providerChargeId != null &&
      attempt.providerChargeId !== facts.providerChargeId) ||
    facts.clientReferenceId !== attempt.id ||
    facts.checkoutMetadataAttemptId !== attempt.id ||
    facts.checkoutMetadataReference !== attempt.publicReference ||
    facts.checkoutMetadataWalletId !== attempt.walletId ||
    facts.checkoutMetadataUserId !== attempt.createdByUserId ||
    orgMetadata !== (attempt.organizationId ?? null) ||
    attempt.currency !== "USD" ||
    decimalToMinor(attempt.amount) !== facts.checkoutAmountTotalMinor ||
    decimalToMinor(attempt.walletCredit) !== facts.checkoutAmountTotalMinor ||
    decimalToMinor(attempt.customerFee) !== 0n
  ) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_ATTEMPT_EVIDENCE_MISMATCH",
      false,
    )
  }
}

async function findExactAttempt(
  tx: any,
  facts: NormalizedDepositCreditFacts,
): Promise<any> {
  const candidates = await tx.depositAttempt.findMany({
    where: {
      OR: [
        { id: facts.checkoutMetadataAttemptId },
        { providerSessionId: facts.providerSessionId },
      ],
    },
    take: 3,
  })
  if (candidates.length === 0) {
    throw new DepositCreditFinalizationError("DEPOSIT_ATTEMPT_NOT_FOUND", false)
  }
  if (candidates.length !== 1) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_ATTEMPT_EVIDENCE_MISMATCH",
      false,
    )
  }
  assertAttemptExact(candidates[0], facts)
  return candidates[0]
}

function assertCurrentStripeMode(facts: NormalizedDepositCreditFacts): void {
  const secretKey =
    facts.source === "AUTHENTICATED_PROVIDER_RETRIEVAL"
      ? process.env.STRIPE_DEPOSIT_RECOVERY_KEY
      : process.env.STRIPE_SECRET_KEY
  try {
    assertStripeFinancialObjectMode(facts.checkoutLivemode, {
      secretKey,
      liveModeEnabled: process.env.STRIPE_LIVE_MODE_ENABLED,
    })
  } catch (error) {
    if (error instanceof StripeConfigurationError) {
      const retryable = error.code !== "STRIPE_PROVIDER_MODE_MISMATCH"
      const code: DepositCreditErrorCode =
        error.code === "STRIPE_KEY_MISSING" ||
        error.code === "STRIPE_KEY_INVALID" ||
        error.code === "STRIPE_LIVE_MODE_DISABLED" ||
        error.code === "STRIPE_PROVIDER_MODE_MISMATCH"
          ? error.code
          : "STRIPE_PROVIDER_MODE_MISMATCH"
      throw new DepositCreditFinalizationError(code, retryable)
    }
    throw error
  }
}

async function exactLedgerReplay(
  tx: any,
  attempt: any,
  facts: NormalizedDepositCreditFacts,
): Promise<any | null> {
  const candidates = await tx.transaction.findMany({
    where: {
      OR: [
        { reference: facts.providerSessionId },
        { provider: "stripe", providerRef: facts.providerPaymentId },
      ],
    },
  })
  if (candidates.length === 0) return null
  if (candidates.length !== 1) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_IDEMPOTENCY_COLLISION",
      false,
    )
  }
  const ledger = candidates[0]
  if (
    ledger.type !== "DEPOSIT" ||
    ledger.reference !== facts.providerSessionId ||
    ledger.provider !== "stripe" ||
    ledger.providerRef !== facts.providerPaymentId ||
    ledger.walletId !== attempt.walletId ||
    ledger.currency !== "USD" ||
    decimalToMinor(ledger.amount) !== facts.checkoutAmountTotalMinor ||
    attempt.ledgerTransactionId !== ledger.id ||
    !isWalletCreditBackedDepositStatus(attempt.status)
  ) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_IDEMPOTENCY_COLLISION",
      false,
    )
  }
  return ledger
}

export async function finalizeDepositCredit(
  prisma: any,
  hooks: DepositCreditHooks,
  input: {
    authority: DepositCreditAuthority
    facts: NormalizedDepositCreditFacts
  },
): Promise<DepositCreditOutcome> {
  assertProviderFacts(input.facts)
  let lastRace: unknown
  for (
    let transactionAttempt = 0;
    transactionAttempt < MAX_ATTEMPTS;
    transactionAttempt++
  ) {
    try {
      return await prisma.$transaction(
        async (tx: any): Promise<DepositCreditOutcome> => {
          await assertAuthority(tx, input.authority, input.facts)
          const initialAttempt = await findExactAttempt(tx, input.facts)
          if (
            input.authority.kind === "RECOVERY" &&
            initialAttempt.id !==
              (
                await tx.depositCreditRecovery.findUniqueOrThrow({
                  where: { id: input.authority.recoveryId },
                  select: { depositAttemptId: true },
                })
              ).depositAttemptId
          ) {
            throw new DepositCreditFinalizationError(
              "AUTHORITY_EVIDENCE_MISMATCH",
              false,
            )
          }
          assertCurrentStripeMode(input.facts)
          await tx.$queryRawUnsafe(
            'SELECT "id" FROM "Wallet" WHERE "id" = $1 FOR UPDATE',
            initialAttempt.walletId,
          )
          await tx.$queryRawUnsafe(
            'SELECT "id" FROM "DepositAttempt" WHERE "id" = $1 FOR UPDATE',
            initialAttempt.id,
          )
          const attempt = await tx.depositAttempt.findUniqueOrThrow({
            where: { id: initialAttempt.id },
          })
          assertAttemptExact(attempt, input.facts)
          const wallet = await tx.wallet.findUniqueOrThrow({
            where: { id: attempt.walletId },
          })
          if (wallet.currency !== "USD") {
            throw new DepositCreditFinalizationError(
              "DEPOSIT_WALLET_CURRENCY_MISMATCH",
              false,
            )
          }

          const replay = await exactLedgerReplay(tx, attempt, input.facts)
          if (replay) {
            await completeAuthority(tx, input.authority, attempt.id)
            return {
              depositAttemptId: attempt.id,
              walletId: attempt.walletId,
              ledgerTransactionId: replay.id,
              credited: false,
              communicationEventIds: [],
            }
          }
          if (
            !isCreditablePreCreditDepositStatus(attempt.status) ||
            attempt.ledgerTransactionId != null
          ) {
            throw new DepositCreditFinalizationError(
              "DEPOSIT_ATTEMPT_STATE_MISMATCH",
              false,
            )
          }

          const amount = minorToMoney(input.facts.checkoutAmountTotalMinor)
          const ledger = await tx.transaction.create({
            data: {
              walletId: attempt.walletId,
              amount,
              type: "DEPOSIT",
              currency: "USD",
              reference: input.facts.providerSessionId,
              provider: "stripe",
              providerRef: input.facts.providerPaymentId,
              description: `GuestPost wallet deposit ${attempt.publicReference}`,
            },
          })
          const updatedWallet = await tx.wallet.updateMany({
            where: { id: wallet.id, version: wallet.version },
            data: {
              availableBalance: { increment: amount },
              version: { increment: 1 },
            },
          })
          if (updatedWallet.count !== 1) throw new DepositCreditRaceError()
          const updatedAttempt = await tx.depositAttempt.updateMany({
            where: {
              id: attempt.id,
              walletId: attempt.walletId,
              provider: "stripe",
              providerSessionId: input.facts.providerSessionId,
              amount,
              walletCredit: amount,
              customerFee: "0.00",
              currency: "USD",
              ledgerTransactionId: null,
              status: {
                in: [
                  "CREATED",
                  "PENDING_CUSTOMER_ACTION",
                  "PROCESSING",
                  "FAILED",
                  "EXPIRED",
                ],
              },
            },
            data: {
              status: "SUCCEEDED",
              providerPaymentId: input.facts.providerPaymentId,
              providerChargeId: input.facts.providerChargeId,
              ledgerTransactionId: ledger.id,
              completedAt: new Date(),
              failedAt: null,
              failureCode: null,
            },
          })
          if (updatedAttempt.count !== 1) throw new DepositCreditRaceError()
          await completeAuthority(tx, input.authority, attempt.id)
          await hooks.audit(tx, {
            action: "WALLET_DEPOSIT",
            entityType: "Wallet",
            entityId: attempt.walletId,
            metadata: {
              amount,
              reference: attempt.publicReference,
              providerSessionId: input.facts.providerSessionId,
              method: "stripe",
              evidenceSource: input.facts.source,
            },
            userId: attempt.createdByUserId,
            organizationId: attempt.organizationId,
          })
          const communicationEventIds = await hooks.recordSuccess(tx, {
            depositAttemptId: attempt.id,
            walletId: attempt.walletId,
            organizationId: attempt.organizationId,
            createdByUserId: attempt.createdByUserId,
            amount,
            currency: "USD",
          })
          return {
            depositAttemptId: attempt.id,
            walletId: attempt.walletId,
            ledgerTransactionId: ledger.id,
            credited: true,
            communicationEventIds,
          }
        },
        { isolationLevel: "Serializable" },
      )
    } catch (error) {
      if (error instanceof DepositCreditFinalizationError) throw error
      if (
        error instanceof DepositCreditRaceError ||
        isPrismaUniqueConstraintError(error) ||
        isRetryablePrismaTransactionError(error)
      ) {
        lastRace = error
        if (transactionAttempt + 1 < MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              prismaTransactionRetryDelayMs(transactionAttempt),
            ),
          )
          continue
        }
      }
      throw error
    }
  }
  void lastRace
  throw new DepositCreditFinalizationError("CONCURRENT_CHANGE", true)
}

function sessionId(value: unknown): string {
  const id =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>).id
        : null
  return requiredString(id)
}

function optionalMetadata(metadata: any, key: string): string | null {
  const value = metadata?.[key]
  if (value == null || value === "") return null
  return requiredString(value, key === "publicReference" ? 32 : 191)
}

export function depositCreditFactsFromSignedCheckoutSession(
  session: any,
  eventLivemode: boolean,
): NormalizedDepositCreditFacts {
  const amount = session?.amount_total
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_PROVIDER_EVIDENCE_CONTRADICTION",
      false,
    )
  }
  if (
    typeof eventLivemode !== "boolean" ||
    (typeof session?.livemode === "boolean" &&
      session.livemode !== eventLivemode)
  ) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_PROVIDER_EVIDENCE_CONTRADICTION",
      false,
    )
  }
  return {
    source: "SIGNED_WEBHOOK",
    provider: "stripe",
    providerSessionId: sessionId(session?.id),
    providerPaymentId: sessionId(session?.payment_intent),
    providerChargeId: null,
    clientReferenceId: requiredString(session?.client_reference_id),
    checkoutStatus: requiredString(session?.status, 64),
    checkoutPaymentStatus: requiredString(session?.payment_status, 64),
    checkoutMode: requiredString(session?.mode, 32),
    checkoutAmountTotalMinor: BigInt(amount),
    checkoutCurrency: requiredString(session?.currency, 3),
    checkoutLivemode: eventLivemode,
    checkoutMetadataAttemptId: requiredString(
      session?.metadata?.depositAttemptId,
    ),
    checkoutMetadataReference: requiredString(
      session?.metadata?.publicReference,
      32,
    ),
    checkoutMetadataWalletId: requiredString(session?.metadata?.walletId),
    checkoutMetadataUserId: requiredString(session?.metadata?.userId),
    checkoutMetadataOrgId: optionalMetadata(
      session?.metadata,
      "organizationId",
    ),
    paymentIntentStatus: null,
    paymentIntentAmountMinor: null,
    paymentIntentReceivedMinor: null,
    paymentIntentCurrency: null,
    paymentIntentLivemode: null,
    paymentMetadataAttemptId: null,
    paymentMetadataReference: null,
    paymentMetadataWalletId: null,
    chargePaid: null,
    chargeCaptured: null,
    chargeRefunded: null,
    chargeAmountMinor: null,
    chargeAmountCapturedMinor: null,
    chargeCurrency: null,
    chargeLivemode: null,
  }
}

export function depositCreditFactsFromRecoveryEvidence(
  evidence: StripeDepositRecoveryEvidence,
): NormalizedDepositCreditFacts {
  return recoveryEvidenceToFacts(evidence)
}

// Validate every authenticated observation against the server-owned command
// before deciding whether it is paid, still pending, or definitively unpaid.
// Contradictory unpaid evidence must be quarantined just like paid evidence;
// it must not be allowed to expire the wrong attempt.
export function assertDepositRecoveryEvidenceMatchesAttempt(
  attempt: any,
  evidence: StripeDepositRecoveryEvidence,
): void {
  const organizationId = evidence.checkoutMetadataOrgId || null
  if (
    evidence.provider !== "stripe" ||
    evidence.providerSessionId !== attempt.providerSessionId ||
    evidence.clientReferenceId !== attempt.id ||
    evidence.checkoutMode !== "payment" ||
    !["open", "complete", "expired"].includes(evidence.checkoutStatus ?? "") ||
    !["paid", "unpaid"].includes(evidence.checkoutPaymentStatus ?? "") ||
    evidence.checkoutAmountTotalMinor == null ||
    evidence.checkoutAmountTotalMinor <= 0n ||
    evidence.checkoutCurrency !== "usd" ||
    evidence.checkoutMetadataAttemptId !== attempt.id ||
    evidence.checkoutMetadataReference !== attempt.publicReference ||
    evidence.checkoutMetadataWalletId !== attempt.walletId ||
    evidence.checkoutMetadataUserId !== attempt.createdByUserId ||
    organizationId !== (attempt.organizationId ?? null) ||
    attempt.provider !== "stripe" ||
    attempt.currency !== "USD" ||
    decimalToMinor(attempt.amount) !== evidence.checkoutAmountTotalMinor ||
    decimalToMinor(attempt.walletCredit) !==
      evidence.checkoutAmountTotalMinor ||
    decimalToMinor(attempt.customerFee) !== 0n ||
    (attempt.providerPaymentId != null &&
      attempt.providerPaymentId !== evidence.providerPaymentId) ||
    (attempt.providerChargeId != null &&
      attempt.providerChargeId !== evidence.providerChargeId)
  ) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_ATTEMPT_EVIDENCE_MISMATCH",
      false,
    )
  }
  if (
    evidence.providerPaymentId != null &&
    (!evidence.paymentIntentStatus ||
      evidence.paymentIntentAmountMinor !== evidence.checkoutAmountTotalMinor ||
      evidence.paymentIntentReceivedMinor == null ||
      evidence.paymentIntentReceivedMinor < 0n ||
      evidence.paymentIntentReceivedMinor > evidence.checkoutAmountTotalMinor ||
      evidence.paymentIntentCurrency !== "usd" ||
      evidence.paymentIntentLivemode !== evidence.checkoutLivemode ||
      evidence.paymentMetadataAttemptId !== attempt.id ||
      evidence.paymentMetadataReference !== attempt.publicReference ||
      evidence.paymentMetadataWalletId !== attempt.walletId)
  ) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_PROVIDER_EVIDENCE_CONTRADICTION",
      false,
    )
  }
  if (
    evidence.providerPaymentId == null &&
    (evidence.paymentIntentStatus != null ||
      evidence.paymentIntentAmountMinor != null ||
      evidence.paymentIntentReceivedMinor != null ||
      evidence.paymentIntentCurrency != null ||
      evidence.paymentIntentLivemode != null ||
      evidence.paymentMetadataAttemptId != null ||
      evidence.paymentMetadataReference != null ||
      evidence.paymentMetadataWalletId != null ||
      evidence.providerChargeId != null)
  ) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_PROVIDER_EVIDENCE_CONTRADICTION",
      false,
    )
  }
  if (
    evidence.providerChargeId != null &&
    (evidence.chargePaid == null ||
      evidence.chargeCaptured == null ||
      evidence.chargeRefunded == null ||
      evidence.chargeAmountMinor !== evidence.checkoutAmountTotalMinor ||
      evidence.chargeAmountCapturedMinor == null ||
      evidence.chargeAmountCapturedMinor > evidence.checkoutAmountTotalMinor ||
      evidence.chargeCurrency !== "usd" ||
      evidence.chargeLivemode !== evidence.checkoutLivemode)
  ) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_PROVIDER_EVIDENCE_CONTRADICTION",
      false,
    )
  }
  if (
    evidence.providerChargeId == null &&
    (evidence.chargePaid != null ||
      evidence.chargeCaptured != null ||
      evidence.chargeRefunded != null ||
      evidence.chargeAmountMinor != null ||
      evidence.chargeAmountCapturedMinor != null ||
      evidence.chargeCurrency != null ||
      evidence.chargeLivemode != null)
  ) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_PROVIDER_EVIDENCE_CONTRADICTION",
      false,
    )
  }
  if (
    evidence.checkoutPaymentStatus !== "paid" &&
    (evidence.paymentIntentStatus === "succeeded" ||
      (evidence.paymentIntentReceivedMinor ?? 0n) > 0n ||
      evidence.chargePaid === true ||
      evidence.chargeCaptured === true ||
      (evidence.chargeAmountCapturedMinor ?? 0n) > 0n)
  ) {
    throw new DepositCreditFinalizationError(
      "DEPOSIT_PROVIDER_EVIDENCE_CONTRADICTION",
      false,
    )
  }
}
