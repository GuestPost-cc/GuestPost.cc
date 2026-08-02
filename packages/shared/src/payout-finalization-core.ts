// Server-only canonical payout completion transition.
//
// API provider responses/recovery, worker polling/webhooks, and manual bank
// confirmation all enter here. Keep this module out of the shared browser
// barrel: request-context uses node:async_hooks.

import { getRequestId } from "./observability/request-context"
import { mergePayoutProviderMetadata } from "./payout-provider-metadata"
import {
  isPrismaUniqueConstraintError,
  isRetryablePrismaTransactionError,
  prismaTransactionRetryDelayMs,
} from "./prisma-transaction-retry"
import { assertStripeFinancialObjectMode } from "./stripe-key-mode"

export type PayoutCompletionSource =
  | "PROVIDER_RESPONSE"
  | "PROVIDER_WEBHOOK"
  | "PROVIDER_STATUS_POLL"
  | "MANUAL_BANK_CONFIRMATION"

interface BasePayoutCompletionInput {
  executionId: string
  withdrawalId: string
  providerName: string
  providerReference: string
  source: PayoutCompletionSource
  metadata?: Record<string, unknown>
  fee?: unknown
}

export interface ProviderPayoutCompletionInput
  extends BasePayoutCompletionInput {
  source: "PROVIDER_RESPONSE" | "PROVIDER_STATUS_POLL"
  evidenceAt: Date
  providerAmountMinor?: number | bigint | string
  providerCurrency?: string
}

export interface WebhookPayoutCompletionInput
  extends BasePayoutCompletionInput {
  source: "PROVIDER_WEBHOOK"
  webhookEventId: string
  webhookClaimAttempt: number
  webhookClaimLockedAt: Date
}

export interface ManualPayoutCompletionInput extends BasePayoutCompletionInput {
  source: "MANUAL_BANK_CONFIRMATION"
  withdrawalPublicReference: string
  evidenceAt: Date
  actorUserId: string
  reason: string
}

export type PayoutCompletionInput =
  | ProviderPayoutCompletionInput
  | WebhookPayoutCompletionInput
  | ManualPayoutCompletionInput

export type PayoutFinalizationConflictCode =
  | "EXECUTION_NOT_FOUND"
  | "WITHDRAWAL_NOT_FOUND"
  | "WITHDRAWAL_REFERENCE_MISMATCH"
  | "EXECUTION_WITHDRAWAL_MISMATCH"
  | "INVALID_LOCAL_STATE"
  | "CANCELLATION_IN_PROGRESS"
  | "PROVIDER_MISMATCH"
  | "PROVIDER_MODE_MISMATCH"
  | "PROVIDER_REFERENCE_MISMATCH"
  | "INVALID_PROVIDER_STAGE"
  | "AMOUNT_CURRENCY_MISMATCH"
  | "RESERVATION_MISMATCH"
  | "COMPETING_EXECUTION"
  | "EVIDENCE_ALREADY_USED"
  | "WEBHOOK_EVIDENCE_MISMATCH"
  | "WEBHOOK_LEASE_LOST"
  | "PROVIDER_AMOUNT_CURRENCY_MISMATCH"
  | "MANUAL_EVIDENCE_INVALID"
  | "MANUAL_ACTOR_UNAUTHORIZED"
  | "MAKER_CHECKER_VIOLATION"
  | "COMPLETION_EVIDENCE_CONFLICT"
  | "COMPLETION_STATE_MISMATCH"

export type PayoutFinalizationResult =
  | {
      kind: "completed" | "replayed" | "corroborated"
      executionId: string
      withdrawalId: string
      applied: boolean
    }
  | {
      kind: "conflict"
      executionId: string
      withdrawalId: string
      applied: false
      code: PayoutFinalizationConflictCode
      message: string
    }

type AnyPrisma = any
type AnyTx = any

const SERIALIZABLE_ATTEMPTS = 7
const MANUAL_CLOCK_TOLERANCE_MS = 5 * 60 * 1000
const ACTIVE_EXECUTION_STATUSES = ["PENDING", "PROCESSING"]

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizedCurrency(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
}

function normalizedEvidenceReference(
  source: PayoutCompletionSource,
  value: unknown,
): string {
  const trimmed = String(value ?? "").trim()
  return source === "MANUAL_BANK_CONFIRMATION"
    ? trimmed.replace(/\s+/g, " ").toUpperCase()
    : trimmed
}

function persistedManualReason(execution: any): string | null {
  if (!isRecord(execution.providerMetadata)) return null
  const completion = execution.providerMetadata.completion
  if (!isRecord(completion) || typeof completion.reason !== "string") {
    return null
  }
  return completion.reason.trim()
}

const MONEY_SCALE = 30

function scaledDecimal(value: unknown): bigint {
  const raw = String(value ?? "0").trim()
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw)
  if (!match) throw new Error(`Invalid decimal value: ${raw}`)
  const negative = match[1] === "-"
  const whole = match[2].replace(/^0+(?=\d)/, "")
  const fraction = (match[3] ?? "")
    .padEnd(MONEY_SCALE, "0")
    .slice(0, MONEY_SCALE)
  const scaled =
    BigInt(whole || "0") * 10n ** BigInt(MONEY_SCALE) + BigInt(fraction || "0")
  return negative ? -scaled : scaled
}

function decimalsEqual(left: unknown, right: unknown): boolean {
  try {
    return scaledDecimal(left) === scaledDecimal(right)
  } catch {
    return false
  }
}

function normalizedMinorAmount(value: unknown): bigint | null {
  if (typeof value === "bigint" && value > 0n) return value
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value)
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return BigInt(value)
  }
  return null
}

function decimalMinorAmount(value: unknown, currency: unknown): bigint | null {
  // Every currently certified payout route is USD. New currencies must add a
  // reviewed ISO-4217 exponent before they can release liability.
  if (normalizedCurrency(currency) !== "USD") return null
  try {
    const scaled = scaledDecimal(value)
    const factor = 10n ** BigInt(MONEY_SCALE - 2)
    if (scaled <= 0n || scaled % factor !== 0n) return null
    return scaled / factor
  } catch {
    return null
  }
}

function safeMetadata(
  existing: unknown,
  incoming: Record<string, unknown> | undefined,
  completion: Record<string, unknown>,
) {
  return {
    ...mergePayoutProviderMetadata(existing, incoming),
    completion,
  }
}

async function updateWebhookTerminalState(
  tx: AnyTx,
  input: PayoutCompletionInput,
  status: "PROCESSED" | "IGNORED" | "QUARANTINED",
  now: Date,
  lastError: string | null,
): Promise<boolean> {
  if (input.source !== "PROVIDER_WEBHOOK") return true
  const updated = await tx.payoutWebhookEvent.updateMany({
    where: {
      id: input.webhookEventId,
      status: "PROCESSING",
      attempts: input.webhookClaimAttempt,
      lockedAt: input.webhookClaimLockedAt,
    },
    data: {
      status,
      lockedAt: null,
      processedAt: now,
      lastError,
    },
  })
  return updated.count === 1
}

function webhookLeaseLost(
  input: PayoutCompletionInput,
): PayoutFinalizationResult {
  return {
    kind: "conflict",
    executionId: input.executionId,
    withdrawalId: input.withdrawalId,
    applied: false,
    code: "WEBHOOK_LEASE_LOST",
    message:
      "Payout webhook processing lease changed; the stale claimant cannot mutate financial state",
  }
}

async function audit(
  tx: AnyTx,
  params: {
    action: string
    executionId: string
    organizationId?: string | null
    userId?: string | null
    metadata: Record<string, unknown>
  },
) {
  const requestId = getRequestId()
  const metadata = requestId
    ? { ...params.metadata, requestId }
    : params.metadata
  await tx.auditLog.create({
    data: {
      action: params.action,
      entityType: "PayoutExecution",
      entityId: params.executionId,
      metadata,
      requestId,
      userId: params.userId ?? null,
      organizationId: params.organizationId ?? null,
    },
  })
}

async function deterministicConflict(
  tx: AnyTx,
  input: PayoutCompletionInput,
  code: PayoutFinalizationConflictCode,
  message: string,
  execution?: any,
): Promise<PayoutFinalizationResult> {
  const now = new Date()
  const webhookConflict = input.source === "PROVIDER_WEBHOOK"
  const terminalized = await updateWebhookTerminalState(
    tx,
    input,
    webhookConflict ? "QUARANTINED" : "IGNORED",
    now,
    code,
  )
  if (!terminalized) return webhookLeaseLost(input)
  if (webhookConflict) {
    const staff = await tx.staffMembership.findMany({
      where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
      select: { userId: true },
    })
    if (staff.length > 0) {
      await tx.notification.createMany({
        data: staff.map((member: { userId: string }) => ({
          userId: member.userId,
          organizationId: null,
          type: "PAYOUT_WEBHOOK_QUARANTINED",
          message: `Critical payout webhook conflict for execution ${input.executionId}: ${code}`,
          dedupKey: `payout-webhook-quarantine:${input.webhookEventId}:${code}:${member.userId}`,
        })),
        skipDuplicates: true,
      })
    }
  }
  await audit(tx, {
    action: webhookConflict
      ? "PAYOUT_COMPLETION_EVIDENCE_QUARANTINED"
      : "PAYOUT_COMPLETION_EVIDENCE_CONFLICT",
    executionId: input.executionId,
    organizationId: execution?.withdrawal?.publisher?.organizationId ?? null,
    userId:
      input.source === "MANUAL_BANK_CONFIRMATION" ? input.actorUserId : null,
    metadata: {
      withdrawalId: input.withdrawalId,
      source: input.source,
      provider: input.providerName,
      providerReference: input.providerReference,
      code,
      message,
      ...(input.source === "PROVIDER_WEBHOOK"
        ? { payoutWebhookEventId: input.webhookEventId }
        : {}),
    },
  })
  return {
    kind: "conflict",
    executionId: input.executionId,
    withdrawalId: input.withdrawalId,
    applied: false,
    code,
    message,
  }
}

function providerReferenceForExecution(execution: any): string | null {
  if (execution.provider?.name === "stripe_connect") {
    return execution.providerPayoutId ?? null
  }
  return execution.providerPayoutId ?? execution.providerExecutionId ?? null
}

function destinationProviderAccountId(execution: any): string | null {
  if (!isRecord(execution.providerMetadata)) return null
  const destination = execution.providerMetadata.destinationSnapshot
  if (!isRecord(destination)) return null
  return typeof destination.providerAccountExternalId === "string" &&
    destination.providerAccountExternalId.length > 0
    ? destination.providerAccountExternalId
    : null
}

function completedWebhookEnvelopeMatches(
  execution: any,
  webhookEvent: any,
): boolean {
  if (execution.provider.name === "stripe_connect") {
    const expectedAccountId = destinationProviderAccountId(execution)
    return (
      webhookEvent.eventType === "payout.paid" &&
      Boolean(expectedAccountId) &&
      webhookEvent.providerAccountExternalId === expectedAccountId &&
      webhookEvent.livemode === execution.livemode
    )
  }
  if (execution.provider.name === "wise") {
    return (
      webhookEvent.eventType === "transfers#state-change" &&
      webhookEvent.providerAccountExternalId === null &&
      webhookEvent.livemode === null &&
      execution.livemode === null
    )
  }
  return false
}

function validateStage(execution: any, input: PayoutCompletionInput): boolean {
  if (execution.stage === "CANCEL_REQUESTED") return false
  if (input.source === "MANUAL_BANK_CONFIRMATION") {
    return execution.stage === "PROVIDER_SENT"
  }
  if (input.providerName === "stripe_connect") {
    return [
      "BANK_PAID",
      "BANK_PAYOUT_CREATED",
      "BANK_PAYOUT_PENDING",
      "BANK_PAYOUT_RECOVERY_REQUIRED",
      "PROVIDER_COMPLETION_RECOVERY_REQUIRED",
    ].includes(execution.stage)
  }
  return [
    "PROVIDER_SENT",
    "PROVIDER_OUTCOME_UNKNOWN",
    "PROVIDER_COMPLETION_RECOVERY_REQUIRED",
  ].includes(execution.stage)
}

async function lockAndOwnWebhookLease(
  tx: AnyTx,
  input: PayoutCompletionInput,
): Promise<boolean> {
  if (input.source !== "PROVIDER_WEBHOOK") return true

  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "PayoutWebhookEvent" WHERE "id" = $1 FOR UPDATE',
    input.webhookEventId,
  )
  const event = await tx.payoutWebhookEvent.findUnique({
    where: { id: input.webhookEventId },
    select: {
      status: true,
      attempts: true,
      lockedAt: true,
    },
  })
  const expectedLockedAt = input.webhookClaimLockedAt
  const observedLockedAt =
    event?.lockedAt instanceof Date ? event.lockedAt : null
  return (
    event?.status === "PROCESSING" &&
    Number.isSafeInteger(input.webhookClaimAttempt) &&
    input.webhookClaimAttempt > 0 &&
    expectedLockedAt instanceof Date &&
    Number.isFinite(expectedLockedAt.getTime()) &&
    event.attempts === input.webhookClaimAttempt &&
    observedLockedAt?.getTime() === expectedLockedAt.getTime()
  )
}

async function loadAndLock(
  tx: AnyTx,
  input: PayoutCompletionInput,
): Promise<{
  execution: any | null
  withdrawalExists: boolean
  webhookLeaseOwned: boolean
}> {
  if (!(await lockAndOwnWebhookLease(tx, input))) {
    return {
      execution: null,
      withdrawalExists: false,
      webhookLeaseOwned: false,
    }
  }
  const withdrawalRows = await tx.$queryRawUnsafe(
    'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
    input.withdrawalId,
  )
  if (!Array.isArray(withdrawalRows) || withdrawalRows.length === 0) {
    return {
      execution: null,
      withdrawalExists: false,
      webhookLeaseOwned: true,
    }
  }
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
    input.executionId,
  )
  const execution = await tx.payoutExecution.findUnique({
    where: { id: input.executionId },
    include: {
      provider: { select: { id: true, name: true } },
      withdrawal: {
        include: {
          publisher: { select: { organizationId: true } },
          allocations: {
            select: { amount: true, currency: true, releasedAt: true },
          },
        },
      },
    },
  })
  return { execution, withdrawalExists: true, webhookLeaseOwned: true }
}

async function finalizeInTransaction(
  tx: AnyTx,
  input: PayoutCompletionInput,
): Promise<PayoutFinalizationResult> {
  const evidenceReference = normalizedEvidenceReference(
    input.source,
    input.providerReference,
  )
  const loaded = await loadAndLock(tx, input)
  if (!loaded.webhookLeaseOwned) {
    return webhookLeaseLost(input)
  }
  if (!loaded.withdrawalExists) {
    return deterministicConflict(
      tx,
      input,
      "WITHDRAWAL_NOT_FOUND",
      "Withdrawal does not exist",
    )
  }
  const execution = loaded.execution
  if (!execution) {
    return deterministicConflict(
      tx,
      input,
      "EXECUTION_NOT_FOUND",
      "Payout execution does not exist",
    )
  }
  const withdrawal = execution.withdrawal
  if (execution.withdrawalId !== input.withdrawalId) {
    return deterministicConflict(
      tx,
      input,
      "EXECUTION_WITHDRAWAL_MISMATCH",
      "Execution does not belong to the requested withdrawal",
      execution,
    )
  }
  if (
    input.source === "MANUAL_BANK_CONFIRMATION" &&
    (!withdrawal.publicReference ||
      input.withdrawalPublicReference !== withdrawal.publicReference)
  ) {
    return deterministicConflict(
      tx,
      input,
      "WITHDRAWAL_REFERENCE_MISMATCH",
      "Manual completion confirmation does not match the locked withdrawal reference",
      execution,
    )
  }
  if (execution.provider.name !== input.providerName) {
    return deterministicConflict(
      tx,
      input,
      "PROVIDER_MISMATCH",
      "Completion provider does not match the persisted execution provider",
      execution,
    )
  }
  if (execution.provider.name === "stripe_connect") {
    try {
      assertStripeFinancialObjectMode(execution.livemode, {
        secretKey: process.env.STRIPE_SECRET_KEY,
        liveModeEnabled: process.env.STRIPE_LIVE_MODE_ENABLED,
      })
    } catch {
      return deterministicConflict(
        tx,
        input,
        "PROVIDER_MODE_MISMATCH",
        "Stripe payout execution mode does not match the current credential and live-money gate",
        execution,
      )
    }
  } else if (execution.livemode !== null) {
    return deterministicConflict(
      tx,
      input,
      "PROVIDER_MODE_MISMATCH",
      "Non-Stripe payout execution contains unexpected Stripe mode evidence",
      execution,
    )
  }

  let webhookEvent: any = null
  let evidenceAt = input.source === "PROVIDER_WEBHOOK" ? null : input.evidenceAt
  let providerAmountMinor: bigint | null =
    input.source === "PROVIDER_RESPONSE" ||
    input.source === "PROVIDER_STATUS_POLL"
      ? normalizedMinorAmount(input.providerAmountMinor)
      : null
  let providerCurrency: string | null =
    input.source === "PROVIDER_RESPONSE" ||
    input.source === "PROVIDER_STATUS_POLL"
      ? normalizedCurrency(input.providerCurrency) || null
      : null
  if (input.source === "PROVIDER_WEBHOOK") {
    webhookEvent = await tx.payoutWebhookEvent.findUnique({
      where: { id: input.webhookEventId },
    })
    if (
      !webhookEvent ||
      webhookEvent.provider !== input.providerName ||
      webhookEvent.providerStatus !== "COMPLETED" ||
      webhookEvent.providerExecutionId !== evidenceReference ||
      !completedWebhookEnvelopeMatches(execution, webhookEvent) ||
      !["PROCESSING", "PROCESSED"].includes(webhookEvent.status)
    ) {
      return deterministicConflict(
        tx,
        input,
        "WEBHOOK_EVIDENCE_MISMATCH",
        "Verified webhook evidence does not match this payout completion",
        execution,
      )
    }
    evidenceAt = webhookEvent.receivedAt
    providerAmountMinor = normalizedMinorAmount(webhookEvent.payoutAmountMinor)
    // The signed webhook parser already normalizes at the external boundary;
    // persisted inbox currency is immutable internal evidence and must never
    // be repaired here by trim/uppercase.
    providerCurrency =
      typeof webhookEvent.payoutCurrency === "string"
        ? webhookEvent.payoutCurrency
        : null
  }

  if (!(evidenceAt instanceof Date) || !Number.isFinite(evidenceAt.getTime())) {
    return deterministicConflict(
      tx,
      input,
      input.source === "MANUAL_BANK_CONFIRMATION"
        ? "MANUAL_EVIDENCE_INVALID"
        : "COMPLETION_EVIDENCE_CONFLICT",
      "Completion evidence timestamp is invalid",
      execution,
    )
  }
  if (
    input.source !== "PROVIDER_WEBHOOK" &&
    evidenceAt.getTime() > Date.now() + MANUAL_CLOCK_TOLERANCE_MS
  ) {
    return deterministicConflict(
      tx,
      input,
      input.source === "MANUAL_BANK_CONFIRMATION"
        ? "MANUAL_EVIDENCE_INVALID"
        : "COMPLETION_EVIDENCE_CONFLICT",
      "Completion evidence timestamp is implausibly in the future",
      execution,
    )
  }

  if (input.source === "MANUAL_BANK_CONFIRMATION") {
    const eligibleActor = await tx.staffMembership.findFirst({
      where: {
        userId: input.actorUserId,
        role: { in: ["FINANCE", "SUPER_ADMIN"] },
        user: { userType: "STAFF", banned: false },
      },
      select: { id: true },
    })
    if (!eligibleActor) {
      return deterministicConflict(
        tx,
        input,
        "MANUAL_ACTOR_UNAUTHORIZED",
        "Manual payout confirmation requires a current unbanned Finance or Super Admin staff member",
        execution,
      )
    }
  }

  const persistedProviderReference = providerReferenceForExecution(execution)
  if (input.source !== "MANUAL_BANK_CONFIRMATION") {
    if (
      !persistedProviderReference ||
      persistedProviderReference !== evidenceReference
    ) {
      return deterministicConflict(
        tx,
        input,
        "PROVIDER_REFERENCE_MISMATCH",
        "Terminal evidence does not match the persisted provider object",
        execution,
      )
    }
    if (
      input.providerName === "stripe_connect" &&
      (!execution.providerPayoutId ||
        !evidenceReference.startsWith("po_") ||
        evidenceReference === execution.providerTransferId)
    ) {
      return deterministicConflict(
        tx,
        input,
        "PROVIDER_REFERENCE_MISMATCH",
        "Stripe completion requires the persisted bank Payout ID, never a Transfer ID",
        execution,
      )
    }
    const expectedMinorAmount = decimalMinorAmount(
      execution.destinationAmount ?? execution.amount,
      execution.destinationCurrency,
    )
    if (
      expectedMinorAmount === null ||
      providerAmountMinor !== expectedMinorAmount ||
      providerCurrency !== execution.destinationCurrency
    ) {
      return deterministicConflict(
        tx,
        input,
        "PROVIDER_AMOUNT_CURRENCY_MISMATCH",
        "Provider payout amount or currency does not match the immutable execution destination",
        execution,
      )
    }
  }

  if (execution.status === "COMPLETED") {
    if (withdrawal.status !== "COMPLETED") {
      return deterministicConflict(
        tx,
        input,
        "COMPLETION_STATE_MISMATCH",
        "Execution is completed but its withdrawal is not completed",
        execution,
      )
    }
    const canonicalReference =
      execution.completionEvidenceRef ??
      providerReferenceForExecution(execution) ??
      execution.bankTraceReference
    const sameReference = canonicalReference === evidenceReference
    const sameManualEvidence =
      input.source !== "MANUAL_BANK_CONFIRMATION" ||
      (execution.completionSource === "MANUAL_BANK_CONFIRMATION" &&
        execution.completionActorUserId === input.actorUserId &&
        execution.completionEvidenceAt?.getTime() === evidenceAt.getTime() &&
        persistedManualReason(execution) === input.reason.trim())
    if (!sameReference || !sameManualEvidence) {
      return deterministicConflict(
        tx,
        input,
        "COMPLETION_EVIDENCE_CONFLICT",
        "Payout was already completed from different evidence",
        execution,
      )
    }

    const exactReplay =
      execution.completionSource === input.source &&
      (input.source !== "PROVIDER_WEBHOOK" ||
        execution.completionWebhookEventId === input.webhookEventId)
    const kind = exactReplay ? "replayed" : "corroborated"
    const terminalized = await updateWebhookTerminalState(
      tx,
      input,
      exactReplay ? "PROCESSED" : "IGNORED",
      new Date(),
      exactReplay ? null : "CorroboratesExistingCompletion",
    )
    if (!terminalized) return webhookLeaseLost(input)
    await audit(tx, {
      action:
        kind === "replayed"
          ? "PAYOUT_COMPLETION_REPLAYED"
          : "PAYOUT_COMPLETION_CORROBORATED",
      executionId: execution.id,
      organizationId: withdrawal.publisher.organizationId,
      userId:
        input.source === "MANUAL_BANK_CONFIRMATION" ? input.actorUserId : null,
      metadata: {
        withdrawalId: withdrawal.id,
        source: input.source,
        canonicalSource: execution.completionSource,
        providerReference: evidenceReference,
        ...(input.source === "PROVIDER_WEBHOOK"
          ? {
              payoutWebhookEventId: input.webhookEventId,
              inboxDisposition: exactReplay ? "PROCESSED" : "IGNORED",
            }
          : {}),
      },
    })
    return {
      kind,
      executionId: execution.id,
      withdrawalId: withdrawal.id,
      applied: false,
    }
  }

  if (execution.stage === "CANCEL_REQUESTED") {
    return deterministicConflict(
      tx,
      input,
      "CANCELLATION_IN_PROGRESS",
      "Payout execution is claimed for cancellation",
      execution,
    )
  }
  if (!["PROCESSING", "FAILED"].includes(execution.status)) {
    return deterministicConflict(
      tx,
      input,
      "INVALID_LOCAL_STATE",
      `Execution is ${execution.status}, not completable`,
      execution,
    )
  }
  if (!["PROCESSING", "FAILED"].includes(withdrawal.status)) {
    return deterministicConflict(
      tx,
      input,
      "INVALID_LOCAL_STATE",
      `Withdrawal is ${withdrawal.status}, not completable`,
      execution,
    )
  }
  if (!validateStage(execution, input)) {
    return deterministicConflict(
      tx,
      input,
      "INVALID_PROVIDER_STAGE",
      `Execution stage ${execution.stage} cannot be completed from ${input.source}`,
      execution,
    )
  }

  const expectedDestinationAmount = withdrawal.netAmount ?? withdrawal.amount
  if (
    withdrawal.currency !== "USD" ||
    execution.sourceCurrency !== "USD" ||
    execution.destinationCurrency !== "USD" ||
    !decimalsEqual(execution.amount, withdrawal.amount) ||
    !decimalsEqual(
      execution.destinationAmount ?? execution.amount,
      expectedDestinationAmount,
    ) ||
    normalizedCurrency(execution.sourceCurrency) !==
      normalizedCurrency(withdrawal.currency) ||
    normalizedCurrency(execution.destinationCurrency) !==
      normalizedCurrency(withdrawal.currency)
  ) {
    return deterministicConflict(
      tx,
      input,
      "AMOUNT_CURRENCY_MISMATCH",
      "Execution amount or currency does not match its withdrawal",
      execution,
    )
  }

  const activeAllocations = withdrawal.allocations.filter(
    (allocation: any) => allocation.releasedAt === null,
  )
  const allocationTotal = activeAllocations.reduce(
    (sum: bigint, allocation: any) => sum + scaledDecimal(allocation.amount),
    0n,
  )
  if (
    activeAllocations.length === 0 ||
    allocationTotal !== scaledDecimal(withdrawal.amount) ||
    activeAllocations.some(
      (allocation: any) =>
        allocation.currency !== "USD" ||
        allocation.currency !== withdrawal.currency ||
        scaledDecimal(allocation.amount) <= 0n,
    )
  ) {
    return deterministicConflict(
      tx,
      input,
      "RESERVATION_MISMATCH",
      "Unreleased withdrawal allocations do not exactly cover the payout",
      execution,
    )
  }

  if (input.source === "MANUAL_BANK_CONFIRMATION") {
    const trimmedReason = input.reason.trim()
    if (
      input.providerName !== "manual" ||
      !input.actorUserId ||
      evidenceReference.length < 6 ||
      !withdrawal.approvedAt ||
      !execution.providerExecutionId ||
      evidenceAt.getTime() <
        execution.createdAt.getTime() - MANUAL_CLOCK_TOLERANCE_MS ||
      evidenceAt.getTime() > Date.now() + MANUAL_CLOCK_TOLERANCE_MS ||
      trimmedReason.length < 10 ||
      trimmedReason.length > 2000
    ) {
      return deterministicConflict(
        tx,
        input,
        "MANUAL_EVIDENCE_INVALID",
        "Manual completion requires an existing sent execution and valid bank evidence",
        execution,
      )
    }
    if (
      !withdrawal.requestedBy ||
      !withdrawal.approvedBy ||
      !execution.initiatedByUserId ||
      withdrawal.requestedBy === input.actorUserId ||
      withdrawal.approvedBy === input.actorUserId ||
      execution.initiatedByUserId === input.actorUserId
    ) {
      return deterministicConflict(
        tx,
        input,
        "MAKER_CHECKER_VIOLATION",
        "Manual completion requires known requester, approver, and execution initiator provenance, with the payment checker distinct from each",
        execution,
      )
    }
  } else if (input.providerName === "manual") {
    return deterministicConflict(
      tx,
      input,
      "PROVIDER_MISMATCH",
      "Manual executions cannot be completed from automated provider evidence",
      execution,
    )
  }

  const competingExecution = await tx.payoutExecution.findFirst({
    where: {
      withdrawalId: withdrawal.id,
      id: { not: execution.id },
      status: { in: [...ACTIVE_EXECUTION_STATUSES, "COMPLETED"] },
    },
    select: { id: true, status: true },
  })
  if (competingExecution) {
    return deterministicConflict(
      tx,
      input,
      "COMPETING_EXECUTION",
      "Another execution is active or completed for this withdrawal",
      execution,
    )
  }

  const reusedEvidence = await tx.payoutExecution.findFirst({
    where: {
      providerId: execution.providerId,
      id: { not: execution.id },
      OR: [
        { completionEvidenceRef: evidenceReference },
        ...(input.source === "MANUAL_BANK_CONFIRMATION"
          ? [{ bankTraceReference: evidenceReference }]
          : []),
      ],
    },
    select: { id: true },
  })
  if (reusedEvidence) {
    return deterministicConflict(
      tx,
      input,
      "EVIDENCE_ALREADY_USED",
      "Completion evidence is already attached to another payout",
      execution,
    )
  }

  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "PublisherBalance" WHERE "publisherId" = $1 FOR UPDATE',
    withdrawal.publisherId,
  )
  const balance = await tx.publisherBalance.findUnique({
    where: { publisherId: withdrawal.publisherId },
  })
  if (!balance) {
    throw new Error("Publisher balance missing during payout completion")
  }

  const localNow = new Date()
  const completedAt =
    evidenceAt.getTime() > localNow.getTime() ? evidenceAt : localNow
  const completionMetadata = {
    source: input.source,
    evidenceReference,
    evidenceAt: evidenceAt.toISOString(),
    completedAt: completedAt.toISOString(),
    ...(input.source === "MANUAL_BANK_CONFIRMATION"
      ? {}
      : {
          providerAmountMinor: providerAmountMinor!.toString(),
          providerCurrency,
          livemode: execution.livemode,
        }),
    ...(input.source === "MANUAL_BANK_CONFIRMATION"
      ? {
          actorUserId: input.actorUserId,
          reason: input.reason.trim(),
        }
      : {}),
    ...(input.source === "PROVIDER_WEBHOOK"
      ? {
          payoutWebhookEventId: input.webhookEventId,
          webhookClaimAttempt: input.webhookClaimAttempt,
          webhookClaimLockedAt: input.webhookClaimLockedAt.toISOString(),
        }
      : {}),
  }

  const executionUpdated = await tx.payoutExecution.updateMany({
    where: {
      id: execution.id,
      withdrawalId: withdrawal.id,
      status: execution.status,
      stage: execution.stage,
      version: execution.version,
      completionSource: null,
    },
    data: {
      status: "COMPLETED",
      stage:
        input.source === "MANUAL_BANK_CONFIRMATION"
          ? "MANUAL_CONFIRMED"
          : input.providerName === "stripe_connect"
            ? "BANK_PAID"
            : execution.stage,
      completionSource: input.source,
      completionEvidenceRef: evidenceReference,
      completionEvidenceAt: evidenceAt,
      completedAt,
      completionActorUserId:
        input.source === "MANUAL_BANK_CONFIRMATION" ? input.actorUserId : null,
      completionWebhookEventId:
        input.source === "PROVIDER_WEBHOOK" ? input.webhookEventId : null,
      ...(input.source === "MANUAL_BANK_CONFIRMATION"
        ? {
            bankTraceReference: evidenceReference,
            acceptedReference: evidenceReference,
          }
        : {}),
      ...(input.fee === undefined ? {} : { fee: input.fee }),
      errorMessage: null,
      providerMetadata: safeMetadata(
        execution.providerMetadata,
        input.metadata,
        completionMetadata,
      ),
      version: { increment: 1 },
    },
  })
  if (executionUpdated.count !== 1) {
    throw new Error("Payout execution changed during canonical completion")
  }

  const withdrawalUpdated = await tx.withdrawal.updateMany({
    where: {
      id: withdrawal.id,
      status: withdrawal.status,
      version: withdrawal.version,
    },
    data: { status: "COMPLETED", version: { increment: 1 } },
  })
  if (withdrawalUpdated.count !== 1) {
    throw new Error("Withdrawal changed during canonical completion")
  }

  await tx.publisherBalance.update({
    where: { publisherId: withdrawal.publisherId },
    data: {
      lifetimePaid: { increment: withdrawal.amount },
      version: { increment: 1 },
    },
  })

  const terminalized = await updateWebhookTerminalState(
    tx,
    input,
    "PROCESSED",
    completedAt,
    null,
  )
  if (!terminalized) {
    throw new Error("Payout webhook lease changed during canonical completion")
  }
  await audit(tx, {
    action: "PAYOUT_EXECUTION_COMPLETED",
    executionId: execution.id,
    organizationId: withdrawal.publisher.organizationId,
    userId:
      input.source === "MANUAL_BANK_CONFIRMATION" ? input.actorUserId : null,
    metadata: {
      withdrawalId: withdrawal.id,
      publisherId: withdrawal.publisherId,
      amount: String(withdrawal.amount),
      currency: withdrawal.currency,
      source: input.source,
      provider: input.providerName,
      providerReference: evidenceReference,
      evidenceAt: evidenceAt.toISOString(),
      completedAt: completedAt.toISOString(),
      ...(input.source === "PROVIDER_WEBHOOK"
        ? { payoutWebhookEventId: input.webhookEventId }
        : {}),
    },
  })

  return {
    kind: "completed",
    executionId: execution.id,
    withdrawalId: withdrawal.id,
    applied: true,
  }
}

async function auditUniqueCollision(
  prisma: AnyPrisma,
  input: PayoutCompletionInput,
) {
  try {
    await prisma.$transaction(async (tx: AnyTx) => {
      // The unique violation rolled the original transaction back and released
      // its locks. Revalidate the exact webhook claim before even reading
      // payout rows so a recovered claimant cannot inherit stale forensic side
      // effects from the loser.
      if (!(await lockAndOwnWebhookLease(tx, input))) return
      const execution = await tx.payoutExecution.findUnique({
        where: { id: input.executionId },
        include: {
          withdrawal: {
            include: {
              publisher: { select: { organizationId: true } },
            },
          },
        },
      })
      await deterministicConflict(
        tx,
        input,
        "EVIDENCE_ALREADY_USED",
        "A database uniqueness backstop rejected reused payout evidence or a duplicate completion",
        execution ?? undefined,
      )
    })
  } catch {
    // The financial write already failed closed. Reconciliation will surface
    // the collision even if this secondary forensic audit cannot commit.
  }
}

export async function finalizePayoutExecution(
  prisma: AnyPrisma,
  input: PayoutCompletionInput,
): Promise<PayoutFinalizationResult> {
  for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx: AnyTx) => finalizeInTransaction(tx, input),
        { isolationLevel: "Serializable" },
      )
    } catch (error) {
      if (
        isRetryablePrismaTransactionError(error) &&
        attempt < SERIALIZABLE_ATTEMPTS
      ) {
        await delay(prismaTransactionRetryDelayMs(attempt))
        continue
      }
      if (isPrismaUniqueConstraintError(error)) {
        await auditUniqueCollision(prisma, input)
        return {
          kind: "conflict",
          executionId: input.executionId,
          withdrawalId: input.withdrawalId,
          applied: false,
          code: "EVIDENCE_ALREADY_USED",
          message:
            "Payout completion evidence or completed execution is already in use",
        }
      }
      throw error
    }
  }
  throw new Error("Payout completion serialization retries exhausted")
}
