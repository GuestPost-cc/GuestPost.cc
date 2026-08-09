import { createHash } from "node:crypto"
import {
  assertStripeFinancialObjectMode,
  classifyStripeKeyMode,
  evaluatePayoutMethodEligibility,
  isSupportedMoneyCurrency,
  publisherPayoutStatementDescriptor,
  USD_CURRENCY,
} from "@guestpost/shared"
import { finalizePayoutExecution } from "@guestpost/shared/dist/payout-finalization-core"
import { mergePayoutProviderMetadata } from "@guestpost/shared/dist/payout-provider-metadata"
import {
  isRetryablePrismaTransactionError,
  prismaTransactionRetryDelayMs,
} from "@guestpost/shared/dist/prisma-transaction-retry"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { assertApiFinanceOperationAllowed } from "../../common/finance-runtime-mode"
import { PrismaService } from "../../common/prisma.service"
import { lockPublisherBalanceForUpdate } from "../../common/publisher-balance-lock"
import { AuditService } from "../audit/audit.service"
import { PayoutEncryptionService } from "./payout-encryption.service"
import { currentPayoutMethodRuntime } from "./payout-method-runtime"
import { PayoutProviderService } from "./payout-provider.service"
import { decodePayoutProviderConfig } from "./payout-provider-config"
import {
  type PayoutProviderResponseKind,
  PayoutProviderResponseMismatchError,
} from "./providers/payout-provider.interface"

const SERIALIZABLE_ATTEMPTS = 7
const CLAIM_RECOVERY_MIN_AGE_MS = 15 * 60 * 1000
// Stripe may prune idempotency records after they are at least 24 hours old.
// Stop one hour before that documented floor; an older ambiguity requires a
// provider lookup and human adjudication, never a blind create replay.
const CLAIM_RECOVERY_MAX_AGE_MS = 23 * 60 * 60 * 1000

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function mergeInternalMetadata(
  existing: unknown,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(isRecord(existing) ? existing : {}),
    ...incoming,
  }
}

function immutableProviderAccountId(execution: any): string | null {
  if (!isRecord(execution?.providerMetadata)) return null
  const snapshot = execution.providerMetadata.destinationSnapshot
  if (!isRecord(snapshot)) return null
  return typeof snapshot.providerAccountExternalId === "string" &&
    snapshot.providerAccountExternalId.length > 0
    ? snapshot.providerAccountExternalId
    : null
}

function bankPayoutIdempotencyKey(execution: {
  withdrawalId: string
  idempotencyKey?: string | null
}): string | null {
  const suffix = String(execution.idempotencyKey ?? "").match(/-v(\d+)$/)?.[1]
  return suffix ? `payout-bank-${execution.withdrawalId}-v${suffix}` : null
}

function exactUsdMinorAmount(
  amount: unknown,
  currency: unknown,
): number | null {
  if (!isSupportedMoneyCurrency(currency)) return null
  try {
    const minor = new Decimal(String(amount)).mul(100)
    if (!minor.isInteger() || minor.lessThanOrEqualTo(0)) return null
    const value = minor.toNumber()
    return Number.isSafeInteger(value) ? value : null
  } catch {
    return null
  }
}

function stripeResponseMatchesCommand(
  result: any,
  input: {
    kind: "transfer" | "payout"
    amount: unknown
    currency: unknown
    connectedAccountId: string
    publicReference: string
    livemode: boolean
  },
): boolean {
  const amountMinor = exactUsdMinorAmount(input.amount, input.currency)
  const metadata = isRecord(result?.metadata) ? result.metadata : {}
  const expectedPrefix = input.kind === "transfer" ? "tr_" : "po_"
  const objectId =
    input.kind === "transfer"
      ? (result?.providerTransferId ?? result?.providerExecutionId)
      : result?.providerPayoutId
  return (
    amountMinor !== null &&
    typeof objectId === "string" &&
    objectId.startsWith(expectedPrefix) &&
    result?.providerExecutionId === objectId &&
    result?.providerAmountMinor === amountMinor &&
    result?.providerCurrency === USD_CURRENCY &&
    metadata.connectedAccountId === input.connectedAccountId &&
    metadata.providerAmountMinor === amountMinor &&
    metadata.providerCurrency === USD_CURRENCY &&
    metadata.providerPublicReference === input.publicReference &&
    result?.livemode === input.livemode &&
    metadata.livemode === input.livemode
  )
}

function isUntrustedProviderResponse(
  error: unknown,
): error is PayoutProviderResponseMismatchError {
  return error instanceof PayoutProviderResponseMismatchError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizePayoutOperatorReason(reason: string): string {
  const normalized = typeof reason === "string" ? reason.trim() : ""
  if (normalized.length < 10 || normalized.length > 500) {
    throw new BadRequestException(
      "A payout operator reason between 10 and 500 characters is required",
    )
  }
  return normalized
}

function newPayoutSendsEnabled(): boolean {
  const configured = process.env.PAYOUT_EXECUTION_ENABLED
  if (configured === "true") return true
  if (configured === "false") return false
  return process.env.NODE_ENV !== "production"
}

function currentStripePayoutLivemode(): boolean {
  const keyMode = classifyStripeKeyMode(process.env.STRIPE_SECRET_KEY)
  const livemode =
    keyMode === "live" ? true : keyMode === "test" ? false : undefined
  assertStripeFinancialObjectMode(livemode, {
    secretKey: process.env.STRIPE_SECRET_KEY,
    liveModeEnabled: process.env.STRIPE_LIVE_MODE_ENABLED,
  })
  return livemode!
}

// This is deliberately code-owned and fail-closed. Feature flags may pause a
// certified rail, but they may never certify a money-moving provider.
const CERTIFIED_EXTERNAL_PAYOUT_PROVIDERS = new Set<string>([
  "manual",
  "stripe_connect",
])

function payoutConflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message })
}

function assertCanonicalUsdPayoutCurrency(
  currency: unknown,
  entity: string,
): asserts currency is typeof USD_CURRENCY {
  if (!isSupportedMoneyCurrency(currency)) {
    throw payoutConflict(
      "PAYOUT_CURRENCY_INVALID",
      `${entity} is not denominated in canonical USD`,
    )
  }
}

function assertCurrentPayoutMethodExecutable(
  method: any,
  publisherId: string,
): void {
  const eligibility = evaluatePayoutMethodEligibility(
    {
      publisherId,
      type: method?.type,
      isActive: method?.isActive === true,
      providerAccountId: method?.providerAccountId,
      providerAccount: method?.providerAccount,
    },
    currentPayoutMethodRuntime(),
  )
  if (eligibility.executable) return

  throw new ConflictException({
    code: "PAYOUT_METHOD_NOT_EXECUTABLE",
    eligibilityCode: eligibility.code,
    message: eligibility.message,
  })
}

@Injectable()
export class PayoutExecutionService {
  private readonly logger = new Logger(PayoutExecutionService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly encryption: PayoutEncryptionService,
    private readonly providerService: PayoutProviderService,
  ) {}

  private async runSerializable<T>(work: (tx: any) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, {
          isolationLevel: "Serializable",
        })
      } catch (error) {
        if (
          isRetryablePrismaTransactionError(error) &&
          attempt < SERIALIZABLE_ATTEMPTS
        ) {
          await sleep(prismaTransactionRetryDelayMs(attempt))
          continue
        }
        throw error
      }
    }
    throw new ConflictException("Payout claim serialization retries exhausted")
  }

  private async quarantineUntrustedProviderResponse(params: {
    executionId: string
    withdrawalId: string
    expectedStages: string[]
    expectedVersion: number
    responseKind: PayoutProviderResponseKind
    providerName: string
    userId: string
    organizationId: string
    safeMessage: string
  }): Promise<boolean> {
    return this.runSerializable(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        params.withdrawalId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
        params.executionId,
      )
      const observed = await tx.payoutExecution.findUnique({
        where: { id: params.executionId },
        select: {
          id: true,
          withdrawalId: true,
          status: true,
          stage: true,
          version: true,
        },
      })
      const quarantined = await tx.payoutExecution.updateMany({
        where: {
          id: params.executionId,
          withdrawalId: params.withdrawalId,
          status: "PROCESSING",
          stage: { in: params.expectedStages },
          version: params.expectedVersion,
        },
        data: {
          errorMessage: params.safeMessage,
          version: { increment: 1 },
        },
      })
      const stateMutationApplied = quarantined.count === 1

      const staff = await tx.staffMembership.findMany({
        where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
        select: { userId: true },
      })
      if (staff.length > 0) {
        await tx.notification.createMany({
          data: staff.map((member: { userId: string }) => ({
            userId: member.userId,
            organizationId: params.organizationId,
            type: "PAYOUT_PROVIDER_RESPONSE_QUARANTINED",
            message: `Payout execution ${params.executionId} returned provider evidence that did not match its immutable command; Finance reconciliation is required`,
            dedupKey: `payout-provider-response-quarantine:${params.executionId}:${params.responseKind}:${params.expectedVersion}:${member.userId}`,
          })),
          skipDuplicates: true,
        })
      }
      await this.audit.log(
        {
          action: "PAYOUT_PROVIDER_RESPONSE_QUARANTINED",
          entityType: "PayoutExecution",
          entityId: params.executionId,
          metadata: {
            withdrawalId: params.withdrawalId,
            providerName: params.providerName,
            responseKind: params.responseKind,
            disposition: "UNTRUSTED_NOT_ATTACHED",
            expectedStages: params.expectedStages,
            expectedVersion: params.expectedVersion,
            observedStatus: observed?.status ?? null,
            observedStage: observed?.stage ?? null,
            observedVersion: observed?.version ?? null,
            stateMutationApplied,
          },
          userId: params.userId,
          organizationId: params.organizationId,
        },
        tx,
      )
      return stateMutationApplied
    })
  }

  private async assertEligibleFinanceActor(tx: any, userId: string) {
    const eligibleActor = await tx.staffMembership.findFirst({
      where: {
        userId,
        role: { in: ["FINANCE", "SUPER_ADMIN"] },
        user: { banned: false, userType: "STAFF" },
      },
      select: { id: true },
    })
    if (!eligibleActor) {
      throw payoutConflict(
        "PAYOUT_OPERATOR_INELIGIBLE",
        "Payout operation requires a current unbanned Finance or Super Admin staff member",
      )
    }
  }

  private async recordOperatorIntent(input: {
    action: string
    entityType: "Withdrawal" | "PayoutExecution"
    entityId: string
    userId: string
    organizationId: string
    reason: string
    metadata: Record<string, unknown>
  }) {
    await this.runSerializable(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT sm."id"
           FROM "StaffMembership" sm
           INNER JOIN "User" u ON u."id" = sm."userId"
          WHERE sm."userId" = $1
          FOR UPDATE OF sm, u`,
        input.userId,
      )
      await this.assertEligibleFinanceActor(tx, input.userId)
      await this.audit.log(
        {
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          metadata: {
            ...input.metadata,
            reason: input.reason,
          },
          userId: input.userId,
          organizationId: input.organizationId,
        },
        tx,
      )
    })
  }

  private assertProviderModeForExecution(
    execution: { livemode: boolean | null },
    providerName: string,
  ): void {
    if (providerName === "stripe_connect") {
      try {
        assertStripeFinancialObjectMode(execution.livemode, {
          secretKey: process.env.STRIPE_SECRET_KEY,
          liveModeEnabled: process.env.STRIPE_LIVE_MODE_ENABLED,
        })
      } catch {
        throw payoutConflict(
          "PAYOUT_PROVIDER_MODE_DRIFT",
          "Stripe credential mode changed after this payout execution was created; no external call is allowed",
        )
      }
      return
    }
    if (execution.livemode !== null) {
      throw payoutConflict(
        "PAYOUT_PROVIDER_MODE_INVALID",
        "Non-Stripe payout execution contains unexpected mode evidence",
      )
    }
  }

  private async updateExecutionWithParentLock(params: {
    withdrawalId: string
    executionId: string
    where: Record<string, unknown>
    data: Record<string, unknown>
  }): Promise<{ count: number }> {
    return this.runSerializable(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        params.withdrawalId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 AND "withdrawalId" = $2 FOR UPDATE',
        params.executionId,
        params.withdrawalId,
      )
      return tx.payoutExecution.updateMany({
        where: {
          ...params.where,
          id: params.executionId,
          withdrawalId: params.withdrawalId,
        },
        data: params.data,
      })
    })
  }

  private async claimExternalCall(params: {
    executionId: string
    withdrawalId: string
    publisherId: string
    payoutMethodId: string
    providerAccountRowId: string | null
    providerId: string
    providerName: string
    expectedStages: string[]
    claimedStage: string
    requireAgedClaim: boolean
    claimPurpose: "NEW_SEND" | "EXACT_RECOVERY"
    requireTransferWithoutPayout?: boolean
    userId: string
    auditAction: string
  }) {
    return this.runSerializable(async (tx) => {
      // Global payout lock order remains Withdrawal -> PayoutExecution ->
      // PublisherBalance -> PayoutProvider -> PublisherProviderAccount ->
      // PayoutMethod. Routing rows are held until the external-call claim
      // commits.
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        params.withdrawalId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
        params.executionId,
      )
      const balance = await lockPublisherBalanceForUpdate(
        tx,
        params.publisherId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutProvider" WHERE "id" = $1 FOR UPDATE',
        params.providerId,
      )
      if (params.providerAccountRowId) {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PublisherProviderAccount" WHERE "id" = $1 FOR UPDATE',
          params.providerAccountRowId,
        )
      }
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutMethod" WHERE "id" = $1 FOR UPDATE',
        params.payoutMethodId,
      )

      const fresh = await tx.payoutExecution.findUnique({
        where: { id: params.executionId },
        include: {
          provider: true,
          withdrawal: {
            include: {
              publisher: true,
              payoutMethod: { include: { providerAccount: true } },
              allocations: {
                select: { amount: true, currency: true, releasedAt: true },
              },
            },
          },
        },
      })
      if (
        !fresh ||
        fresh.withdrawalId !== params.withdrawalId ||
        fresh.withdrawal.publisherId !== params.publisherId ||
        fresh.providerId !== params.providerId ||
        fresh.provider.name !== params.providerName ||
        fresh.status !== "PROCESSING" ||
        fresh.withdrawal.status !== "PROCESSING" ||
        !params.expectedStages.includes(fresh.stage)
      ) {
        throw new ConflictException(
          "Payout execution is no longer eligible for this external-call claim",
        )
      }
      this.assertProviderModeForExecution(fresh, params.providerName)
      if (params.claimPurpose === "NEW_SEND") {
        if (params.requireAgedClaim) {
          throw payoutConflict(
            "PAYOUT_NEW_SEND_CLAIM_INVALID",
            "A new payout send cannot use durable-claim recovery semantics",
          )
        }
        // This is the final runtime/routing policy boundary before a durable
        // claim authorizes provider I/O. Exact recovery deliberately skips
        // current rollout switches because it can only replay an immutable
        // claim or continue from a persisted Transfer recovery stage.
        assertCurrentPayoutMethodExecutable(
          fresh.withdrawal.payoutMethod,
          fresh.withdrawal.publisherId,
        )
        if (!newPayoutSendsEnabled()) {
          throw new ConflictException(
            "External payout calls are disabled by the financial safety switch",
          )
        }
      } else if (
        !params.requireAgedClaim &&
        !(
          params.claimedStage === "BANK_PAYOUT_RESUME_CLAIMED" &&
          params.expectedStages.length === 1 &&
          params.expectedStages[0] === "TRANSFER_RECOVERY_REQUIRED"
        )
      ) {
        throw payoutConflict(
          "PAYOUT_RECOVERY_CLAIM_INVALID",
          "Exact payout recovery claims require an existing durable claim or a persisted Transfer recovery stage",
        )
      }
      if (
        params.requireTransferWithoutPayout &&
        (!fresh.providerTransferId || fresh.providerPayoutId)
      ) {
        throw new ConflictException(
          "Stripe bank-payout claim requires one persisted Transfer and no persisted Payout",
        )
      }
      const existingMetadata = isRecord(fresh.providerMetadata)
        ? fresh.providerMetadata
        : {}
      const claimKind =
        params.claimedStage === "PROVIDER_SEND_CLAIMED"
          ? ("PROVIDER_SEND" as const)
          : ("BANK_PAYOUT_SEND" as const)
      const claimFamily =
        claimKind === "PROVIDER_SEND" ? "providerSend" : "bankPayoutSend"
      const existingClaim = await tx.payoutExecutionClaim.findUnique({
        where: {
          executionId_kind: {
            executionId: fresh.id,
            kind: claimKind,
          },
        },
      })
      const callIdempotencyKey =
        claimKind === "PROVIDER_SEND"
          ? typeof fresh.idempotencyKey === "string" &&
            fresh.idempotencyKey.trim().length > 0
            ? fresh.idempotencyKey
            : null
          : bankPayoutIdempotencyKey(fresh)
      const callIdempotencyKeyFingerprint = callIdempotencyKey
        ? sha256(callIdempotencyKey)
        : null
      const recordedIdempotencyKeyFingerprint =
        typeof existingClaim?.idempotencyKeyFingerprint === "string" &&
        existingClaim.idempotencyKeyFingerprint.length > 0
          ? existingClaim.idempotencyKeyFingerprint
          : null
      const claimOriginAt = existingClaim?.claimedAt ?? fresh.updatedAt
      if (
        params.requireAgedClaim &&
        existingClaim &&
        existingClaim.lastClaimedAt.getTime() >
          Date.now() - CLAIM_RECOVERY_MIN_AGE_MS
      ) {
        throw payoutConflict(
          "PAYOUT_CLAIM_LEASE_ACTIVE",
          "Payout send claim is still leased to another process; retry after reconciliation delay",
        )
      }
      const quarantineClaim = async (input: {
        auditAction: string
        errorMessage: string
        notificationType: string
        reason: string
      }) => {
        const expiredStage =
          claimFamily === "providerSend"
            ? "PROVIDER_SEND_CLAIM_EXPIRED"
            : "BANK_PAYOUT_CLAIM_EXPIRED"
        const expired = await tx.payoutExecution.updateMany({
          where: {
            id: fresh.id,
            status: "PROCESSING",
            stage: fresh.stage,
            version: fresh.version,
          },
          data: {
            stage: expiredStage,
            errorMessage: input.errorMessage,
            version: { increment: 1 },
          },
        })
        if (expired.count !== 1) {
          throw new ConflictException("Payout claim changed during quarantine")
        }
        const staff = await tx.staffMembership.findMany({
          where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
          select: { userId: true },
        })
        if (staff.length > 0) {
          await tx.notification.createMany({
            data: staff.map((member: { userId: string }) => ({
              userId: member.userId,
              organizationId: fresh.withdrawal.publisher.organizationId,
              type: input.notificationType,
              message: `Payout execution ${fresh.id} requires Finance reconciliation before any replay`,
              dedupKey: `payout-claim-quarantine:${fresh.id}:${claimFamily}:${input.reason}:${member.userId}`,
            })),
            skipDuplicates: true,
          })
        }
        await this.audit.log(
          {
            action: input.auditAction,
            entityType: "PayoutExecution",
            entityId: fresh.id,
            metadata: {
              withdrawalId: fresh.withdrawalId,
              claimFamily,
              claimedAt: claimOriginAt.toISOString(),
              quarantinedStage: expiredStage,
              reason: input.reason,
              recordedIdempotencyKeyFingerprint,
              currentIdempotencyKeyFingerprint: callIdempotencyKeyFingerprint,
            },
            userId: params.userId,
            organizationId: fresh.withdrawal.publisher.organizationId,
          },
          tx,
        )
        return {
          kind: "expired" as const,
          executionId: fresh.id,
          claimedAt: claimOriginAt,
        }
      }
      if (
        params.requireAgedClaim &&
        (!existingClaim ||
          existingClaim.idempotencyKey !== callIdempotencyKey ||
          !recordedIdempotencyKeyFingerprint ||
          !callIdempotencyKeyFingerprint ||
          recordedIdempotencyKeyFingerprint !== callIdempotencyKeyFingerprint)
      ) {
        return quarantineClaim({
          auditAction: "PAYOUT_CLAIM_IDENTITY_QUARANTINED",
          errorMessage:
            "Original payout idempotency identity is missing or changed; provider lookup and Finance review are required",
          notificationType: "PAYOUT_CLAIM_IDENTITY_CONFLICT",
          reason: "IDEMPOTENCY_IDENTITY_MISMATCH",
        })
      }
      if (
        params.requireAgedClaim &&
        claimOriginAt.getTime() < Date.now() - CLAIM_RECOVERY_MAX_AGE_MS
      ) {
        return quarantineClaim({
          auditAction: "PAYOUT_CLAIM_RECOVERY_EXPIRED",
          errorMessage:
            "Idempotent replay window expired; provider lookup and Finance review are required",
          notificationType: "PAYOUT_CLAIM_RECOVERY_EXPIRED",
          reason: "SAFE_REPLAY_WINDOW_EXPIRED",
        })
      }
      if (!callIdempotencyKey || !callIdempotencyKeyFingerprint) {
        throw payoutConflict(
          "PAYOUT_CLAIM_IDENTITY_MISSING",
          "Payout idempotency identity is missing; external call is blocked",
        )
      }
      if (!balance) {
        throw new ConflictException(
          "Publisher balance is missing; payout call is blocked",
        )
      }
      assertCanonicalUsdPayoutCurrency(balance.currency, "Publisher balance")
      if (new Decimal(balance.debtBalance ?? 0).greaterThan(0)) {
        throw new ConflictException(
          "Publisher debt changed after payout claim; external call is blocked",
        )
      }
      if (!fresh.withdrawal.requestedBy) {
        throw new ConflictException(
          "Withdrawal requester provenance is missing",
        )
      }
      const eligibleRequester = await tx.publisherMembership.findFirst({
        where: {
          publisherId: fresh.withdrawal.publisherId,
          userId: fresh.withdrawal.requestedBy,
          role: "PUBLISHER_OWNER",
          user: { banned: false, userType: "PUBLISHER" },
        },
        select: { id: true },
      })
      if (!eligibleRequester) {
        throw new ConflictException(
          "The exact withdrawal requester is no longer eligible",
        )
      }
      const eligibleActor = await tx.staffMembership.findFirst({
        where: {
          userId: params.userId,
          role: { in: ["FINANCE", "SUPER_ADMIN"] },
          user: { banned: false, userType: "STAFF" },
        },
        select: { id: true },
      })
      if (!eligibleActor) {
        throw payoutConflict(
          "PAYOUT_OPERATOR_INELIGIBLE",
          "Payout operation requires a current unbanned Finance or Super Admin staff member",
        )
      }
      if (!params.requireAgedClaim && claimKind === "PROVIDER_SEND") {
        if (
          !fresh.withdrawal.approvedBy ||
          fresh.withdrawal.approvedBy === params.userId
        ) {
          throw payoutConflict(
            "PAYOUT_MAKER_CHECKER_VIOLATION",
            "Provider-send claim requires an eligible approver distinct from its actor",
          )
        }
        const eligibleApprover = await tx.staffMembership.findFirst({
          where: {
            userId: fresh.withdrawal.approvedBy,
            role: { in: ["FINANCE", "SUPER_ADMIN"] },
            user: { banned: false, userType: "STAFF" },
          },
          select: { id: true },
        })
        if (!eligibleApprover) {
          throw payoutConflict(
            "PAYOUT_APPROVER_INELIGIBLE",
            "The withdrawal approver is no longer an eligible Finance actor",
          )
        }
      }

      const allocationTotal = fresh.withdrawal.allocations.reduce(
        (sum: Decimal, allocation: any) => sum.plus(allocation.amount),
        new Decimal(0),
      )
      assertCanonicalUsdPayoutCurrency(fresh.withdrawal.currency, "Withdrawal")
      if (
        fresh.withdrawal.allocations.length === 0 ||
        !allocationTotal.equals(new Decimal(fresh.withdrawal.amount)) ||
        fresh.withdrawal.allocations.some(
          (allocation: any) =>
            allocation.releasedAt !== null ||
            !new Decimal(allocation.amount).greaterThan(0) ||
            allocation.currency !== USD_CURRENCY,
        )
      ) {
        throw new ConflictException(
          "Withdrawal reservation changed before external payout call",
        )
      }
      if (
        !new Decimal(fresh.amount).equals(
          new Decimal(fresh.withdrawal.amount),
        ) ||
        !new Decimal(fresh.destinationAmount ?? fresh.amount).equals(
          new Decimal(fresh.withdrawal.netAmount ?? fresh.withdrawal.amount),
        ) ||
        fresh.sourceCurrency !== USD_CURRENCY ||
        fresh.destinationCurrency !== USD_CURRENCY
      ) {
        throw new ConflictException(
          "Payout execution amount or currency changed before external call",
        )
      }

      const metadata = existingMetadata
      const destinationSnapshot = isRecord(metadata.destinationSnapshot)
        ? metadata.destinationSnapshot
        : null
      const providerSnapshot = isRecord(metadata.providerSnapshot)
        ? metadata.providerSnapshot
        : null
      const payoutMethod = fresh.withdrawal.payoutMethod
      const account = payoutMethod?.providerAccount ?? null
      if (
        !destinationSnapshot ||
        !providerSnapshot ||
        !payoutMethod ||
        payoutMethod.id !== params.payoutMethodId ||
        fresh.withdrawal.payoutMethodId !== params.payoutMethodId ||
        payoutMethod.publisherId !== fresh.withdrawal.publisherId ||
        payoutMethod.type !== fresh.withdrawal.method ||
        !payoutMethod.isActive ||
        payoutMethod.version !== destinationSnapshot.payoutMethodVersion ||
        payoutMethod.encryptionKeyVersion !==
          destinationSnapshot.encryptionKeyVersion ||
        sha256({
          details: payoutMethod.details,
          encryptionKeyVersion: payoutMethod.encryptionKeyVersion,
        }) !== destinationSnapshot.encryptedDetailsFingerprint ||
        (account?.id ?? null) !== params.providerAccountRowId ||
        (account?.id ?? null) !==
          (destinationSnapshot.providerAccountRowId ?? null)
      ) {
        throw new ConflictException(
          "Immutable payout destination no longer matches current routing",
        )
      }
      const currentAccountFingerprint = sha256(
        account
          ? {
              id: account.id,
              publisherId: account.publisherId,
              provider: account.provider,
              providerAccountId: account.providerAccountId,
              status: account.status,
              isActive: account.isActive,
              transfersEnabled: account.transfersEnabled,
              payoutsEnabled: account.payoutsEnabled,
              detailsSubmitted: account.detailsSubmitted,
              payoutScheduleConfigured: account.payoutScheduleConfigured,
              defaultCurrency: account.defaultCurrency,
            }
          : null,
      )
      if (
        currentAccountFingerprint !==
          destinationSnapshot.providerAccountFingerprint ||
        (account?.providerAccountId ?? null) !==
          (destinationSnapshot.providerAccountExternalId ?? null)
      ) {
        throw new ConflictException(
          "Provider account changed before external payout call",
        )
      }
      if (
        params.providerName === "stripe_connect" &&
        (!account ||
          account.publisherId !== fresh.withdrawal.publisherId ||
          account.provider !== "stripe_connect" ||
          !account.isActive ||
          account.status !== "ENABLED" ||
          !account.transfersEnabled ||
          !account.payoutsEnabled ||
          !account.detailsSubmitted ||
          !account.payoutScheduleConfigured ||
          account.defaultCurrency !== USD_CURRENCY)
      ) {
        throw new ConflictException(
          "Stripe payout account is no longer fully enabled",
        )
      }
      if (
        !fresh.provider.isActive ||
        fresh.provider.id !== providerSnapshot.providerId ||
        fresh.provider.name !== providerSnapshot.providerName ||
        fresh.provider.version !== providerSnapshot.providerVersion ||
        fresh.provider.configEncryptionKeyVersion !==
          providerSnapshot.configEncryptionKeyVersion ||
        sha256(fresh.provider.config) !== providerSnapshot.configFingerprint
      ) {
        throw new ConflictException(
          "Payout provider configuration changed before external call",
        )
      }

      let recipientDetails: Record<string, unknown>
      if (params.providerName === "stripe_connect") {
        recipientDetails = {
          connectedAccountId: account?.providerAccountId,
          providerAccountStatus: account?.status,
          payoutScheduleConfigured: account?.payoutScheduleConfigured,
          publicReference: fresh.withdrawal.publicReference,
        }
      } else {
        if (typeof payoutMethod.details !== "string") {
          throw new ConflictException(
            "Payout destination ciphertext is invalid",
          )
        }
        recipientDetails = this.encryption.decrypt(
          payoutMethod.details,
          payoutMethod.encryptionKeyVersion,
        )
      }
      if (
        sha256(recipientDetails) !== destinationSnapshot.recipientFingerprint
      ) {
        throw new ConflictException(
          "Decrypted payout recipient does not match the validated snapshot",
        )
      }

      const providerConfig = decodePayoutProviderConfig(
        fresh.provider.config,
        fresh.provider.configEncryptionKeyVersion,
        (ciphertext, version) => this.encryption.decrypt(ciphertext, version),
      )

      const claimedVersion = fresh.version + 1
      const claimedAt = new Date(
        Math.max(Date.now(), (existingClaim?.lastClaimedAt.getTime() ?? 0) + 1),
      )
      if (existingClaim) {
        const replayed = await tx.payoutExecutionClaim.updateMany({
          where: {
            id: existingClaim.id,
            executionId: fresh.id,
            kind: claimKind,
            idempotencyKey: callIdempotencyKey,
            idempotencyKeyFingerprint: callIdempotencyKeyFingerprint,
            lastClaimedAt: existingClaim.lastClaimedAt,
          },
          data: { lastClaimedAt: claimedAt },
        })
        if (replayed.count !== 1) {
          throw payoutConflict(
            "PAYOUT_CLAIM_CHANGED",
            "Payout external-call claim changed during exact-key recovery",
          )
        }
      } else {
        await tx.payoutExecutionClaim.create({
          data: {
            executionId: fresh.id,
            kind: claimKind,
            idempotencyKey: callIdempotencyKey,
            idempotencyKeyFingerprint: callIdempotencyKeyFingerprint,
            claimedAt,
            lastClaimedAt: claimedAt,
            claimedByUserId: params.userId,
          },
        })
      }
      const claimed = await tx.payoutExecution.updateMany({
        where: {
          id: fresh.id,
          status: "PROCESSING",
          stage: fresh.stage,
          version: fresh.version,
        },
        data: {
          stage: params.claimedStage,
          version: { increment: 1 },
        },
      })
      if (claimed.count !== 1) {
        throw new ConflictException(
          "External payout call was claimed by another process",
        )
      }
      await this.audit.log(
        {
          action: params.auditAction,
          entityType: "PayoutExecution",
          entityId: fresh.id,
          metadata: {
            withdrawalId: fresh.withdrawalId,
            fromStage: fresh.stage,
            claimedStage: params.claimedStage,
            claimedVersion,
            idempotencyKeyFingerprint: callIdempotencyKeyFingerprint,
          },
          userId: params.userId,
          organizationId: fresh.withdrawal.publisher.organizationId,
        },
        tx,
      )
      return {
        kind: "claimed" as const,
        execution: {
          ...fresh,
          stage: params.claimedStage,
          version: claimedVersion,
        },
        withdrawal: fresh.withdrawal,
        recipientDetails,
        providerConfig,
        claimedVersion,
      }
    })
  }

  async executeWithdrawal(
    withdrawalId: string,
    requestedProviderName: string,
    userId: string,
    reason: string,
  ) {
    assertApiFinanceOperationAllowed("external_send")
    const operatorReason = normalizePayoutOperatorReason(reason)
    const providerByMethod: Record<string, string | undefined> = {
      bank_transfer: "manual",
      wise: "wise",
      stripe_connect: "stripe_connect",
    }
    const routingWithdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      select: {
        id: true,
        method: true,
        currency: true,
        publicReference: true,
        publisher: { select: { organizationId: true } },
      },
    })
    if (!routingWithdrawal) {
      throw new NotFoundException("Withdrawal not found")
    }
    assertCanonicalUsdPayoutCurrency(routingWithdrawal.currency, "Withdrawal")
    const derivedProvider = providerByMethod[routingWithdrawal.method]
    if (!derivedProvider) {
      throw new BadRequestException(
        `No payout provider is available for ${routingWithdrawal.method} withdrawals`,
      )
    }
    if (requestedProviderName !== derivedProvider) {
      throw new BadRequestException(
        `Provider ${requestedProviderName} is not authorized for ${routingWithdrawal.method} withdrawals`,
      )
    }
    if (!CERTIFIED_EXTERNAL_PAYOUT_PROVIDERS.has(derivedProvider)) {
      throw payoutConflict(
        "PAYOUT_PROVIDER_NOT_CERTIFIED",
        `Provider ${derivedProvider} is not certified for external payout sends`,
      )
    }
    await this.recordOperatorIntent({
      action: "PAYOUT_EXTERNAL_SEND_REQUESTED",
      entityType: "Withdrawal",
      entityId: withdrawalId,
      userId,
      organizationId: routingWithdrawal.publisher.organizationId,
      reason: operatorReason,
      metadata: {
        provider: requestedProviderName,
        publicReference: routingWithdrawal.publicReference,
      },
    })
    const adapter = this.providerService.getAdapter(requestedProviderName)

    const claim = await this.runSerializable(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        withdrawalId,
      )
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
        include: {
          payoutMethod: { include: { providerAccount: true } },
          publisher: true,
          allocations: {
            select: { amount: true, currency: true, releasedAt: true },
          },
        },
      })
      if (!withdrawal) throw new NotFoundException("Withdrawal not found")
      if (!newPayoutSendsEnabled()) {
        throw new ConflictException(
          "New payout sends are disabled by the financial safety switch",
        )
      }
      if (withdrawal.status !== "APPROVED") {
        throw new ConflictException(
          `Withdrawal ${withdrawalId} is ${withdrawal.status}, expected APPROVED`,
        )
      }
      assertCanonicalUsdPayoutCurrency(withdrawal.currency, "Withdrawal")
      if (!withdrawal.approvedBy) {
        throw payoutConflict(
          "PAYOUT_APPROVER_PROVENANCE_MISSING",
          "Withdrawal approval provenance is missing; payout execution is blocked",
        )
      }
      if (withdrawal.approvedBy === userId) {
        throw payoutConflict(
          "PAYOUT_MAKER_CHECKER_VIOLATION",
          "The Finance actor who approved a withdrawal cannot initiate its payout",
        )
      }
      const eligibleFinanceActors = await tx.staffMembership.findMany({
        where: {
          userId: { in: [withdrawal.approvedBy, userId] },
          role: { in: ["FINANCE", "SUPER_ADMIN"] },
          user: { banned: false, userType: "STAFF" },
        },
        select: { userId: true },
      })
      const eligibleFinanceActorIds = new Set(
        eligibleFinanceActors.map((actor: { userId: string }) => actor.userId),
      )
      if (!eligibleFinanceActorIds.has(withdrawal.approvedBy)) {
        throw payoutConflict(
          "PAYOUT_APPROVER_INELIGIBLE",
          "The withdrawal approver is no longer an eligible Finance actor",
        )
      }
      if (!eligibleFinanceActorIds.has(userId)) {
        throw payoutConflict(
          "PAYOUT_INITIATOR_INELIGIBLE",
          "Payout initiation requires a current unbanned Finance or Super Admin staff member",
        )
      }
      if (!withdrawal.requestedBy) {
        throw new ConflictException(
          "Withdrawal requester provenance is missing; finance review is required",
        )
      }
      const eligibleRequester = await tx.publisherMembership.findFirst({
        where: {
          publisherId: withdrawal.publisherId,
          userId: withdrawal.requestedBy,
          role: "PUBLISHER_OWNER",
          user: { banned: false, userType: "PUBLISHER" },
        },
        select: { id: true },
      })
      if (!eligibleRequester) {
        throw new ConflictException(
          "The exact withdrawal requester is no longer an eligible publisher owner",
        )
      }

      const providerName = providerByMethod[withdrawal.method]
      if (!providerName || providerName !== requestedProviderName) {
        throw new BadRequestException(
          `Provider ${requestedProviderName} is not authorized for ${withdrawal.method} withdrawals`,
        )
      }
      if (!CERTIFIED_EXTERNAL_PAYOUT_PROVIDERS.has(providerName)) {
        throw payoutConflict(
          "PAYOUT_PROVIDER_NOT_CERTIFIED",
          `Provider ${providerName} is not certified for external payout sends`,
        )
      }
      if (
        !adapter.capabilities.supportedCurrencies.includes(withdrawal.currency)
      ) {
        throw new BadRequestException(
          `${providerName} does not support ${withdrawal.currency} payouts`,
        )
      }

      const payoutMethod = withdrawal.payoutMethod
      if (
        !payoutMethod?.isActive ||
        payoutMethod.publisherId !== withdrawal.publisherId ||
        payoutMethod.type !== withdrawal.method ||
        payoutMethod.id !== withdrawal.payoutMethodId
      ) {
        throw new BadRequestException(
          "Payout method is missing, inactive, or does not match the withdrawal",
        )
      }
      assertCurrentPayoutMethodExecutable(payoutMethod, withdrawal.publisherId)
      const account = payoutMethod.providerAccount
      const executionLivemode =
        providerName === "stripe_connect" ? currentStripePayoutLivemode() : null

      const currentProvider = await tx.payoutProvider.findUnique({
        where: { name: providerName },
      })
      if (!currentProvider?.isActive) {
        throw new ConflictException("Payout provider is not active")
      }

      const balance = await lockPublisherBalanceForUpdate(
        tx,
        withdrawal.publisherId,
      )
      if (!balance) {
        throw new ConflictException(
          "Publisher balance is missing; payout execution is blocked",
        )
      }
      const currentDebt = new Decimal(balance.debtBalance)
      if (currentDebt.greaterThan(0)) {
        throw new BadRequestException(
          `Publisher has outstanding debt of ${currentDebt.toFixed(2)} — resolve before executing payout`,
        )
      }

      const allocationTotal = withdrawal.allocations.reduce(
        (sum: Decimal, allocation: any) => sum.plus(allocation.amount),
        new Decimal(0),
      )
      const reservationValid =
        withdrawal.allocations.length > 0 &&
        withdrawal.allocations.every(
          (allocation: any) =>
            allocation.releasedAt === null &&
            new Decimal(allocation.amount).greaterThan(0) &&
            allocation.currency === USD_CURRENCY,
        ) &&
        allocationTotal.equals(new Decimal(withdrawal.amount))
      if (!reservationValid) {
        throw new ConflictException(
          "Withdrawal reservation does not exactly cover the payout",
        )
      }

      const competing = await tx.payoutExecution.findFirst({
        where: {
          withdrawalId,
          status: { in: ["PENDING", "PROCESSING", "COMPLETED"] },
        },
        select: { id: true, status: true },
      })
      if (competing) {
        throw new ConflictException(
          "Another payout execution is active or completed for this withdrawal",
        )
      }

      const transitioned = await tx.withdrawal.updateMany({
        where: {
          id: withdrawalId,
          status: "APPROVED",
          version: withdrawal.version,
        },
        data: { status: "PROCESSING", version: { increment: 1 } },
      })
      if (transitioned.count !== 1) {
        throw new ConflictException(
          "Withdrawal changed while the payout was being claimed",
        )
      }
      const withdrawalVersion = withdrawal.version + 1
      const encryptedDetailsFingerprint = sha256({
        details: payoutMethod.details,
        encryptionKeyVersion: payoutMethod.encryptionKeyVersion,
      })
      const destinationSnapshot = {
        payoutMethodId: payoutMethod.id,
        payoutMethodVersion: payoutMethod.version,
        encryptionKeyVersion: payoutMethod.encryptionKeyVersion,
        encryptedDetailsFingerprint,
        providerAccountRowId: account?.id ?? null,
        providerAccountExternalId: account?.providerAccountId ?? null,
        providerAccountProvider: account?.provider ?? null,
        providerAccountFingerprint: sha256(
          account
            ? {
                id: account.id,
                publisherId: account.publisherId,
                provider: account.provider,
                providerAccountId: account.providerAccountId,
                status: account.status,
                isActive: account.isActive,
                transfersEnabled: account.transfersEnabled,
                payoutsEnabled: account.payoutsEnabled,
                detailsSubmitted: account.detailsSubmitted,
                payoutScheduleConfigured: account.payoutScheduleConfigured,
                defaultCurrency: account.defaultCurrency,
              }
            : null,
        ),
        destinationCurrency: USD_CURRENCY,
        recipientFingerprint: null,
      }
      const providerSnapshot = {
        providerId: currentProvider.id,
        providerName: currentProvider.name,
        providerVersion: currentProvider.version,
        configEncryptionKeyVersion: currentProvider.configEncryptionKeyVersion,
        configFingerprint: sha256(currentProvider.config),
      }
      const execution = await tx.payoutExecution.create({
        data: {
          withdrawalId,
          providerId: currentProvider.id,
          status: "PROCESSING",
          amount: withdrawal.amount,
          fee: 0,
          sourceCurrency: USD_CURRENCY,
          destinationCurrency: USD_CURRENCY,
          destinationAmount: withdrawal.netAmount ?? withdrawal.amount,
          requestedReference: withdrawal.publicReference,
          stage: "CREATED",
          idempotencyKey: `payout-${withdrawalId}-v${withdrawalVersion}`,
          livemode: executionLivemode,
          initiatedByUserId: userId,
          providerMetadata: { destinationSnapshot, providerSnapshot },
        },
      })

      await this.audit.log(
        {
          action: "PAYOUT_EXECUTION_STARTED",
          entityType: "PayoutExecution",
          entityId: execution.id,
          metadata: {
            withdrawalId,
            providerName,
            amount: String(withdrawal.amount),
            currency: USD_CURRENCY,
            payoutMethodId: payoutMethod.id,
            payoutMethodVersion: payoutMethod.version,
            providerAccountRowId: account?.id ?? null,
            providerId: currentProvider.id,
            providerVersion: currentProvider.version,
            recipientFingerprintPending: true,
          },
          userId,
          organizationId: withdrawal.publisher.organizationId,
        },
        tx,
      )

      return {
        execution,
        withdrawal,
        payoutMethod,
        account,
        withdrawalVersion,
        destinationSnapshot,
        providerSnapshot,
        providerRecord: currentProvider,
      }
    })

    let recipientDetails: Record<string, unknown>
    let providerConfig: Record<string, unknown>
    try {
      const currentPayoutMethod = await this.prisma.payoutMethod.findUnique({
        where: { id: claim.payoutMethod.id },
        include: { providerAccount: true },
      })
      const currentAccount = currentPayoutMethod?.providerAccount
      if (
        !currentPayoutMethod?.isActive ||
        currentPayoutMethod.publisherId !== claim.withdrawal.publisherId ||
        currentPayoutMethod.type !== claim.withdrawal.method ||
        currentPayoutMethod.version !== claim.payoutMethod.version ||
        currentPayoutMethod.encryptionKeyVersion !==
          claim.payoutMethod.encryptionKeyVersion ||
        sha256({
          details: currentPayoutMethod.details,
          encryptionKeyVersion: currentPayoutMethod.encryptionKeyVersion,
        }) !== claim.destinationSnapshot.encryptedDetailsFingerprint ||
        (claim.account?.id ?? null) !== (currentAccount?.id ?? null) ||
        (claim.account?.providerAccountId ?? null) !==
          (currentAccount?.providerAccountId ?? null) ||
        claim.destinationSnapshot.providerAccountFingerprint !==
          sha256(
            currentAccount
              ? {
                  id: currentAccount.id,
                  publisherId: currentAccount.publisherId,
                  provider: currentAccount.provider,
                  providerAccountId: currentAccount.providerAccountId,
                  status: currentAccount.status,
                  isActive: currentAccount.isActive,
                  transfersEnabled: currentAccount.transfersEnabled,
                  payoutsEnabled: currentAccount.payoutsEnabled,
                  detailsSubmitted: currentAccount.detailsSubmitted,
                  payoutScheduleConfigured:
                    currentAccount.payoutScheduleConfigured,
                  defaultCurrency: currentAccount.defaultCurrency,
                }
              : null,
          ) ||
        (requestedProviderName === "stripe_connect" &&
          (!currentAccount ||
            currentAccount.publisherId !== claim.withdrawal.publisherId ||
            currentAccount.provider !== "stripe_connect" ||
            !currentAccount.isActive ||
            currentAccount.status !== "ENABLED" ||
            !currentAccount.transfersEnabled ||
            !currentAccount.payoutsEnabled ||
            !currentAccount.detailsSubmitted ||
            !currentAccount.payoutScheduleConfigured ||
            currentAccount.defaultCurrency !== USD_CURRENCY))
      ) {
        throw new ConflictException(
          "Payout destination changed after claim; no send was attempted",
        )
      }
      if (requestedProviderName === "stripe_connect") {
        recipientDetails = {
          connectedAccountId: currentAccount?.providerAccountId,
          providerAccountStatus: currentAccount?.status,
          payoutScheduleConfigured: currentAccount?.payoutScheduleConfigured,
          publicReference: claim.withdrawal.publicReference,
        }
      } else {
        if (typeof currentPayoutMethod.details !== "string") {
          throw new Error("Payout destination ciphertext is invalid")
        }
        recipientDetails = this.encryption.decrypt(
          currentPayoutMethod.details,
          currentPayoutMethod.encryptionKeyVersion,
        )
      }
      const recipientFingerprint = sha256(recipientDetails)
      this.assertProviderModeForExecution(
        claim.execution,
        requestedProviderName,
      )
      const validation = await adapter.validateRecipient(recipientDetails)
      if (!validation.valid) {
        throw new BadRequestException(
          validation.error ?? "Payout destination is not ready",
        )
      }

      const destinationValidated = await this.updateExecutionWithParentLock({
        withdrawalId: claim.withdrawal.id,
        executionId: claim.execution.id,
        where: {
          status: "PROCESSING",
          stage: "CREATED",
          version: claim.execution.version,
        },
        data: {
          stage: "DESTINATION_VALIDATED",
          providerMetadata: {
            destinationSnapshot: {
              ...claim.destinationSnapshot,
              recipientFingerprint,
            },
            providerSnapshot: claim.providerSnapshot,
          },
          version: { increment: 1 },
        },
      })
      if (destinationValidated.count !== 1) {
        throw new ConflictException(
          "Payout execution changed before destination validation completed",
        )
      }
      claim.execution.stage = "DESTINATION_VALIDATED"
      claim.execution.version += 1
      claim.execution.providerMetadata = {
        destinationSnapshot: {
          ...claim.destinationSnapshot,
          recipientFingerprint,
        },
        providerSnapshot: claim.providerSnapshot,
      }

      const sendClaim = await this.claimExternalCall({
        executionId: claim.execution.id,
        withdrawalId,
        publisherId: claim.withdrawal.publisherId,
        payoutMethodId: claim.payoutMethod.id,
        providerAccountRowId: claim.account?.id ?? null,
        providerId: claim.providerRecord.id,
        providerName: requestedProviderName,
        expectedStages: ["DESTINATION_VALIDATED"],
        claimedStage: "PROVIDER_SEND_CLAIMED",
        requireAgedClaim: false,
        claimPurpose: "NEW_SEND",
        requireTransferWithoutPayout: false,
        userId,
        auditAction: "PAYOUT_PROVIDER_SEND_CLAIMED",
      })
      if (sendClaim.kind !== "claimed") {
        throw new ConflictException(
          "New provider-send claim unexpectedly expired",
        )
      }
      recipientDetails = sendClaim.recipientDetails
      providerConfig = sendClaim.providerConfig
      claim.execution.stage = "PROVIDER_SEND_CLAIMED"
      claim.execution.version = sendClaim.claimedVersion
      claim.execution.providerMetadata = sendClaim.execution.providerMetadata
    } catch (error: any) {
      const safeMessage = "Payout validation failed before provider send"
      await this.abortPreProviderExecution(
        claim.execution.id,
        withdrawalId,
        userId,
        safeMessage,
      )
      throw new ConflictException(safeMessage)
    }

    let transferResult: any = null
    try {
      this.assertProviderModeForExecution(
        claim.execution,
        requestedProviderName,
      )
      transferResult = await adapter.createTransfer({
        amount: Number(claim.withdrawal.netAmount ?? claim.withdrawal.amount),
        currency: USD_CURRENCY,
        recipientDetails,
        providerConfig,
        idempotencyKey: claim.execution.idempotencyKey,
        description: `GuestPost publisher payout ${
          claim.withdrawal.publicReference ?? claim.withdrawal.id
        }`,
      })
      if (
        requestedProviderName === "stripe_connect" &&
        !stripeResponseMatchesCommand(transferResult, {
          kind: "transfer",
          amount: claim.withdrawal.netAmount ?? claim.withdrawal.amount,
          currency: USD_CURRENCY,
          connectedAccountId: String(recipientDetails.connectedAccountId),
          publicReference:
            claim.withdrawal.publicReference ?? claim.withdrawal.id,
          livemode: claim.execution.livemode,
        })
      ) {
        throw new PayoutProviderResponseMismatchError(
          "STRIPE_TRANSFER",
          "Stripe Transfer response does not match the immutable payout command",
        )
      }

      const providerEvidence = await this.updateExecutionWithParentLock({
        withdrawalId: claim.withdrawal.id,
        executionId: claim.execution.id,
        where: {
          status: "PROCESSING",
          stage: "PROVIDER_SEND_CLAIMED",
          version: claim.execution.version,
        },
        data: {
          providerExecutionId: transferResult.providerExecutionId,
          providerTransferId:
            transferResult.providerTransferId ??
            (requestedProviderName === "stripe_connect"
              ? transferResult.providerExecutionId
              : undefined),
          stage:
            requestedProviderName === "stripe_connect"
              ? "TRANSFER_CREATED"
              : "PROVIDER_SENT",
          fee: transferResult.fee ?? 0,
          providerMetadata: mergePayoutProviderMetadata(
            claim.execution.providerMetadata,
            transferResult.metadata,
          ) as any,
          version: { increment: 1 },
        },
      })
      if (providerEvidence.count !== 1) {
        throw new ConflictException(
          "Provider accepted the payout but its evidence could not be attached",
        )
      }
      claim.execution.version += 1
      claim.execution.providerExecutionId = transferResult.providerExecutionId
      claim.execution.providerTransferId =
        transferResult.providerTransferId ??
        (requestedProviderName === "stripe_connect"
          ? transferResult.providerExecutionId
          : null)
      claim.execution.stage =
        requestedProviderName === "stripe_connect"
          ? "TRANSFER_CREATED"
          : "PROVIDER_SENT"
      claim.execution.providerMetadata = mergePayoutProviderMetadata(
        claim.execution.providerMetadata,
        transferResult.metadata,
      )

      if (requestedProviderName === "stripe_connect") {
        if (!adapter.createBankPayout) {
          throw new Error("Stripe adapter cannot create a bank payout")
        }
        const bankSendClaim = await this.claimExternalCall({
          executionId: claim.execution.id,
          withdrawalId,
          publisherId: claim.withdrawal.publisherId,
          payoutMethodId: claim.payoutMethod.id,
          providerAccountRowId: claim.account?.id ?? null,
          providerId: claim.providerRecord.id,
          providerName: requestedProviderName,
          expectedStages: ["TRANSFER_CREATED"],
          claimedStage: "BANK_PAYOUT_SEND_CLAIMED",
          requireAgedClaim: false,
          claimPurpose: "NEW_SEND",
          requireTransferWithoutPayout: true,
          userId,
          auditAction: "PAYOUT_BANK_SEND_CLAIMED",
        })
        if (bankSendClaim.kind !== "claimed") {
          throw new ConflictException(
            "New bank-payout claim unexpectedly expired",
          )
        }
        recipientDetails = bankSendClaim.recipientDetails
        claim.execution.stage = "BANK_PAYOUT_SEND_CLAIMED"
        claim.execution.version = bankSendClaim.claimedVersion
        claim.execution.providerMetadata =
          bankSendClaim.execution.providerMetadata
        const bankIdempotencyKey = bankPayoutIdempotencyKey(claim.execution)
        if (!bankIdempotencyKey) {
          throw new ConflictException(
            "Original bank-payout idempotency key cannot be reconstructed",
          )
        }
        this.assertProviderModeForExecution(
          bankSendClaim.execution,
          "stripe_connect",
        )
        const payout = await adapter.createBankPayout({
          amount: Number(
            bankSendClaim.withdrawal.netAmount ??
              bankSendClaim.withdrawal.amount,
          ),
          currency: USD_CURRENCY,
          connectedAccountId: String(recipientDetails.connectedAccountId),
          idempotencyKey: bankIdempotencyKey,
          description: `GuestPost publisher payout ${
            bankSendClaim.withdrawal.publicReference ??
            bankSendClaim.withdrawal.id
          }`,
          statementDescriptor: publisherPayoutStatementDescriptor(
            bankSendClaim.withdrawal.publicReference ??
              bankSendClaim.withdrawal.id,
          ),
          publicReference:
            bankSendClaim.withdrawal.publicReference ??
            bankSendClaim.withdrawal.id,
        })
        transferResult = payout
        if (
          !stripeResponseMatchesCommand(payout, {
            kind: "payout",
            amount:
              bankSendClaim.withdrawal.netAmount ??
              bankSendClaim.withdrawal.amount,
            currency: USD_CURRENCY,
            connectedAccountId: String(recipientDetails.connectedAccountId),
            publicReference:
              bankSendClaim.withdrawal.publicReference ??
              bankSendClaim.withdrawal.id,
            livemode: bankSendClaim.execution.livemode,
          })
        ) {
          throw new PayoutProviderResponseMismatchError(
            "STRIPE_PAYOUT",
            "Stripe Payout response does not match the immutable payout command",
          )
        }
        const payoutEvidence = await this.updateExecutionWithParentLock({
          withdrawalId: bankSendClaim.withdrawal.id,
          executionId: claim.execution.id,
          where: {
            status: "PROCESSING",
            stage: "BANK_PAYOUT_SEND_CLAIMED",
            version: claim.execution.version,
          },
          data: {
            providerPayoutId: payout.providerPayoutId,
            acceptedReference: payout.acceptedReference,
            stage:
              payout.status === "COMPLETED"
                ? "BANK_PAID"
                : payout.status === "FAILED"
                  ? "BANK_PAYOUT_RECOVERY_REQUIRED"
                  : "BANK_PAYOUT_CREATED",
            fee: payout.fee ?? transferResult.fee ?? 0,
            providerMetadata: mergePayoutProviderMetadata(
              claim.execution.providerMetadata,
              payout.metadata,
            ) as any,
            version: { increment: 1 },
          },
        })
        if (payoutEvidence.count !== 1) {
          throw new ConflictException(
            "Stripe accepted the bank payout but its evidence could not be attached",
          )
        }
        claim.execution.version += 1
        claim.execution.providerPayoutId = payout.providerPayoutId
        claim.execution.stage =
          payout.status === "COMPLETED"
            ? "BANK_PAID"
            : payout.status === "FAILED"
              ? "BANK_PAYOUT_RECOVERY_REQUIRED"
              : "BANK_PAYOUT_CREATED"
        claim.execution.providerMetadata = mergePayoutProviderMetadata(
          claim.execution.providerMetadata,
          payout.metadata,
        )
      }

      await this.audit.log({
        action: "PAYOUT_EXECUTION_SENT",
        entityType: "PayoutExecution",
        entityId: claim.execution.id,
        metadata: {
          withdrawalId,
          providerName: requestedProviderName,
          providerExecutionId: transferResult.providerExecutionId,
          providerPayoutId: transferResult.providerPayoutId,
          status: transferResult.status,
        },
        userId,
        organizationId: claim.withdrawal.publisher.organizationId,
      })

      if (transferResult.status === "COMPLETED") {
        const providerReference =
          requestedProviderName === "stripe_connect"
            ? transferResult.providerPayoutId
            : transferResult.providerExecutionId
        if (!providerReference) {
          throw new Error(
            "Provider completed the payout without a durable provider reference",
          )
        }
        const finalized = await finalizePayoutExecution(this.prisma, {
          executionId: claim.execution.id,
          withdrawalId,
          providerName: requestedProviderName,
          providerReference,
          source: "PROVIDER_RESPONSE",
          evidenceAt: new Date(),
          providerAmountMinor: transferResult.providerAmountMinor,
          providerCurrency: transferResult.providerCurrency,
          fee: transferResult.fee,
          metadata: transferResult.metadata,
        })
        if (finalized.kind === "conflict") {
          throw new ConflictException(
            `Provider completed payout requires reconciliation: ${finalized.code}`,
          )
        }
        return {
          executionId: claim.execution.id,
          status: "COMPLETED",
          providerExecutionId: transferResult.providerExecutionId,
        }
      }
      if (transferResult.status === "FAILED") {
        throw new Error(
          "Provider reported a failed payout; durable failure review is required before funds can be restored",
        )
      }
      return {
        executionId: claim.execution.id,
        status: "PROCESSING",
        providerExecutionId: transferResult.providerExecutionId,
      }
    } catch (error: any) {
      const untrustedResponse = isUntrustedProviderResponse(error)
      const safeMessage = untrustedResponse
        ? "Provider response failed immutable command validation; payout reconciliation is required"
        : "Provider outcome is unknown; payout reconciliation is required"
      if (untrustedResponse) {
        await this.quarantineUntrustedProviderResponse({
          executionId: claim.execution.id,
          withdrawalId,
          expectedStages: [claim.execution.stage],
          expectedVersion: claim.execution.version,
          responseKind: error.responseKind,
          providerName: requestedProviderName,
          userId,
          organizationId: claim.withdrawal.publisher.organizationId,
          safeMessage,
        })
        throw new ConflictException(safeMessage)
      }
      const trustedResult = transferResult
      const errorCategory =
        error instanceof ConflictException
          ? "LOCAL_EVIDENCE_PERSISTENCE_CONFLICT"
          : "PROVIDER_OUTCOME_AMBIGUOUS"
      this.logger.error(
        `Payout provider outcome requires recovery for withdrawal ${withdrawalId}; execution=${claim.execution.id}; category=${errorCategory}`,
      )
      const current = await this.prisma.payoutExecution.findUnique({
        where: { id: claim.execution.id },
      })
      if (current?.status === "COMPLETED") {
        return {
          executionId: current.id,
          status: "COMPLETED",
          providerExecutionId: current.providerExecutionId,
          recoveredFromConcurrentFinalization: true,
        }
      }
      if (
        current?.status !== "CANCELLED" &&
        current?.stage !== "CANCEL_REQUESTED"
      ) {
        await this.runSerializable(async (tx) => {
          await tx.$queryRawUnsafe(
            'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
            withdrawalId,
          )
          await tx.$queryRawUnsafe(
            'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
            claim.execution.id,
          )
          const fresh = await tx.payoutExecution.findUnique({
            where: { id: claim.execution.id },
          })
          if (
            fresh?.status !== "PROCESSING" ||
            fresh.stage === "CANCEL_REQUESTED"
          ) {
            return
          }
          // Stripe's bank Payout adapter exposes the payout id through its
          // generic providerExecutionId field. The execution's generic id is
          // already the Transfer identity and must never be replaced.
          const incomingProviderId =
            requestedProviderName === "stripe_connect" &&
            trustedResult?.providerPayoutId
              ? null
              : (trustedResult?.providerExecutionId ?? null)
          if (
            fresh.providerExecutionId &&
            incomingProviderId &&
            fresh.providerExecutionId !== incomingProviderId
          ) {
            await this.audit.log(
              {
                action: "PAYOUT_PROVIDER_EVIDENCE_CONFLICT",
                entityType: "PayoutExecution",
                entityId: fresh.id,
                metadata: {
                  withdrawalId,
                  persistedProviderExecutionId: fresh.providerExecutionId,
                  incomingProviderExecutionId: incomingProviderId,
                },
                userId,
                organizationId: claim.withdrawal.publisher.organizationId,
              },
              tx,
            )
            return
          }
          const stage =
            trustedResult?.status === "COMPLETED"
              ? "PROVIDER_COMPLETION_RECOVERY_REQUIRED"
              : requestedProviderName === "stripe_connect"
                ? fresh.providerPayoutId || trustedResult?.providerPayoutId
                  ? "BANK_PAYOUT_RECOVERY_REQUIRED"
                  : fresh.stage === "BANK_PAYOUT_SEND_CLAIMED"
                    ? "BANK_PAYOUT_SEND_CLAIMED"
                    : fresh.stage === "PROVIDER_SEND_CLAIMED" && !trustedResult
                      ? "PROVIDER_SEND_CLAIMED"
                      : fresh.providerTransferId ||
                          trustedResult?.providerTransferId
                        ? "TRANSFER_RECOVERY_REQUIRED"
                        : "PROVIDER_OUTCOME_UNKNOWN"
                : fresh.stage === "PROVIDER_SEND_CLAIMED" && !trustedResult
                  ? "PROVIDER_SEND_CLAIMED"
                  : "PROVIDER_OUTCOME_UNKNOWN"
          const held = await tx.payoutExecution.updateMany({
            where: {
              id: fresh.id,
              status: "PROCESSING",
              version: fresh.version,
            },
            data: {
              stage,
              errorMessage: safeMessage,
              providerExecutionId: incomingProviderId ?? undefined,
              providerTransferId:
                trustedResult?.providerTransferId ?? undefined,
              providerPayoutId: trustedResult?.providerPayoutId ?? undefined,
              providerMetadata: mergePayoutProviderMetadata(
                fresh.providerMetadata,
                trustedResult?.metadata,
              ),
              version: { increment: 1 },
            },
          })
          if (held.count !== 1) return
          await this.audit.log(
            {
              action: "PAYOUT_EXECUTION_RECOVERY_REQUIRED",
              entityType: "PayoutExecution",
              entityId: fresh.id,
              metadata: {
                withdrawalId,
                providerExecutionId:
                  incomingProviderId ?? fresh.providerExecutionId,
                providerTransferId:
                  trustedResult?.providerTransferId ?? fresh.providerTransferId,
                providerPayoutId:
                  trustedResult?.providerPayoutId ?? fresh.providerPayoutId,
                recoveryStage: stage,
                errorCategory,
              },
              userId,
              organizationId: claim.withdrawal.publisher.organizationId,
            },
            tx,
          )
        })
      }
      throw new ConflictException(safeMessage)
    }
  }

  /**
   * Replays a Stripe Transfer only after the durable send claim lease has
   * expired. The original execution idempotency key is immutable, so a crash
   * before the HTTP call and a lost HTTP response converge on the same Stripe
   * object. Wise/manual claims remain human-recovery-only until those rails
   * have equivalent typed settlement evidence.
   */
  private async recoverClaimedProviderSend(execution: any, userId: string) {
    if (execution.provider.name !== "stripe_connect") {
      throw new ConflictException(
        "Automated claimed-send recovery is disabled for this payout rail; Finance must reconcile the original provider idempotency key",
      )
    }
    const payoutMethod = execution.withdrawal.payoutMethod
    const account = payoutMethod?.providerAccount
    if (!payoutMethod || !account) {
      throw new ConflictException(
        "Original Stripe payout routing is unavailable; claimed-send recovery is blocked",
      )
    }
    const adapter = this.providerService.getAdapter("stripe_connect")
    if (!adapter.recoverClaimedTransfer) {
      throw new ConflictException(
        "Stripe claimed-transfer recovery is unavailable",
      )
    }
    const claim = await this.claimExternalCall({
      executionId: execution.id,
      withdrawalId: execution.withdrawalId,
      publisherId: execution.withdrawal.publisherId,
      payoutMethodId: payoutMethod.id,
      providerAccountRowId: account.id,
      providerId: execution.provider.id,
      providerName: "stripe_connect",
      expectedStages: ["PROVIDER_SEND_CLAIMED"],
      claimedStage: "PROVIDER_SEND_CLAIMED",
      requireAgedClaim: true,
      claimPurpose: "EXACT_RECOVERY",
      requireTransferWithoutPayout: false,
      userId,
      auditAction: "PAYOUT_PROVIDER_SEND_REPLAY_CLAIMED",
    })
    if (claim.kind === "expired") {
      throw new ConflictException(
        "The safe provider replay window expired; provider lookup and Finance review are required",
      )
    }

    this.assertProviderModeForExecution(claim.execution, "stripe_connect")
    const recipientValidation = await adapter.validateRecipient(
      claim.recipientDetails,
    )
    if (!recipientValidation.valid) {
      throw new ConflictException(
        "The immutable Stripe destination no longer passes provider validation",
      )
    }

    let transfer: any = null
    let recoveredExecution: any = null
    try {
      this.assertProviderModeForExecution(claim.execution, "stripe_connect")
      transfer = await adapter.recoverClaimedTransfer({
        amount: Number(claim.withdrawal.netAmount ?? claim.withdrawal.amount),
        currency: USD_CURRENCY,
        recipientDetails: claim.recipientDetails,
        providerConfig: claim.providerConfig,
        idempotencyKey: claim.execution.idempotencyKey,
        description: `GuestPost publisher payout ${
          claim.withdrawal.publicReference ?? claim.withdrawal.id
        }`,
      })
      if (
        !stripeResponseMatchesCommand(transfer, {
          kind: "transfer",
          amount: claim.withdrawal.netAmount ?? claim.withdrawal.amount,
          currency: USD_CURRENCY,
          connectedAccountId: String(claim.recipientDetails.connectedAccountId),
          publicReference:
            claim.withdrawal.publicReference ?? claim.withdrawal.id,
          livemode: claim.execution.livemode,
        })
      ) {
        throw new PayoutProviderResponseMismatchError(
          "STRIPE_TRANSFER",
          "Recovered Stripe Transfer response does not match the immutable payout command",
        )
      }
      if (
        typeof transfer.providerExecutionId !== "string" ||
        transfer.providerExecutionId.length === 0
      ) {
        throw new ConflictException(
          "Stripe replay returned no durable Transfer reference",
        )
      }
      const providerTransferId =
        transfer.providerTransferId ?? transfer.providerExecutionId
      const recoveredMetadata = mergePayoutProviderMetadata(
        claim.execution.providerMetadata,
        transfer.metadata,
      )
      const persisted = await this.updateExecutionWithParentLock({
        withdrawalId: execution.withdrawalId,
        executionId: execution.id,
        where: {
          status: "PROCESSING",
          stage: "PROVIDER_SEND_CLAIMED",
          version: claim.claimedVersion,
        },
        data: {
          providerExecutionId: transfer.providerExecutionId,
          providerTransferId,
          stage: "TRANSFER_RECOVERY_REQUIRED",
          fee: transfer.fee ?? claim.execution.fee,
          providerMetadata: recoveredMetadata as any,
          errorMessage: null,
          version: { increment: 1 },
        },
      })
      if (persisted.count !== 1) {
        throw new ConflictException(
          "Recovered Stripe Transfer evidence could not be persisted",
        )
      }

      recoveredExecution = {
        ...claim.execution,
        providerExecutionId: transfer.providerExecutionId,
        providerTransferId,
        stage: "TRANSFER_RECOVERY_REQUIRED",
        version: claim.claimedVersion + 1,
        providerMetadata: recoveredMetadata,
      }
    } catch (error: any) {
      const untrustedResponse = isUntrustedProviderResponse(error)
      const safeMessage = untrustedResponse
        ? "Stripe Transfer response failed immutable command validation; Finance reconciliation is required"
        : "Stripe Transfer outcome remains unknown; retry the original claim only after the recovery lease"
      if (untrustedResponse) {
        await this.quarantineUntrustedProviderResponse({
          executionId: execution.id,
          withdrawalId: execution.withdrawalId,
          expectedStages: ["PROVIDER_SEND_CLAIMED"],
          expectedVersion: claim.claimedVersion,
          responseKind: error.responseKind,
          providerName: "stripe_connect",
          userId,
          organizationId: execution.withdrawal.publisher.organizationId,
          safeMessage,
        })
        throw new ConflictException(safeMessage)
      }
      const trustedTransfer = transfer
      const current = await this.prisma.payoutExecution.findUnique({
        where: { id: execution.id },
      })
      if (current?.status === "COMPLETED") {
        return {
          executionId: current.id,
          status: "COMPLETED",
          providerExecutionId: current.providerExecutionId,
          recoveredFromConcurrentFinalization: true,
        }
      }
      await this.updateExecutionWithParentLock({
        withdrawalId: execution.withdrawalId,
        executionId: execution.id,
        where: {
          status: "PROCESSING",
          stage: "PROVIDER_SEND_CLAIMED",
          version: claim.claimedVersion,
        },
        data: {
          stage: trustedTransfer?.providerExecutionId
            ? "TRANSFER_RECOVERY_REQUIRED"
            : "PROVIDER_SEND_CLAIMED",
          providerExecutionId:
            trustedTransfer?.providerExecutionId ?? undefined,
          providerTransferId:
            trustedTransfer?.providerTransferId ??
            trustedTransfer?.providerExecutionId ??
            undefined,
          providerMetadata: mergePayoutProviderMetadata(
            claim.execution.providerMetadata,
            trustedTransfer?.metadata,
          ) as any,
          errorMessage: safeMessage,
          version: { increment: 1 },
        },
      })
      throw new ConflictException(safeMessage)
    }
    return this.resumeStripeBankPayout(recoveredExecution, userId)
  }

  /**
   * Replays a Stripe bank Payout with the exact original bank-stage
   * idempotency key. This is intentionally available while the new-send kill
   * switch is off because it resolves an already-durable ambiguous claim; it
   * cannot create a distinct payout object inside the bounded replay window.
   */
  private async recoverClaimedStripeBankPayout(execution: any, userId: string) {
    const claimedStage = execution.stage
    if (
      !["BANK_PAYOUT_SEND_CLAIMED", "BANK_PAYOUT_RESUME_CLAIMED"].includes(
        claimedStage,
      )
    ) {
      throw new ConflictException(
        "Execution is not in a recoverable Stripe bank-payout claim stage",
      )
    }
    if (execution.provider.name !== "stripe_connect") {
      throw new ConflictException(
        "Bank-payout claim recovery is only valid for Stripe Connect",
      )
    }
    const payoutMethod = execution.withdrawal.payoutMethod
    const account = payoutMethod?.providerAccount
    const bankKey = bankPayoutIdempotencyKey(execution)
    if (!payoutMethod || !account || !bankKey) {
      throw new ConflictException(
        "Original Stripe bank-payout routing or idempotency key cannot be reconstructed",
      )
    }
    const adapter = this.providerService.getAdapter("stripe_connect")
    if (!adapter.recoverClaimedBankPayout) {
      throw new ConflictException("Stripe bank-payout recovery is unavailable")
    }
    const claim = await this.claimExternalCall({
      executionId: execution.id,
      withdrawalId: execution.withdrawalId,
      publisherId: execution.withdrawal.publisherId,
      payoutMethodId: payoutMethod.id,
      providerAccountRowId: account.id,
      providerId: execution.provider.id,
      providerName: "stripe_connect",
      expectedStages: [claimedStage],
      claimedStage,
      requireAgedClaim: true,
      claimPurpose: "EXACT_RECOVERY",
      requireTransferWithoutPayout: true,
      userId,
      auditAction: "PAYOUT_BANK_SEND_REPLAY_CLAIMED",
    })
    if (claim.kind === "expired") {
      throw new ConflictException(
        "The safe bank-payout replay window expired; Stripe lookup and Finance review are required",
      )
    }
    const connectedAccountId = claim.recipientDetails.connectedAccountId
    if (typeof connectedAccountId !== "string") {
      throw new ConflictException(
        "Immutable Stripe connected-account destination is missing",
      )
    }

    let payout: any = null
    try {
      this.assertProviderModeForExecution(claim.execution, "stripe_connect")
      payout = await adapter.recoverClaimedBankPayout({
        amount: Number(claim.withdrawal.netAmount ?? claim.withdrawal.amount),
        currency: USD_CURRENCY,
        connectedAccountId,
        idempotencyKey: bankKey,
        description: `GuestPost publisher payout ${
          claim.withdrawal.publicReference ?? claim.withdrawal.id
        }`,
        statementDescriptor: publisherPayoutStatementDescriptor(
          claim.withdrawal.publicReference ?? claim.withdrawal.id,
        ),
        publicReference:
          claim.withdrawal.publicReference ?? claim.withdrawal.id,
      })
      if (
        !stripeResponseMatchesCommand(payout, {
          kind: "payout",
          amount: claim.withdrawal.netAmount ?? claim.withdrawal.amount,
          currency: USD_CURRENCY,
          connectedAccountId,
          publicReference:
            claim.withdrawal.publicReference ?? claim.withdrawal.id,
          livemode: claim.execution.livemode,
        })
      ) {
        throw new PayoutProviderResponseMismatchError(
          "STRIPE_PAYOUT",
          "Recovered Stripe Payout response does not match the immutable payout command",
        )
      }
      if (
        typeof payout.providerPayoutId !== "string" ||
        !payout.providerPayoutId.startsWith("po_")
      ) {
        throw new ConflictException(
          "Stripe replay returned no durable bank Payout reference",
        )
      }
      const nextStage =
        payout.status === "COMPLETED"
          ? "BANK_PAID"
          : payout.status === "FAILED"
            ? "BANK_PAYOUT_RECOVERY_REQUIRED"
            : "BANK_PAYOUT_CREATED"
      const persisted = await this.updateExecutionWithParentLock({
        withdrawalId: execution.withdrawalId,
        executionId: execution.id,
        where: {
          status: "PROCESSING",
          stage: claimedStage,
          version: claim.claimedVersion,
        },
        data: {
          providerPayoutId: payout.providerPayoutId,
          acceptedReference: payout.acceptedReference,
          stage: nextStage,
          providerMetadata: mergePayoutProviderMetadata(
            claim.execution.providerMetadata,
            payout.metadata,
          ) as any,
          fee: payout.fee ?? claim.execution.fee,
          errorMessage: null,
          version: { increment: 1 },
        },
      })
      if (persisted.count !== 1) {
        throw new ConflictException(
          "Recovered Stripe Payout evidence could not be persisted",
        )
      }
    } catch (error: any) {
      const untrustedResponse = isUntrustedProviderResponse(error)
      const safeMessage = untrustedResponse
        ? "Stripe Payout response failed immutable command validation; Finance reconciliation is required"
        : "Stripe bank-payout outcome remains unknown; retry the original claim only after the recovery lease"
      if (untrustedResponse) {
        await this.quarantineUntrustedProviderResponse({
          executionId: execution.id,
          withdrawalId: execution.withdrawalId,
          expectedStages: [claimedStage],
          expectedVersion: claim.claimedVersion,
          responseKind: error.responseKind,
          providerName: "stripe_connect",
          userId,
          organizationId: execution.withdrawal.publisher.organizationId,
          safeMessage,
        })
        throw new ConflictException(safeMessage)
      }
      const trustedPayout = payout
      const current = await this.prisma.payoutExecution.findUnique({
        where: { id: execution.id },
      })
      if (current?.status === "COMPLETED") {
        return {
          executionId: current.id,
          status: "COMPLETED",
          providerExecutionId: current.providerExecutionId,
          recoveredFromConcurrentFinalization: true,
        }
      }
      await this.updateExecutionWithParentLock({
        withdrawalId: execution.withdrawalId,
        executionId: execution.id,
        where: {
          status: "PROCESSING",
          stage: claimedStage,
          version: claim.claimedVersion,
        },
        data: {
          stage: trustedPayout?.providerPayoutId
            ? "BANK_PAYOUT_RECOVERY_REQUIRED"
            : claimedStage,
          providerPayoutId: trustedPayout?.providerPayoutId ?? undefined,
          acceptedReference: trustedPayout?.acceptedReference ?? undefined,
          providerMetadata: mergePayoutProviderMetadata(
            claim.execution.providerMetadata,
            trustedPayout?.metadata,
          ) as any,
          errorMessage: safeMessage,
          version: { increment: 1 },
        },
      })
      throw new ConflictException(safeMessage)
    }

    if (payout.status === "COMPLETED") {
      const result = await finalizePayoutExecution(this.prisma, {
        executionId: execution.id,
        withdrawalId: execution.withdrawalId,
        providerName: "stripe_connect",
        providerReference: payout.providerPayoutId,
        source: "PROVIDER_RESPONSE",
        evidenceAt: new Date(),
        providerAmountMinor: payout.providerAmountMinor,
        providerCurrency: payout.providerCurrency,
        fee: payout.fee,
        metadata: payout.metadata,
      })
      if (result.kind === "conflict") {
        throw new ConflictException(
          `Recovered Stripe payout needs reconciliation: ${result.code}`,
        )
      }
      return {
        executionId: execution.id,
        status: "COMPLETED",
        providerExecutionId: payout.providerExecutionId,
        recoveredBankStage: true,
      }
    }
    if (payout.status === "FAILED") {
      throw new ConflictException(
        "Stripe reported bank payout failure; funds remain reserved for reviewed reversal",
      )
    }
    return {
      executionId: execution.id,
      status: "PROCESSING",
      providerExecutionId: payout.providerExecutionId,
      recoveredBankStage: true,
    }
  }

  async retryExecution(executionId: string, userId: string, reason: string) {
    assertApiFinanceOperationAllowed("recovery")
    const operatorReason = normalizePayoutOperatorReason(reason)
    const execution = await this.prisma.payoutExecution.findUnique({
      where: { id: executionId },
      include: {
        withdrawal: {
          include: {
            publisher: true,
            payoutMethod: { include: { providerAccount: true } },
          },
        },
        provider: true,
      },
    })
    if (!execution) throw new NotFoundException("Payout execution not found")
    if (
      ["COMPLETED", "REVERSED", "REJECTED"].includes(
        execution.withdrawal.status,
      )
    ) {
      throw new ConflictException(
        `Withdrawal is already ${execution.withdrawal.status}; provider retry is blocked`,
      )
    }
    await this.recordOperatorIntent({
      action: "PAYOUT_RECOVERY_REQUESTED",
      entityType: "PayoutExecution",
      entityId: executionId,
      userId,
      organizationId: execution.withdrawal.publisher.organizationId,
      reason: operatorReason,
      metadata: {
        withdrawalId: execution.withdrawalId,
        provider: execution.provider.name,
        stage: execution.stage,
      },
    })
    if (
      execution.status === "PROCESSING" &&
      execution.stage === "PROVIDER_SEND_CLAIMED"
    ) {
      return this.recoverClaimedProviderSend(execution, userId)
    }
    if (
      execution.status === "PROCESSING" &&
      ["BANK_PAYOUT_SEND_CLAIMED", "BANK_PAYOUT_RESUME_CLAIMED"].includes(
        execution.stage,
      )
    ) {
      return this.recoverClaimedStripeBankPayout(execution, userId)
    }
    if (
      execution.provider.name === "stripe_connect" &&
      execution.status === "PROCESSING" &&
      execution.providerTransferId &&
      !execution.providerPayoutId &&
      execution.stage === "TRANSFER_RECOVERY_REQUIRED"
    ) {
      return this.resumeStripeBankPayout(execution, userId)
    }
    if (!["FAILED", "PROCESSING"].includes(execution.status)) {
      throw new ConflictException(
        `Execution ${executionId} is ${execution.status}; retry is blocked`,
      )
    }
    const statusReference =
      execution.provider.name === "stripe_connect"
        ? execution.providerPayoutId
        : execution.providerExecutionId
    if (!statusReference) {
      throw new ConflictException(
        "Provider outcome is unconfirmed and no terminal object reference was recorded. Reconcile the original idempotency key; a new send is forbidden.",
      )
    }
    const adapter = this.providerService.getAdapter(execution.provider.name)
    const immutableConnectedAccountId =
      execution.provider.name === "stripe_connect"
        ? immutableProviderAccountId(execution)
        : null
    const expectedAmountMinor =
      execution.provider.name === "stripe_connect"
        ? exactUsdMinorAmount(
            execution.destinationAmount ?? execution.amount,
            execution.destinationCurrency,
          )
        : null
    if (
      execution.provider.name === "stripe_connect" &&
      (!immutableConnectedAccountId ||
        expectedAmountMinor === null ||
        !execution.withdrawal.publicReference)
    ) {
      throw new ConflictException(
        "Immutable Stripe destination snapshot is missing; recovery is blocked",
      )
    }
    this.assertProviderModeForExecution(execution, execution.provider.name)
    const providerStatus = await adapter.checkTransferStatus(statusReference, {
      connectedAccountId: immutableConnectedAccountId ?? undefined,
      providerTransferId: execution.providerTransferId ?? undefined,
      providerPayoutId: execution.providerPayoutId ?? undefined,
      expectedAmountMinor: expectedAmountMinor ?? undefined,
      expectedCurrency: execution.destinationCurrency,
      expectedPublicReference:
        execution.withdrawal.publicReference ?? undefined,
    })
    if (
      execution.provider.name === "stripe_connect" &&
      (providerStatus.livemode !== execution.livemode ||
        !isRecord(providerStatus.metadata) ||
        providerStatus.metadata.livemode !== execution.livemode)
    ) {
      throw payoutConflict(
        "PAYOUT_PROVIDER_MODE_DRIFT",
        "Stripe status evidence mode does not match the immutable payout execution",
      )
    }
    if (providerStatus.status === "COMPLETED") {
      await this.finalizeCompletedAtProvider(execution, providerStatus, userId)
      return {
        executionId: execution.id,
        status: "COMPLETED",
        providerExecutionId: statusReference,
        recoveredFromProvider: true,
      }
    }
    if (providerStatus.status === "PROCESSING") {
      throw new ConflictException(
        `Provider payout ${statusReference} is still processing; no new send is permitted`,
      )
    }
    throw new ConflictException(
      `Provider reports ${providerStatus.status}. Funds remain reserved until durable provider failure/cancellation evidence is recorded and reviewed; automated resend is disabled.`,
    )
  }

  private async resumeStripeBankPayout(execution: any, userId: string) {
    const adapter = this.providerService.getAdapter("stripe_connect")
    if (!adapter.recoverClaimedBankPayout) {
      throw new ConflictException("Stripe bank-payout recovery is unavailable")
    }
    const payoutMethod = execution.withdrawal.payoutMethod
    const account = payoutMethod?.providerAccount
    const bankIdempotencyKey = bankPayoutIdempotencyKey(execution)
    if (!payoutMethod || !bankIdempotencyKey) {
      throw new ConflictException(
        "Original bank-payout routing or idempotency key cannot be reconstructed",
      )
    }
    const externalClaim = await this.claimExternalCall({
      executionId: execution.id,
      withdrawalId: execution.withdrawalId,
      publisherId: execution.withdrawal.publisherId,
      payoutMethodId: payoutMethod.id,
      providerAccountRowId: account?.id ?? null,
      providerId: execution.provider.id,
      providerName: "stripe_connect",
      expectedStages: ["TRANSFER_RECOVERY_REQUIRED"],
      claimedStage: "BANK_PAYOUT_RESUME_CLAIMED",
      requireAgedClaim: false,
      claimPurpose: "EXACT_RECOVERY",
      requireTransferWithoutPayout: true,
      userId,
      auditAction: "PAYOUT_BANK_STAGE_RESUME_CLAIMED",
    })
    if (externalClaim.kind !== "claimed") {
      throw new ConflictException(
        "Stripe bank-payout recovery claim unexpectedly expired",
      )
    }
    const immutableConnectedAccountId =
      externalClaim.recipientDetails.connectedAccountId
    if (typeof immutableConnectedAccountId !== "string") {
      throw new ConflictException(
        "Immutable Stripe connected-account destination is missing",
      )
    }
    const claimed = {
      execution: externalClaim.execution,
      immutableConnectedAccountId,
      claimedVersion: externalClaim.claimedVersion,
      bankIdempotencyKey,
    }

    let payout: any = null
    try {
      const withdrawal = claimed.execution.withdrawal
      this.assertProviderModeForExecution(claimed.execution, "stripe_connect")
      payout = await adapter.recoverClaimedBankPayout({
        amount: Number(withdrawal.netAmount ?? withdrawal.amount),
        currency: USD_CURRENCY,
        connectedAccountId: claimed.immutableConnectedAccountId,
        idempotencyKey: claimed.bankIdempotencyKey,
        description: `GuestPost publisher payout ${withdrawal.publicReference ?? withdrawal.id}`,
        statementDescriptor: publisherPayoutStatementDescriptor(
          withdrawal.publicReference ?? withdrawal.id,
        ),
        publicReference: withdrawal.publicReference ?? withdrawal.id,
      })
      if (
        !stripeResponseMatchesCommand(payout, {
          kind: "payout",
          amount: withdrawal.netAmount ?? withdrawal.amount,
          currency: USD_CURRENCY,
          connectedAccountId: claimed.immutableConnectedAccountId,
          publicReference: withdrawal.publicReference ?? withdrawal.id,
          livemode: claimed.execution.livemode,
        })
      ) {
        throw new PayoutProviderResponseMismatchError(
          "STRIPE_PAYOUT",
          "Stripe Payout response does not match the immutable payout command",
        )
      }
      const persisted = await this.updateExecutionWithParentLock({
        withdrawalId: execution.withdrawalId,
        executionId: execution.id,
        where: {
          version: claimed.claimedVersion,
          status: "PROCESSING",
          stage: "BANK_PAYOUT_RESUME_CLAIMED",
        },
        data: {
          providerPayoutId: payout.providerPayoutId,
          acceptedReference: payout.acceptedReference,
          stage:
            payout.status === "COMPLETED"
              ? "BANK_PAID"
              : payout.status === "FAILED"
                ? "BANK_PAYOUT_RECOVERY_REQUIRED"
                : "BANK_PAYOUT_CREATED",
          providerMetadata: mergePayoutProviderMetadata(
            claimed.execution.providerMetadata,
            payout.metadata,
          ) as any,
          fee: payout.fee ?? claimed.execution.fee,
          errorMessage: null,
          version: { increment: 1 },
        },
      })
      if (persisted.count !== 1) {
        throw new ConflictException(
          "Stripe accepted recovery but local evidence persistence needs reconciliation",
        )
      }
      claimed.execution.providerPayoutId = payout.providerPayoutId
      claimed.execution.stage =
        payout.status === "COMPLETED" ? "BANK_PAID" : "BANK_PAYOUT_CREATED"
      if (payout.status === "COMPLETED") {
        const result = await finalizePayoutExecution(this.prisma, {
          executionId: execution.id,
          withdrawalId: execution.withdrawalId,
          providerName: "stripe_connect",
          providerReference: payout.providerPayoutId,
          source: "PROVIDER_RESPONSE",
          evidenceAt: new Date(),
          providerAmountMinor: payout.providerAmountMinor,
          providerCurrency: payout.providerCurrency,
          fee: payout.fee,
          metadata: payout.metadata,
        })
        if (result.kind === "conflict") {
          throw new ConflictException(
            `Recovered Stripe payout needs reconciliation: ${result.code}`,
          )
        }
        return {
          executionId: execution.id,
          status: "COMPLETED",
          providerExecutionId: payout.providerExecutionId,
          recoveredBankStage: true,
        }
      }
      if (payout.status === "FAILED") {
        throw new ConflictException(
          "Stripe reported bank payout failure; funds remain reserved for reviewed reversal",
        )
      }
      return {
        executionId: execution.id,
        status: "PROCESSING",
        providerExecutionId: payout.providerExecutionId,
        recoveredBankStage: true,
      }
    } catch (error: any) {
      const untrustedResponse = isUntrustedProviderResponse(error)
      const safeMessage = untrustedResponse
        ? "Stripe Payout response failed immutable command validation; Finance reconciliation is required"
        : "Stripe bank-payout outcome is unknown; reconciliation is required"
      if (untrustedResponse) {
        await this.quarantineUntrustedProviderResponse({
          executionId: execution.id,
          withdrawalId: execution.withdrawalId,
          expectedStages: ["BANK_PAYOUT_RESUME_CLAIMED"],
          expectedVersion: claimed.claimedVersion,
          responseKind: error.responseKind,
          providerName: "stripe_connect",
          userId,
          organizationId: execution.withdrawal.publisher.organizationId,
          safeMessage,
        })
        throw new ConflictException(safeMessage)
      }
      const trustedPayout = payout
      await this.updateExecutionWithParentLock({
        withdrawalId: execution.withdrawalId,
        executionId: execution.id,
        where: {
          status: "PROCESSING",
          stage: "BANK_PAYOUT_RESUME_CLAIMED",
          version: claimed.claimedVersion,
        },
        data: {
          stage: trustedPayout?.providerPayoutId
            ? "BANK_PAYOUT_RECOVERY_REQUIRED"
            : "BANK_PAYOUT_RESUME_CLAIMED",
          providerPayoutId: trustedPayout?.providerPayoutId ?? undefined,
          acceptedReference: trustedPayout?.acceptedReference ?? undefined,
          providerMetadata: mergePayoutProviderMetadata(
            claimed.execution.providerMetadata,
            trustedPayout?.metadata,
          ) as any,
          errorMessage: safeMessage,
          version: { increment: 1 },
        },
      })
      throw new ConflictException(safeMessage)
    }
  }

  private async finalizeCompletedAtProvider(
    execution: any,
    providerStatus: {
      fee?: number
      providerAmountMinor?: number
      providerCurrency?: string
      metadata?: Record<string, unknown>
    },
    _userId: string,
  ) {
    const providerName = execution.provider.name
    const providerReference =
      providerName === "stripe_connect"
        ? execution.providerPayoutId
        : execution.providerExecutionId
    if (!providerReference) {
      throw new ConflictException(
        "Provider completion has no durable terminal object reference",
      )
    }
    const result = await finalizePayoutExecution(this.prisma, {
      executionId: execution.id,
      withdrawalId: execution.withdrawalId,
      providerName,
      providerReference,
      source: "PROVIDER_STATUS_POLL",
      evidenceAt: new Date(),
      providerAmountMinor: providerStatus.providerAmountMinor,
      providerCurrency: providerStatus.providerCurrency,
      fee: providerStatus.fee,
      metadata: providerStatus.metadata,
    })
    if (result.kind === "conflict") {
      throw new ConflictException(
        `Provider completion could not be applied: ${result.code}`,
      )
    }
  }

  private async abortPreProviderExecution(
    executionId: string,
    withdrawalId: string,
    userId: string,
    reason: string,
  ) {
    return this.runSerializable(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        withdrawalId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
        executionId,
      )
      await this.assertEligibleFinanceActor(tx, userId)
      const locked = await tx.payoutExecution.findUnique({
        where: { id: executionId },
        include: {
          withdrawal: {
            include: { publisher: { select: { organizationId: true } } },
          },
        },
      })
      const durableClaimCount = locked
        ? await tx.payoutExecutionClaim.count({
            where: { executionId: locked.id },
          })
        : 0
      if (
        !locked ||
        locked.withdrawalId !== withdrawalId ||
        locked.status !== "PROCESSING" ||
        locked.withdrawal.status !== "PROCESSING" ||
        !["CREATED", "DESTINATION_VALIDATED"].includes(locked.stage) ||
        locked.providerExecutionId ||
        locked.providerTransferId ||
        locked.providerPayoutId ||
        durableClaimCount !== 0
      ) {
        throw payoutConflict(
          "PAYOUT_PRE_PROVIDER_PROOF_MISSING",
          "Execution is not provably before every provider call",
        )
      }

      const abortedAt = new Date()
      const aborted = await tx.payoutExecution.updateMany({
        where: {
          id: executionId,
          status: "PROCESSING",
          stage: locked.stage,
          version: locked.version,
        },
        data: {
          status: "CANCELLED",
          stage: "PRE_PROVIDER_ABORTED",
          cancellationSource: "PRE_PROVIDER_ABORT",
          cancelledAt: abortedAt,
          cancellationActorUserId: userId,
          errorMessage: reason,
          version: { increment: 1 },
        },
      })
      if (aborted.count !== 1) {
        throw new ConflictException(
          "Execution changed while aborting before provider send",
        )
      }
      const restored = await tx.withdrawal.updateMany({
        where: {
          id: withdrawalId,
          status: "PROCESSING",
          version: locked.withdrawal.version,
        },
        data: { status: "APPROVED", version: { increment: 1 } },
      })
      if (restored.count !== 1) {
        throw new ConflictException(
          "Withdrawal changed while aborting before provider send",
        )
      }
      await this.audit.log(
        {
          action: "PAYOUT_EXECUTION_PRE_PROVIDER_ABORTED",
          entityType: "PayoutExecution",
          entityId: executionId,
          metadata: {
            withdrawalId,
            reason,
            abortedAt: abortedAt.toISOString(),
          },
          userId,
          organizationId: locked.withdrawal.publisher.organizationId,
        },
        tx,
      )
      return {
        executionId,
        status: "CANCELLED" as const,
        preProviderAbort: true,
      }
    })
  }

  async cancelExecution(executionId: string, userId: string, reason: string) {
    assertApiFinanceOperationAllowed("recovery")
    const operatorReason = normalizePayoutOperatorReason(reason)
    const execution = await this.prisma.payoutExecution.findUnique({
      where: { id: executionId },
      include: {
        withdrawal: {
          include: {
            publisher: true,
            payoutMethod: { include: { providerAccount: true } },
          },
        },
        provider: true,
      },
    })
    if (!execution) throw new NotFoundException("Payout execution not found")
    await this.recordOperatorIntent({
      action: "PAYOUT_CANCELLATION_REQUESTED",
      entityType: "PayoutExecution",
      entityId: executionId,
      userId,
      organizationId: execution.withdrawal.publisher.organizationId,
      reason: operatorReason,
      metadata: {
        withdrawalId: execution.withdrawalId,
        provider: execution.provider.name,
        stage: execution.stage,
      },
    })
    if (
      execution.status === "PROCESSING" &&
      execution.withdrawal.status === "PROCESSING" &&
      ["CREATED", "DESTINATION_VALIDATED"].includes(execution.stage) &&
      !execution.providerExecutionId &&
      !execution.providerTransferId &&
      !execution.providerPayoutId
    ) {
      return this.abortPreProviderExecution(
        execution.id,
        execution.withdrawalId,
        userId,
        "Finance cancelled a stranded execution before any provider call",
      )
    }
    if (!execution.providerExecutionId) {
      throw new ConflictException(
        "Provider outcome is not yet recorded; cancellation is blocked until reconciliation",
      )
    }
    const adapter = this.providerService.getAdapter(execution.provider.name)
    if (
      execution.provider.name !== "stripe_connect" ||
      !adapter.capabilities.supportsCancellation
    ) {
      throw new ConflictException(
        "This provider cannot supply durable reversal evidence; cancellation is blocked",
      )
    }
    if (
      !["PENDING", "PROCESSING"].includes(execution.status) ||
      !execution.providerExecutionId ||
      !execution.providerTransferId ||
      ![
        "TRANSFER_RECOVERY_REQUIRED",
        "BANK_PAYOUT_CREATED",
        "BANK_PAYOUT_PENDING",
        "BANK_PAYOUT_RECOVERY_REQUIRED",
        "CANCEL_REQUESTED",
      ].includes(execution.stage)
    ) {
      throw new ConflictException(
        "Payout is not in a provider-evidenced cancellable recovery stage",
      )
    }

    const claim = await this.runSerializable(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        execution.withdrawalId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
        executionId,
      )
      await this.assertEligibleFinanceActor(tx, userId)
      const locked = await tx.payoutExecution.findUnique({
        where: { id: executionId },
        include: {
          withdrawal: {
            include: {
              publisher: true,
              payoutMethod: { include: { providerAccount: true } },
            },
          },
          provider: true,
        },
      })
      const lockedConnectedAccountId = immutableProviderAccountId(locked)
      const expectedAmountMinor = exactUsdMinorAmount(
        locked?.destinationAmount ?? locked?.amount,
        locked?.destinationCurrency,
      )
      const freshCancellationLease =
        locked?.stage === "CANCEL_REQUESTED" &&
        !locked.errorMessage &&
        (!(locked.updatedAt instanceof Date) ||
          Date.now() - locked.updatedAt.getTime() < CLAIM_RECOVERY_MIN_AGE_MS)
      if (
        locked?.provider.name !== "stripe_connect" ||
        locked.withdrawal.method !== "stripe_connect" ||
        locked.withdrawal.payoutMethod?.type !== "stripe_connect" ||
        locked.withdrawal.payoutMethodId !==
          locked.withdrawal.payoutMethod?.id ||
        !["PENDING", "PROCESSING"].includes(locked.status) ||
        locked.withdrawal.status !== "PROCESSING" ||
        !locked.providerExecutionId ||
        !locked.providerTransferId ||
        locked.providerExecutionId !== locked.providerTransferId ||
        !locked.providerTransferId.startsWith("tr_") ||
        (locked.providerPayoutId &&
          !locked.providerPayoutId.startsWith("po_")) ||
        !lockedConnectedAccountId ||
        locked.withdrawal.payoutMethod?.providerAccount?.providerAccountId !==
          lockedConnectedAccountId ||
        expectedAmountMinor === null ||
        !locked.withdrawal.publicReference ||
        ![
          "TRANSFER_RECOVERY_REQUIRED",
          "BANK_PAYOUT_CREATED",
          "BANK_PAYOUT_PENDING",
          "BANK_PAYOUT_RECOVERY_REQUIRED",
          "CANCEL_REQUESTED",
        ].includes(locked.stage)
      ) {
        throw new ConflictException(
          `Execution ${executionId} is no longer cancellable`,
        )
      }
      if (freshCancellationLease) {
        throw new ConflictException(
          "A provider cancellation call is already in progress; retry only after its recovery lease expires",
        )
      }
      this.assertProviderModeForExecution(locked, "stripe_connect")
      const claimedVersion = locked.version + 1
      const claimed = await tx.payoutExecution.updateMany({
        where: {
          id: executionId,
          version: locked.version,
          status: locked.status,
          stage: locked.stage,
        },
        data: {
          stage: "CANCEL_REQUESTED",
          errorMessage: null,
          version: { increment: 1 },
        },
      })
      if (claimed.count !== 1) {
        throw new ConflictException(
          "Execution version changed before cancel could claim — lost race",
        )
      }
      await this.audit.log(
        {
          action: "PAYOUT_EXECUTION_CANCEL_REQUESTED",
          entityType: "PayoutExecution",
          entityId: executionId,
          metadata: {
            withdrawalId: locked.withdrawalId,
            claimedVersion,
            providerTransferId: locked.providerTransferId,
            providerPayoutId: locked.providerPayoutId,
            reclaimedCancellation: locked.stage === "CANCEL_REQUESTED",
            operatorReason,
          },
          userId,
          organizationId: locked.withdrawal.publisher.organizationId,
        },
        tx,
      )
      return {
        execution: locked,
        claimedVersion,
        connectedAccountId: lockedConnectedAccountId,
        expectedAmountMinor,
        expectedCurrency: USD_CURRENCY,
        expectedPublicReference: locked.withdrawal.publicReference,
      }
    })

    let cancellation: any
    let evidence: Record<string, unknown>
    let reversalId: string | null
    let evidenceTransferId: string | null
    let payoutStatus: string | null
    try {
      this.assertProviderModeForExecution(claim.execution, "stripe_connect")
      cancellation = await adapter.cancelTransfer(
        claim.execution.providerExecutionId,
        `payout-cancel-${executionId}`,
        {
          payoutExecutionId: executionId,
          connectedAccountId: claim.connectedAccountId,
          providerTransferId: claim.execution.providerTransferId ?? undefined,
          providerPayoutId: claim.execution.providerPayoutId ?? undefined,
          expectedAmountMinor: claim.expectedAmountMinor,
          expectedCurrency: claim.expectedCurrency,
          expectedPublicReference: claim.expectedPublicReference,
        },
      )
      const candidateEvidence = cancellation?.metadata
      evidence = isRecord(candidateEvidence) ? candidateEvidence : {}
      reversalId =
        typeof evidence.reversalId === "string" ? evidence.reversalId : null
      evidenceTransferId =
        typeof evidence.transferId === "string" ? evidence.transferId : null
      payoutStatus =
        typeof evidence.payoutStatus === "string" ? evidence.payoutStatus : null
      const evidencePayoutId =
        typeof evidence.payoutId === "string" ? evidence.payoutId : null
      const expectedPayoutId = claim.execution.providerPayoutId ?? null
      const commonEvidenceMatches =
        cancellation?.livemode === claim.execution.livemode &&
        evidence.livemode === claim.execution.livemode &&
        cancellation?.providerExecutionId ===
          claim.execution.providerExecutionId &&
        evidence.payoutExecutionId === executionId &&
        evidenceTransferId === claim.execution.providerTransferId &&
        evidencePayoutId === expectedPayoutId &&
        evidence.connectedAccountId === claim.connectedAccountId &&
        Number.isSafeInteger(evidence.providerAmountMinor) &&
        evidence.providerAmountMinor === claim.expectedAmountMinor &&
        evidence.providerCurrency === claim.expectedCurrency &&
        evidence.providerPublicReference === claim.expectedPublicReference
      const authenticatedPaidRace =
        cancellation?.success === false &&
        expectedPayoutId !== null &&
        payoutStatus === "paid" &&
        reversalId === null
      const authenticatedReversal =
        cancellation?.success === true &&
        typeof reversalId === "string" &&
        reversalId.startsWith("trr_") &&
        (expectedPayoutId === null
          ? payoutStatus === null
          : ["canceled", "failed"].includes(payoutStatus ?? ""))
      if (
        !commonEvidenceMatches ||
        (!authenticatedPaidRace && !authenticatedReversal)
      ) {
        throw payoutConflict(
          "PAYOUT_CANCELLATION_EVIDENCE_MISMATCH",
          "Stripe cancellation evidence does not match the immutable payout execution",
        )
      }
    } catch {
      const safeMessage =
        "Provider cancellation evidence could not be authenticated; funds remain reserved for Finance reconciliation"
      await this.runSerializable(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
          claim.execution.withdrawalId,
        )
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 AND "withdrawalId" = $2 FOR UPDATE',
          executionId,
          claim.execution.withdrawalId,
        )
        const held = await tx.payoutExecution.updateMany({
          where: {
            id: executionId,
            version: claim.claimedVersion,
            status: { in: ["PENDING", "PROCESSING"] },
            stage: "CANCEL_REQUESTED",
          },
          data: {
            errorMessage: safeMessage,
            version: { increment: 1 },
          },
        })
        if (held.count !== 1) return
        const staff = await tx.staffMembership.findMany({
          where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
          select: { userId: true },
        })
        if (staff.length > 0) {
          await tx.notification.createMany({
            data: staff.map((member: { userId: string }) => ({
              userId: member.userId,
              organizationId:
                claim.execution.withdrawal.publisher.organizationId,
              type: "PAYOUT_CANCELLATION_EVIDENCE_CONFLICT",
              message: `Payout execution ${executionId} remains reserved after cancellation evidence failed validation`,
              dedupKey: `payout-cancellation-evidence:${executionId}:${member.userId}`,
            })),
            skipDuplicates: true,
          })
        }
        await this.audit.log(
          {
            action: "PAYOUT_CANCELLATION_EVIDENCE_QUARANTINED",
            entityType: "PayoutExecution",
            entityId: executionId,
            metadata: {
              withdrawalId: claim.execution.withdrawalId,
              providerTransferId: claim.execution.providerTransferId,
              providerPayoutId: claim.execution.providerPayoutId,
            },
            userId,
            organizationId: claim.execution.withdrawal.publisher.organizationId,
          },
          tx,
        )
      })
      throw new ConflictException(safeMessage)
    }
    if (
      payoutStatus === "paid" &&
      claim.execution.providerPayoutId &&
      evidence.payoutId === claim.execution.providerPayoutId
    ) {
      const recovered = await this.updateExecutionWithParentLock({
        withdrawalId: claim.execution.withdrawalId,
        executionId,
        where: {
          version: claim.claimedVersion,
          status: "PROCESSING",
          stage: "CANCEL_REQUESTED",
        },
        data: {
          stage: "BANK_PAID",
          providerMetadata: mergeInternalMetadata(
            claim.execution.providerMetadata,
            {
              cancellationRace: {
                outcome: "ALREADY_PAID",
                providerPayoutId: claim.execution.providerPayoutId,
                observedAt: evidence.payoutObservedAt,
              },
            },
          ) as any,
          version: { increment: 1 },
        },
      })
      if (recovered.count !== 1) {
        throw new ConflictException(
          "Paid payout evidence was authenticated but local recovery lost a race",
        )
      }
      const completed = await finalizePayoutExecution(this.prisma, {
        executionId,
        withdrawalId: claim.execution.withdrawalId,
        providerName: "stripe_connect",
        providerReference: claim.execution.providerPayoutId,
        source: "PROVIDER_RESPONSE",
        evidenceAt: new Date(),
        providerAmountMinor: evidence.providerAmountMinor as
          | number
          | string
          | undefined,
        providerCurrency:
          typeof evidence.providerCurrency === "string"
            ? evidence.providerCurrency
            : undefined,
        metadata: {
          cancellationRace: "ALREADY_PAID",
          payoutObservedAt: evidence.payoutObservedAt,
        },
      })
      if (completed.kind === "conflict") {
        throw new ConflictException(
          `Paid cancellation race requires reconciliation: ${completed.code}`,
        )
      }
      return {
        executionId,
        status: "COMPLETED",
        recoveredFromCancellationRace: true,
      }
    }
    if (
      !cancellation.success ||
      !reversalId ||
      evidenceTransferId !== claim.execution.providerTransferId ||
      (claim.execution.providerPayoutId &&
        !["canceled", "failed"].includes(payoutStatus ?? ""))
    ) {
      throw new ConflictException(
        "Provider cancellation did not return complete payout and transfer-reversal evidence; funds remain reserved",
      )
    }

    const cancellationRecordedAt = new Date()
    const cancellationEvidence = {
      ...evidence,
      source: "PROVIDER_RESPONSE",
      provider: "stripe_connect",
      providerExecutionId: cancellation.providerExecutionId,
      providerTransferId: claim.execution.providerTransferId,
      providerPayoutId: claim.execution.providerPayoutId,
      reversalId,
      payoutStatus,
      evidenceAt: cancellationRecordedAt.toISOString(),
      cancelledAt: cancellationRecordedAt.toISOString(),
      actorUserId: userId,
    }
    await this.runSerializable(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        claim.execution.withdrawalId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 AND "withdrawalId" = $2 FOR UPDATE',
        executionId,
        claim.execution.withdrawalId,
      )
      await this.assertEligibleFinanceActor(tx, userId)
      const finalized = await tx.payoutExecution.updateMany({
        where: {
          id: executionId,
          version: claim.claimedVersion,
          status: { in: ["PENDING", "PROCESSING"] },
          stage: "CANCEL_REQUESTED",
        },
        data: {
          status: "CANCELLED",
          stage: "CANCELLED_REVERSED",
          cancellationSource: "PROVIDER_RESPONSE",
          cancellationEvidenceRef: reversalId,
          cancellationEvidenceAt: cancellationRecordedAt,
          cancellationPayoutStatus: payoutStatus,
          cancelledAt: cancellationRecordedAt,
          cancellationActorUserId: userId,
          providerMetadata: mergeInternalMetadata(
            claim.execution.providerMetadata,
            { cancellation: cancellationEvidence },
          ),
          errorMessage: null,
          version: { increment: 1 },
        },
      })
      if (finalized.count !== 1) {
        throw new ConflictException(
          "Execution changed while provider cancellation was in progress",
        )
      }
      const wUpdated = await tx.withdrawal.updateMany({
        where: {
          id: claim.execution.withdrawalId,
          status: "PROCESSING",
          version: claim.execution.withdrawal.version,
        },
        data: { status: "APPROVED", version: { increment: 1 } },
      })
      if (wUpdated.count !== 1) {
        throw new ConflictException(
          "Withdrawal changed while provider cancellation was in progress",
        )
      }
      await this.audit.log(
        {
          action: "PAYOUT_EXECUTION_CANCELLED",
          entityType: "PayoutExecution",
          entityId: executionId,
          metadata: {
            withdrawalId: claim.execution.withdrawalId,
            claimedVersion: claim.claimedVersion,
            providerTransferId: claim.execution.providerTransferId,
            providerPayoutId: claim.execution.providerPayoutId,
            reversalId,
            payoutStatus,
          },
          userId,
          organizationId: claim.execution.withdrawal.publisher.organizationId,
        },
        tx,
      )
    })
    return {
      executionId,
      status: "CANCELLED",
      reversalId,
    }
  }

  async getExecutionsForWithdrawal(withdrawalId: string) {
    return this.prisma.payoutExecution.findMany({
      where: { withdrawalId },
      orderBy: { createdAt: "desc" },
      include: {
        provider: { select: { id: true, name: true, displayName: true } },
      },
    })
  }

  async getPendingStatusChecks(limit = 50) {
    return this.prisma.payoutExecution.findMany({
      where: { status: "PROCESSING", providerExecutionId: { not: null } },
      take: limit,
      orderBy: { createdAt: "asc" },
      include: {
        withdrawal: { include: { publisher: true } },
        provider: true,
      },
    })
  }
}
