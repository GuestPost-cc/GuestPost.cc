import { prisma } from "@guestpost/database"
import {
  isWalletCreditBackedDepositStatus,
  recordCommunicationOutbox,
} from "@guestpost/shared"
import {
  assertDepositRecoveryEvidenceMatchesAttempt,
  DepositCreditFinalizationError,
  depositCreditFactsFromRecoveryEvidence,
  finalizeDepositCredit,
} from "@guestpost/shared/dist/deposit-credit-core"
import { assertFinanceOperationAllowed } from "@guestpost/shared/dist/finance-runtime-mode"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { isPrismaUniqueConstraintError } from "@guestpost/shared/dist/prisma-transaction-retry"
import {
  retrieveStripeDepositEvidence,
  StripeDepositRecoveryError,
  type StripeDepositRecoveryEvidence,
  stripeDepositEvidenceCreateData,
} from "@guestpost/shared/dist/stripe-deposit-recovery"

const logger = createLogger("worker.deposit-credit-recovery")

export const DEPOSIT_CREDIT_RECOVERY_MIN_AGE_MS = 15 * 60 * 1000
export const DEPOSIT_CREDIT_RECOVERY_LEASE_MS = 15 * 60 * 1000
export const DEPOSIT_CREDIT_RECOVERY_MAX_BATCH = 100

export interface RecoveryLease {
  attempts: number
  lockedAt: Date
}

export interface DepositCreditRecoverySummary {
  seeded: number
  eligible: number
  claimed: number
  credited: number
  replayed: number
  closedUnpaid: number
  superseded: number
  retried: number
  quarantined: number
  staleRecovered: number
}

type EvidenceRetriever = (
  providerSessionId: string,
) => Promise<StripeDepositRecoveryEvidence>

function ownsLease(recovery: any, lease: RecoveryLease): boolean {
  return Boolean(
    recovery &&
      recovery.status === "PROCESSING" &&
      recovery.attempts === lease.attempts &&
      recovery.lockedAt != null &&
      new Date(recovery.lockedAt).getTime() === lease.lockedAt.getTime(),
  )
}

function retryDelayMs(attempts: number): number {
  return Math.min(30 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attempts - 1))
}

function safeErrorCode(error: unknown): string {
  if (error instanceof DepositCreditFinalizationError) return error.code
  if (error instanceof StripeDepositRecoveryError) return error.code
  return "TRANSIENT_DEPOSIT_RECOVERY_FAILURE"
}

async function financeRecipients(tx: any): Promise<string[]> {
  const staff = await tx.staffMembership.findMany({
    where: {
      role: { in: ["FINANCE", "SUPER_ADMIN"] },
      user: { banned: false },
    },
    select: { userId: true },
  })
  return staff.map((member: { userId: string }) => member.userId)
}

async function quarantineRecovery(
  client: any,
  recoveryId: string,
  lease: RecoveryLease,
  reason: string,
  evidenceId: string | null,
): Promise<boolean> {
  const safeReason = reason.slice(0, 100)
  return client.$transaction(async (tx: any) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "DepositCreditRecovery" WHERE "id" = $1 FOR UPDATE',
      recoveryId,
    )
    const recovery = await tx.depositCreditRecovery.findUnique({
      where: { id: recoveryId },
    })
    if (!ownsLease(recovery, lease)) return false
    const updated = await tx.depositCreditRecovery.updateMany({
      where: {
        id: recoveryId,
        status: "PROCESSING",
        attempts: lease.attempts,
        lockedAt: lease.lockedAt,
      },
      data: {
        status: "QUARANTINED",
        processedAt: new Date(),
        lockedAt: null,
        evidenceId,
        lastError: safeReason,
      },
    })
    if (updated.count !== 1) return false
    await tx.auditLog.create({
      data: {
        action: "DEPOSIT_CREDIT_RECOVERY_QUARANTINED",
        entityType: "DepositCreditRecovery",
        entityId: recovery.id,
        metadata: {
          depositAttemptId: recovery.depositAttemptId,
          provider: recovery.provider,
          attempts: recovery.attempts,
          evidenceId,
          reason: safeReason,
        },
        userId: null,
        organizationId: null,
      },
    })
    const recipients = await financeRecipients(tx)
    if (recipients.length > 0) {
      await tx.notification.createMany({
        data: recipients.map((userId) => ({
          userId,
          organizationId: null,
          type: "DEPOSIT_CREDIT_RECOVERY_QUARANTINED",
          title: "Deposit recovery needs review",
          message: `Deposit recovery ${recovery.id} was quarantined (${safeReason}).`,
          dedupKey: `deposit-credit-recovery:${recovery.id}:${safeReason}:${userId}`,
        })),
        skipDuplicates: true,
      })
    }
    return true
  })
}

async function retryRecovery(
  client: any,
  recoveryId: string,
  lease: RecoveryLease,
  reason: string,
  now: Date,
): Promise<boolean> {
  const updated = await client.depositCreditRecovery.updateMany({
    where: {
      id: recoveryId,
      status: "PROCESSING",
      attempts: lease.attempts,
      lockedAt: lease.lockedAt,
    },
    data: {
      status: "FAILED",
      availableAt: new Date(now.getTime() + retryDelayMs(lease.attempts)),
      lockedAt: null,
      lastError: reason.slice(0, 100),
    },
  })
  return updated.count === 1
}

async function persistEvidence(
  client: any,
  recovery: any,
  lease: RecoveryLease,
  evidence: StripeDepositRecoveryEvidence,
): Promise<any> {
  return client.$transaction(async (tx: any) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "DepositCreditRecovery" WHERE "id" = $1 FOR UPDATE',
      recovery.id,
    )
    const current = await tx.depositCreditRecovery.findUnique({
      where: { id: recovery.id },
    })
    if (!ownsLease(current, lease)) {
      throw new DepositCreditFinalizationError("AUTHORITY_LEASE_LOST", false)
    }
    try {
      return await tx.depositCreditEvidence.create({
        data: stripeDepositEvidenceCreateData(
          recovery.id,
          recovery.depositAttemptId,
          evidence,
          lease.attempts,
          lease.lockedAt,
        ),
      })
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) throw error
      const existing = await tx.depositCreditEvidence.findUnique({
        where: {
          recoveryId_claimAttempt_evidenceFingerprint: {
            recoveryId: recovery.id,
            claimAttempt: lease.attempts,
            evidenceFingerprint: evidence.evidenceFingerprint,
          },
        },
      })
      if (!existing) throw error
      return existing
    }
  })
}

export async function closeUnpaidRecovery(
  client: any,
  recoveryId: string,
  lease: RecoveryLease,
  evidenceId: string,
  evidence: StripeDepositRecoveryEvidence,
): Promise<"CLOSED_UNPAID" | "SUPERSEDED" | "LEASE_LOST"> {
  return client.$transaction(async (tx: any) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "DepositCreditRecovery" WHERE "id" = $1 FOR UPDATE',
      recoveryId,
    )
    const recovery = await tx.depositCreditRecovery.findUnique({
      where: { id: recoveryId },
    })
    if (!ownsLease(recovery, lease)) return "LEASE_LOST"
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "DepositAttempt" WHERE "id" = $1 FOR UPDATE',
      recovery.depositAttemptId,
    )
    const attempt = await tx.depositAttempt.findUnique({
      where: { id: recovery.depositAttemptId },
    })
    if (!attempt) {
      throw new DepositCreditFinalizationError(
        "DEPOSIT_ATTEMPT_NOT_FOUND",
        false,
      )
    }
    if (
      isWalletCreditBackedDepositStatus(attempt.status) &&
      attempt.ledgerTransactionId
    ) {
      const ledger = await tx.transaction.findUnique({
        where: { id: attempt.ledgerTransactionId },
      })
      if (
        ledger?.type !== "DEPOSIT" ||
        ledger.walletId !== attempt.walletId ||
        ledger.reference !== attempt.providerSessionId ||
        ledger.provider !== attempt.provider ||
        ledger.providerRef !== attempt.providerPaymentId ||
        ledger.currency !== attempt.currency ||
        String(ledger.amount) !== String(attempt.walletCredit)
      ) {
        throw new DepositCreditFinalizationError(
          "DEPOSIT_IDEMPOTENCY_COLLISION",
          false,
        )
      }
      const superseded = await tx.depositCreditRecovery.updateMany({
        where: {
          id: recoveryId,
          status: "PROCESSING",
          attempts: lease.attempts,
          lockedAt: lease.lockedAt,
          evidenceId: null,
        },
        data: {
          status: "SUPERSEDED",
          processedAt: new Date(),
          lockedAt: null,
          lastError: null,
        },
      })
      return superseded.count === 1 ? "SUPERSEDED" : "LEASE_LOST"
    }
    if (
      attempt.status !== "CREATED" &&
      attempt.status !== "PENDING_CUSTOMER_ACTION" &&
      attempt.status !== "PROCESSING" &&
      attempt.status !== "FAILED" &&
      attempt.status !== "EXPIRED"
    ) {
      throw new DepositCreditFinalizationError(
        "DEPOSIT_ATTEMPT_STATE_MISMATCH",
        false,
      )
    }
    assertDepositRecoveryEvidenceMatchesAttempt(attempt, evidence)
    if (attempt.status !== "EXPIRED") {
      const expired = await tx.depositAttempt.updateMany({
        where: {
          id: attempt.id,
          provider: "stripe",
          providerSessionId: evidence.providerSessionId,
          walletId: attempt.walletId,
          amount: attempt.amount,
          walletCredit: attempt.walletCredit,
          customerFee: attempt.customerFee,
          currency: "USD",
          ledgerTransactionId: null,
          status: {
            in: ["CREATED", "PENDING_CUSTOMER_ACTION", "PROCESSING", "FAILED"],
          },
        },
        data: { status: "EXPIRED", failedAt: new Date() },
      })
      if (expired.count !== 1) {
        throw new DepositCreditFinalizationError("CONCURRENT_CHANGE", true)
      }
    }
    const completed = await tx.depositCreditRecovery.updateMany({
      where: {
        id: recoveryId,
        status: "PROCESSING",
        attempts: lease.attempts,
        lockedAt: lease.lockedAt,
      },
      data: {
        status: "CLOSED_UNPAID",
        processedAt: new Date(),
        lockedAt: null,
        evidenceId,
        lastError: null,
      },
    })
    return completed.count === 1 ? "CLOSED_UNPAID" : "LEASE_LOST"
  })
}

async function supersedeCreditedRecovery(
  client: any,
  recoveryId: string,
  lease: RecoveryLease,
): Promise<boolean> {
  return client.$transaction(async (tx: any) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "DepositCreditRecovery" WHERE "id" = $1 FOR UPDATE',
      recoveryId,
    )
    const recovery = await tx.depositCreditRecovery.findUnique({
      where: { id: recoveryId },
    })
    if (!ownsLease(recovery, lease)) return false
    const attempt = await tx.depositAttempt.findUnique({
      where: { id: recovery.depositAttemptId },
    })
    if (
      !attempt ||
      !isWalletCreditBackedDepositStatus(attempt.status) ||
      !attempt.ledgerTransactionId
    ) {
      return false
    }
    const ledger = await tx.transaction.findUnique({
      where: { id: attempt.ledgerTransactionId },
    })
    if (
      ledger?.type !== "DEPOSIT" ||
      ledger.walletId !== attempt.walletId ||
      ledger.reference !== attempt.providerSessionId ||
      ledger.provider !== attempt.provider ||
      ledger.providerRef !== attempt.providerPaymentId ||
      ledger.currency !== attempt.currency ||
      String(ledger.amount) !== String(attempt.walletCredit)
    ) {
      return false
    }
    const completed = await tx.depositCreditRecovery.updateMany({
      where: {
        id: recoveryId,
        status: "PROCESSING",
        attempts: lease.attempts,
        lockedAt: lease.lockedAt,
      },
      data: {
        status: "SUPERSEDED",
        processedAt: new Date(),
        lockedAt: null,
        lastError: null,
      },
    })
    return completed.count === 1
  })
}

async function canonicalHooks() {
  return {
    audit: async (tx: any, input: any) => {
      await tx.auditLog.create({ data: input })
    },
    recordSuccess: async (tx: any, input: any): Promise<string[]> => {
      const owners = input.organizationId
        ? await tx.membership.findMany({
            where: {
              organizationId: input.organizationId,
              status: "ACTIVE",
              role: "OWNER",
            },
            select: { userId: true },
          })
        : []
      const recipientUserIds = [
        ...new Set<string>([
          input.createdByUserId,
          ...owners.map((owner: { userId: string }) => owner.userId),
        ]),
      ]
      const event = await recordCommunicationOutbox(tx, {
        type: "BILLING_DEPOSIT_SUCCEEDED",
        aggregateType: "DepositAttempt",
        aggregateId: input.depositAttemptId,
        organizationId: input.organizationId,
        title: "Wallet deposit completed",
        message: `${input.amount} ${input.currency} was added to your wallet.`,
        actionPath: "/dashboard/billing",
        dedupKey: `deposit:${input.depositAttemptId}:succeeded`,
        recipientUserIds,
      })
      const eventIds = [event.eventId]
      const threshold = Number(
        process.env.ADMIN_HIGH_VALUE_DEPOSIT_THRESHOLD ?? "1000",
      )
      if (
        Number(input.amount) > (Number.isFinite(threshold) ? threshold : 1000)
      ) {
        const staff = await tx.staffMembership.findMany({
          where: {
            role: { in: ["SUPER_ADMIN", "FINANCE"] },
            user: { banned: false },
          },
          select: { userId: true },
        })
        const staffEvent = await recordCommunicationOutbox(tx, {
          type: "STAFF_HIGH_VALUE_DEPOSIT",
          aggregateType: "DepositAttempt",
          aggregateId: input.depositAttemptId,
          organizationId: input.organizationId,
          title: "High-value wallet deposit",
          message: `${input.amount} ${input.currency} was deposited into a customer wallet.`,
          actionPath: "/dashboard/finance",
          payload: {
            amount: input.amount,
            currency: input.currency,
            walletId: input.walletId,
          },
          dedupKey: `staff:deposit:${input.depositAttemptId}:high-value`,
          recipientUserIds: staff.map(
            (member: { userId: string }) => member.userId,
          ),
        })
        eventIds.push(staffEvent.eventId)
      }
      return eventIds
    },
  }
}

export async function processDepositCreditRecovery(
  limit = 25,
  client: any = prisma,
  now = new Date(),
  retrieveEvidence: EvidenceRetriever = retrieveStripeDepositEvidence,
): Promise<DepositCreditRecoverySummary> {
  assertFinanceOperationAllowed("recovery")
  const batchSize = Math.min(
    Math.max(Math.floor(limit), 1),
    DEPOSIT_CREDIT_RECOVERY_MAX_BATCH,
  )
  const minimumCreatedAt = new Date(
    now.getTime() - DEPOSIT_CREDIT_RECOVERY_MIN_AGE_MS,
  )
  const attempts = await client.depositAttempt.findMany({
    where: {
      provider: "stripe",
      providerSessionId: { not: null },
      ledgerTransactionId: null,
      creditRecovery: { is: null },
      status: {
        in: [
          "CREATED",
          "PENDING_CUSTOMER_ACTION",
          "PROCESSING",
          "FAILED",
          "EXPIRED",
        ],
      },
      createdAt: { lte: minimumCreatedAt },
    },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize * 2,
  })
  let seeded = 0
  for (const attempt of attempts) {
    try {
      await client.depositCreditRecovery.create({
        data: { depositAttemptId: attempt.id },
      })
      seeded++
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) throw error
    }
  }

  const stale = await client.depositCreditRecovery.updateMany({
    where: {
      status: "PROCESSING",
      lockedAt: {
        lt: new Date(now.getTime() - DEPOSIT_CREDIT_RECOVERY_LEASE_MS),
      },
    },
    data: {
      status: "FAILED",
      availableAt: now,
      lockedAt: null,
      lastError: "STALE_PROCESSING_LEASE",
    },
  })
  const eligible = await client.depositCreditRecovery.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      availableAt: { lte: now },
    },
    select: { id: true, attempts: true },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
  })
  const summary: DepositCreditRecoverySummary = {
    seeded,
    eligible: eligible.length,
    claimed: 0,
    credited: 0,
    replayed: 0,
    closedUnpaid: 0,
    superseded: 0,
    retried: 0,
    quarantined: 0,
    staleRecovered: stale.count,
  }

  for (const candidate of eligible) {
    const previousAttempts = Number(candidate.attempts)
    if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 0) {
      logger.error("deposit recovery has invalid claim counter", {
        recoveryId: candidate.id,
      })
      continue
    }
    const lease: RecoveryLease = {
      attempts: previousAttempts + 1,
      lockedAt: now,
    }
    const claimed = await client.depositCreditRecovery.updateMany({
      where: {
        id: candidate.id,
        status: { in: ["PENDING", "FAILED"] },
        attempts: previousAttempts,
        availableAt: { lte: now },
        lockedAt: null,
      },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lockedAt: now,
        lastError: null,
      },
    })
    if (claimed.count !== 1) continue
    summary.claimed++
    const recovery = await client.depositCreditRecovery.findUnique({
      where: { id: candidate.id },
      include: { depositAttempt: true },
    })
    if (!ownsLease(recovery, lease)) continue
    if (
      isWalletCreditBackedDepositStatus(recovery.depositAttempt.status) &&
      recovery.depositAttempt.ledgerTransactionId
    ) {
      if (await supersedeCreditedRecovery(client, recovery.id, lease)) {
        summary.superseded++
      } else if (
        await retryRecovery(
          client,
          recovery.id,
          lease,
          "CREDITED_ATTEMPT_EVIDENCE_MISMATCH",
          now,
        )
      ) {
        summary.retried++
      }
      continue
    }

    let evidenceRow: any = null
    try {
      const evidence = await retrieveEvidence(
        recovery.depositAttempt.providerSessionId,
      )
      evidenceRow = await persistEvidence(client, recovery, lease, evidence)
      assertDepositRecoveryEvidenceMatchesAttempt(
        recovery.depositAttempt,
        evidence,
      )
      if (
        evidence.checkoutStatus === "expired" &&
        evidence.checkoutPaymentStatus === "unpaid"
      ) {
        const closure = await closeUnpaidRecovery(
          client,
          recovery.id,
          lease,
          evidenceRow.id,
          evidence,
        )
        if (closure === "CLOSED_UNPAID") {
          summary.closedUnpaid++
        } else if (closure === "SUPERSEDED") {
          summary.superseded++
        }
        continue
      }
      if (evidence.checkoutPaymentStatus !== "paid") {
        if (
          await retryRecovery(
            client,
            recovery.id,
            lease,
            "PAYMENT_NOT_YET_PAID",
            now,
          )
        ) {
          summary.retried++
        }
        continue
      }
      const outcome = await finalizeDepositCredit(
        client,
        await canonicalHooks(),
        {
          authority: {
            kind: "RECOVERY",
            recoveryId: recovery.id,
            evidenceId: evidenceRow.id,
            attempts: lease.attempts,
            lockedAt: lease.lockedAt,
          },
          facts: depositCreditFactsFromRecoveryEvidence(evidence),
        },
      )
      if (outcome.credited) summary.credited++
      else summary.replayed++
    } catch (error) {
      const code = safeErrorCode(error)
      const deterministic =
        (error instanceof DepositCreditFinalizationError && !error.retryable) ||
        (error instanceof StripeDepositRecoveryError && !error.retryable)
      if (deterministic) {
        if (
          await quarantineRecovery(
            client,
            recovery.id,
            lease,
            code,
            evidenceRow?.id ?? null,
          )
        ) {
          summary.quarantined++
        }
      } else if (await retryRecovery(client, recovery.id, lease, code, now)) {
        summary.retried++
      }
      logger.warn("deposit credit recovery attempt did not finalize", {
        recoveryId: recovery.id,
        code,
        deterministic,
      })
    }
  }
  return summary
}
