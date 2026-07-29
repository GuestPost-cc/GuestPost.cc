import { prisma } from "@guestpost/database"
import { assertFinanceOperationAllowed } from "@guestpost/shared/dist/finance-runtime-mode"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import {
  PaymentDisputeTransitionError,
  paymentDisputeEventFromStoredRow,
  transitionPaymentDispute,
} from "@guestpost/shared/dist/payment-dispute-core"
import { trustedPrismaErrorCodes } from "@guestpost/shared/dist/prisma-transaction-retry"

const logger = createLogger("worker.payment-dispute-inbox")

export const PAYMENT_DISPUTE_INBOX_MAX_RETRY_AGE_MS = 72 * 60 * 60 * 1000
export const PAYMENT_DISPUTE_INBOX_MAX_ATTEMPTS = 432
export const PAYMENT_DISPUTE_INBOX_LEASE_MS = 15 * 60 * 1000

interface InboxSummary {
  eligible: number
  claimed: number
  processed: number
  retried: number
  quarantined: number
  staleRecovered: number
}

interface InboxLease {
  attempts: number
  lockedAt: Date
}

function ownsLease(event: any, lease: InboxLease): boolean {
  return Boolean(
    event &&
      event.status === "PROCESSING" &&
      event.attempts === lease.attempts &&
      event.lockedAt != null &&
      new Date(event.lockedAt).getTime() === lease.lockedAt.getTime(),
  )
}

function retryDelayMs(attempts: number): number {
  return Math.min(10 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attempts - 1))
}

function safeErrorCode(error: unknown): string {
  if (error instanceof PaymentDisputeTransitionError) return error.code
  if (trustedPrismaErrorCodes(error).has("23514")) {
    return "FINANCIAL_EVIDENCE_CONSTRAINT"
  }
  return "TRANSIENT_PROCESSING_FAILURE"
}

async function notifyFinance(
  tx: any,
  input: { type: string; message: string; dedupKeyPrefix: string },
): Promise<void> {
  const staff = await tx.staffMembership.findMany({
    where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
    select: { userId: true },
  })
  if (staff.length === 0) return
  await tx.notification.createMany({
    data: staff.map((member: { userId: string }) => ({
      userId: member.userId,
      organizationId: null,
      type: input.type,
      message: input.message,
      dedupKey: `${input.dedupKeyPrefix}:${member.userId}`,
    })),
    skipDuplicates: true,
  })
}

async function quarantineEvent(
  client: any,
  eventId: string,
  reason: string,
  lease: InboxLease,
): Promise<boolean> {
  const safeReason = reason.slice(0, 100)
  return client.$transaction(async (tx: any) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "PaymentProviderEvent" WHERE "id" = $1 FOR UPDATE',
      eventId,
    )
    const event = await tx.paymentProviderEvent.findUnique({
      where: { id: eventId },
    })
    if (!ownsLease(event, lease)) {
      return false
    }
    const updated = await tx.paymentProviderEvent.updateMany({
      where: {
        id: eventId,
        status: "PROCESSING",
        attempts: lease.attempts,
        lockedAt: lease.lockedAt,
      },
      data: {
        status: "QUARANTINED",
        processedAt: new Date(),
        lockedAt: null,
        lastError: safeReason,
      },
    })
    if (updated.count !== 1) return false

    await tx.auditLog.create({
      data: {
        action: "PAYMENT_DISPUTE_INBOX_QUARANTINED",
        entityType: "PaymentProviderEvent",
        entityId: event.id,
        metadata: {
          provider: event.provider,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          attempts: event.attempts,
          reason: safeReason,
        },
        userId: null,
        organizationId: null,
      },
    })
    await notifyFinance(tx, {
      type: "PAYMENT_DISPUTE_INBOX_QUARANTINED",
      message: `Payment dispute event ${event.providerEventId} was quarantined (${safeReason}). Finance review is required.`,
      dedupKeyPrefix: `payment-dispute-inbox-quarantine:${event.id}:${safeReason}`,
    })
    return true
  })
}

export async function processPaymentDisputeInbox(
  limit = 100,
  client: any = prisma,
  now = new Date(),
): Promise<InboxSummary> {
  // Keep the guard at the mutation boundary. The scheduler and on-demand lane
  // both call this function, and future callers must not be able to claim an
  // inbox row while the financial kill switch is locked.
  assertFinanceOperationAllowed("recovery")
  const batchSize = Math.min(Math.max(Math.floor(limit), 1), 500)
  const stale = await client.paymentProviderEvent.updateMany({
    where: {
      eventType: {
        in: ["charge.dispute.created", "charge.dispute.closed"],
      },
      status: "PROCESSING",
      lockedAt: {
        lt: new Date(now.getTime() - PAYMENT_DISPUTE_INBOX_LEASE_MS),
      },
    },
    data: {
      status: "FAILED",
      availableAt: now,
      lockedAt: null,
      lastError: "STALE_PROCESSING_LEASE",
    },
  })

  const eligible = await client.paymentProviderEvent.findMany({
    where: {
      eventType: {
        in: ["charge.dispute.created", "charge.dispute.closed"],
      },
      status: { in: ["PENDING", "FAILED"] },
      availableAt: { lte: now },
    },
    select: { id: true, attempts: true },
    orderBy: [{ availableAt: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
    take: batchSize,
  })
  const summary: InboxSummary = {
    eligible: eligible.length,
    claimed: 0,
    processed: 0,
    retried: 0,
    quarantined: 0,
    staleRecovered: stale.count,
  }

  for (const candidate of eligible) {
    const previousAttempts = Number(candidate.attempts)
    if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 0) {
      logger.error("payment dispute event has invalid claim counter", {
        eventId: candidate.id,
      })
      continue
    }
    const lease: InboxLease = {
      attempts: previousAttempts + 1,
      lockedAt: now,
    }
    const claimed = await client.paymentProviderEvent.updateMany({
      where: {
        id: candidate.id,
        status: { in: ["PENDING", "FAILED"] },
        attempts: previousAttempts,
        lockedAt: null,
        availableAt: { lte: now },
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

    const event = await client.paymentProviderEvent.findUnique({
      where: { id: candidate.id },
    })
    if (!ownsLease(event, lease)) {
      logger.warn("payment dispute event lease changed before processing", {
        eventId: candidate.id,
        claimAttempt: lease.attempts,
      })
      continue
    }
    try {
      const input = paymentDisputeEventFromStoredRow(event)
      await transitionPaymentDispute(
        client,
        {
          audit: async (tx, auditInput) => {
            await tx.auditLog.create({ data: auditInput })
          },
          notifyFinance,
        },
        input,
      )
      summary.processed++
    } catch (error) {
      const code = safeErrorCode(error)
      const deterministic =
        (error instanceof PaymentDisputeTransitionError && !error.retryable) ||
        code === "FINANCIAL_EVIDENCE_CONSTRAINT"
      const attempts = Number(event?.attempts ?? 0)
      const receivedAt = new Date(event?.receivedAt ?? now)
      const exhausted =
        attempts >= PAYMENT_DISPUTE_INBOX_MAX_ATTEMPTS ||
        now.getTime() - receivedAt.getTime() >=
          PAYMENT_DISPUTE_INBOX_MAX_RETRY_AGE_MS

      if (deterministic || exhausted) {
        const reason = exhausted ? `RETRY_EXHAUSTED_${code}` : code
        const quarantined = await quarantineEvent(
          client,
          candidate.id,
          reason,
          lease,
        )
        if (quarantined) {
          summary.quarantined++
          logger.error("payment dispute event quarantined", {
            eventId: candidate.id,
            reason,
            attempts,
          })
        } else {
          logger.warn(
            "payment dispute event lease changed before quarantine; stale owner made no mutation",
            {
              eventId: candidate.id,
              reason,
              claimAttempt: lease.attempts,
            },
          )
        }
        continue
      }

      const availableAt = new Date(
        now.getTime() + retryDelayMs(Math.max(attempts, 1)),
      )
      const failed = await client.paymentProviderEvent.updateMany({
        where: {
          id: candidate.id,
          status: "PROCESSING",
          attempts: lease.attempts,
          lockedAt: lease.lockedAt,
        },
        data: {
          status: "FAILED",
          availableAt,
          lockedAt: null,
          lastError: code,
        },
      })
      if (failed.count === 1) {
        summary.retried++
        logger.warn("payment dispute event retry scheduled", {
          eventId: candidate.id,
          attempts,
          availableAt: availableAt.toISOString(),
          code,
        })
      } else {
        logger.warn(
          "payment dispute event lease changed before retry; stale owner made no mutation",
          {
            eventId: candidate.id,
            code,
            claimAttempt: lease.attempts,
          },
        )
      }
    }
  }

  return summary
}
