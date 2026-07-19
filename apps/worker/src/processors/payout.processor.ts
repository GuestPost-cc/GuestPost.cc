import { prisma } from "@guestpost/database"
import {
  checkProviderTransferStatus,
  normalizeProviderWebhook,
  QUEUES,
} from "@guestpost/shared"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { createObservableWorker } from "../lib/queue-observability"
import { connection } from "../redis"
import { isRepeatableJob } from "../repeatable-job-registry"

const logger = createLogger("worker.payout")
// Prisma output is generated during the database build and is intentionally
// not committed for every model. The schema/migration remain authoritative.
const payoutWebhookEvent = (prisma as any).payoutWebhookEvent

// Shared state transitions for "the provider says this transfer finished".
// Used by both the webhook path and the status poller. All guards are
// conditional updateMany — a concurrent webhook/poller loses the race cleanly.
async function completeExecution(
  execution: any,
  source: string,
  metadata: Record<string, unknown>,
) {
  await prisma.$transaction(async (tx: any) => {
    const execUpdated = await tx.payoutExecution.updateMany({
      where: {
        id: execution.id,
        status: { in: ["PROCESSING", "FAILED"] },
        version: execution.version,
      },
      data: {
        status: "COMPLETED",
        version: { increment: 1 },
        providerMetadata: metadata as any,
      },
    })
    if (execUpdated.count === 0)
      throw new Error("Execution already transitioned or claimed for cancel")

    const wdUpdated = await tx.withdrawal.updateMany({
      where: {
        id: execution.withdrawalId,
        status: { in: ["PROCESSING", "FAILED"] },
        version: execution.withdrawal.version,
      },
      data: { status: "COMPLETED", version: { increment: 1 } },
    })
    if (wdUpdated.count === 0) {
      throw new Error("Withdrawal state changed before completion could apply")
    }

    // Serialize lifetimePaid with every other balance mutation. The previous
    // optimistic update ignored count=0, which could commit COMPLETED while
    // silently skipping the financial aggregate update.
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "PublisherBalance" WHERE "publisherId" = $1 FOR UPDATE',
      execution.withdrawal.publisherId,
    )
    const balance = await tx.publisherBalance.findUnique({
      where: { publisherId: execution.withdrawal.publisherId },
    })
    if (!balance) throw new Error("Publisher balance missing during payout")
    await tx.publisherBalance.update({
      where: { publisherId: execution.withdrawal.publisherId },
      data: {
        lifetimePaid: { increment: Number(execution.amount) },
        version: { increment: 1 },
      },
    })

    await tx.auditLog.create({
      data: {
        action:
          source === "webhook"
            ? "PAYOUT_WEBHOOK_COMPLETED"
            : "PAYOUT_STATUS_POLL_COMPLETED",
        entityType: "PayoutExecution",
        entityId: execution.id,
        metadata: {
          providerExecutionId: execution.providerExecutionId,
          source,
          ...metadata,
        },
        userId: null,
        organizationId: execution.withdrawal.publisher.organizationId,
      },
    })
  })
}

async function failExecution(
  execution: any,
  source: string,
  errorMessage: string,
  metadata: Record<string, unknown>,
) {
  await prisma.$transaction(async (tx: any) => {
    const execUpdated = await tx.payoutExecution.updateMany({
      where: {
        id: execution.id,
        status: "PROCESSING",
        version: execution.version,
      },
      data: {
        status: "FAILED",
        version: { increment: 1 },
        errorMessage,
        providerMetadata: metadata as any,
      },
    })
    if (execUpdated.count === 0)
      throw new Error("Execution already transitioned or claimed for cancel")

    const withdrawalUpdated = await tx.withdrawal.updateMany({
      where: {
        id: execution.withdrawalId,
        status: "PROCESSING",
        version: execution.withdrawal.version,
      },
      data: { status: "FAILED", version: { increment: 1 } },
    })
    if (withdrawalUpdated.count === 0) {
      throw new Error("Withdrawal state changed before failure could apply")
    }

    await tx.auditLog.create({
      data: {
        action:
          source === "webhook"
            ? "PAYOUT_WEBHOOK_FAILED"
            : "PAYOUT_STATUS_POLL_FAILED",
        entityType: "PayoutExecution",
        entityId: execution.id,
        metadata: {
          providerExecutionId: execution.providerExecutionId,
          source,
          error: errorMessage,
          ...metadata,
        },
        userId: null,
        organizationId: execution.withdrawal.publisher.organizationId,
      },
    })
  })
}

export async function handleCheckStatus(job: any) {
  const limit = job.data.limit ?? 50
  const pendingExecutions = await prisma.payoutExecution.findMany({
    where: { status: "PROCESSING", providerExecutionId: { not: null } },
    take: limit,
    orderBy: { createdAt: "asc" },
    include: { provider: true, withdrawal: { include: { publisher: true } } },
  })
  logger.info("polling provider status", {
    pendingCount: pendingExecutions.length,
  })

  let completed = 0
  let failed = 0
  let skipped = 0
  for (const execution of pendingExecutions) {
    let result
    try {
      result = await checkProviderTransferStatus(
        execution.provider.name,
        execution.providerExecutionId!,
      )
    } catch (err: any) {
      // Provider API hiccup on one transfer must not abort the sweep
      logger.error("status check failed", {
        executionId: execution.id,
        err: err?.message ?? String(err),
      })
      skipped++
      continue
    }
    if (!result) {
      // No API key configured or non-pollable provider — leave untouched
      skipped++
      continue
    }

    try {
      if (result.status === "COMPLETED") {
        await completeExecution(execution, "status-poll", {
          ...result.metadata,
          fee: result.fee,
        })
        completed++
        logger.info("execution completed via status poll", {
          executionId: execution.id,
        })
      } else if (result.status === "FAILED") {
        await failExecution(
          execution,
          "status-poll",
          "Provider reports transfer failed/cancelled",
          result.metadata ?? {},
        )
        failed++
        logger.info("execution failed via status poll", {
          executionId: execution.id,
        })
      }
    } catch (err: any) {
      // Lost a race against a webhook — fine, the state already moved
      logger.warn("transition skipped (lost race against webhook)", {
        executionId: execution.id,
        err: err?.message ?? String(err),
      })
      skipped++
    }
  }

  return { checked: pendingExecutions.length, completed, failed, skipped }
}

const INBOX_LOCK_TIMEOUT_MS = 15 * 60 * 1000
const INBOX_MAX_RETRY_AGE_MS = 72 * 60 * 60 * 1000
// At the capped ten-minute backoff this exceeds the 72-hour age window. It is
// a corruption/clock safety bound, not the normal termination condition.
const INBOX_MAX_ATTEMPTS = 432

function safeInboxError(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError"
  // Provider bodies are never part of inbox processing. Keep only the error
  // class/category so accidental sensitive strings cannot enter this table.
  return name.slice(0, 100)
}

function inboxRetryAt(attempts: number): Date {
  const delaySeconds = Math.min(30 * 2 ** Math.max(attempts - 1, 0), 600)
  return new Date(Date.now() + delaySeconds * 1000)
}

async function markInboxEvent(
  id: string,
  status: "PROCESSED" | "FAILED" | "IGNORED",
  data: Record<string, unknown> = {},
) {
  await payoutWebhookEvent.update({
    where: { id },
    data: {
      status,
      lockedAt: null,
      processedAt: status === "FAILED" ? null : new Date(),
      ...data,
    },
  })
}

async function processInboxEvent(event: any): Promise<string> {
  if (!event.providerExecutionId) {
    await markInboxEvent(event.id, "IGNORED", {
      lastError: "MissingProviderExecutionId",
    })
    return "ignored"
  }

  const execution = await prisma.payoutExecution.findFirst({
    where: {
      providerExecutionId: event.providerExecutionId,
      provider: { is: { name: event.provider } },
    },
    include: { withdrawal: { include: { publisher: true } } },
  })
  if (!execution) {
    const ageMs = Date.now() - event.receivedAt.getTime()
    if (
      event.attempts >= INBOX_MAX_ATTEMPTS ||
      ageMs >= INBOX_MAX_RETRY_AGE_MS
    ) {
      await prisma.$transaction(async (tx: any) => {
        await tx.payoutWebhookEvent.update({
          where: { id: event.id },
          data: {
            status: "IGNORED",
            lockedAt: null,
            processedAt: new Date(),
            lastError: "ExecutionNotFoundAfterRetryWindow",
          },
        })
        await tx.auditLog.create({
          data: {
            action: "PAYOUT_WEBHOOK_UNMATCHED",
            entityType: "PayoutWebhookEvent",
            entityId: event.id,
            metadata: {
              provider: event.provider,
              eventType: event.eventType,
              providerExecutionId: event.providerExecutionId,
              attempts: event.attempts,
            },
            userId: null,
            organizationId: null,
          },
        })
      })
      return "ignored"
    }
    await markInboxEvent(event.id, "FAILED", {
      availableAt: inboxRetryAt(event.attempts),
      lastError: "ExecutionNotFoundYet",
    })
    return "retried"
  }

  if (execution.status === "COMPLETED") {
    await markInboxEvent(event.id, "PROCESSED", { lastError: null })
    return "processed"
  }

  if (event.providerStatus === "COMPLETED") {
    if (!["PROCESSING", "FAILED"].includes(execution.status)) {
      await prisma.$transaction(async (tx: any) => {
        await tx.payoutWebhookEvent.update({
          where: { id: event.id },
          data: {
            status: "IGNORED",
            lockedAt: null,
            processedAt: new Date(),
            lastError: "CompletedTransferConflictsWithLocalState",
          },
        })
        await tx.auditLog.create({
          data: {
            action: "PAYOUT_WEBHOOK_STATE_CONFLICT",
            entityType: "PayoutExecution",
            entityId: execution.id,
            metadata: {
              payoutWebhookEventId: event.id,
              providerExecutionId: event.providerExecutionId,
              localStatus: execution.status,
              providerStatus: event.providerStatus,
            },
            userId: null,
            organizationId: execution.withdrawal.publisher.organizationId,
          },
        })
      })
      return "ignored"
    }
    await completeExecution(execution, "webhook", {
      provider: event.provider,
      event: event.eventType,
      rawStatus: event.rawStatus,
    })
  } else if (
    event.providerStatus === "FAILED" &&
    execution.status === "PROCESSING"
  ) {
    await failExecution(
      execution,
      "webhook",
      "Provider reported transfer failed/cancelled",
      {
        provider: event.provider,
        event: event.eventType,
        rawStatus: event.rawStatus,
      },
    )
  }

  await markInboxEvent(event.id, "PROCESSED", { lastError: null })
  return "processed"
}

/** Drain cryptographically verified payout events from the Postgres inbox. */
export async function processPayoutWebhookInbox(limit = 50) {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 500)
  const now = new Date()
  await payoutWebhookEvent.updateMany({
    where: {
      status: "PROCESSING",
      lockedAt: { lt: new Date(now.getTime() - INBOX_LOCK_TIMEOUT_MS) },
    },
    data: {
      status: "FAILED",
      lockedAt: null,
      availableAt: now,
      lastError: "StaleProcessingLeaseRecovered",
    },
  })

  const candidates = await payoutWebhookEvent.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      availableAt: { lte: now },
    },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    take: safeLimit,
  })

  let processed = 0
  let retried = 0
  let ignored = 0
  let claimedCount = 0
  for (const candidate of candidates) {
    const claimed = await payoutWebhookEvent.updateMany({
      where: {
        id: candidate.id,
        status: { in: ["PENDING", "FAILED"] },
        availableAt: { lte: now },
      },
      data: {
        status: "PROCESSING",
        lockedAt: new Date(),
        attempts: { increment: 1 },
      },
    })
    if (claimed.count === 0) continue
    claimedCount++

    const event = await payoutWebhookEvent.findUnique({
      where: { id: candidate.id },
    })
    if (!event) continue
    try {
      const result = await processInboxEvent(event)
      if (result === "processed") processed++
      else if (result === "retried") retried++
      else ignored++
    } catch (error) {
      retried++
      await markInboxEvent(event.id, "FAILED", {
        availableAt: inboxRetryAt(event.attempts),
        lastError: safeInboxError(error),
      })
      logger.error("payout inbox event failed", {
        eventId: event.id,
        error: safeInboxError(error),
      })
    }
  }

  return { claimed: claimedCount, processed, retried, ignored }
}

async function handleWebhook(job: any) {
  const { provider, event, data, verified } = job.data
  if (!provider || !event || !data) {
    throw new Error("Missing provider, event, or data in webhook job")
  }
  if (!verified) {
    logger.error(
      "unverified webhook job rejected — must be verified by API before queueing",
      { provider, event },
    )
    throw new Error(
      "Unverified webhook — signature check required before enqueueing",
    )
  }
  logger.info("processing webhook event", { provider, event })

  // Real Wise payloads carry the transfer id at data.resource.id and state at
  // current_state; Stripe at data.object.id / status. The normalizer maps both
  // (and pre-normalized internal payloads) through the same status maps the
  // poller uses — raw provider shapes previously matched nothing and every
  // genuine webhook was skipped.
  const normalized = normalizeProviderWebhook(provider, data)
  if (!normalized.providerExecutionId) {
    logger.warn("no providerExecutionId in webhook data", { provider, event })
    return { skipped: true, reason: "No providerExecutionId" }
  }
  const execution = await prisma.payoutExecution.findFirst({
    where: {
      providerExecutionId: normalized.providerExecutionId,
      provider: { is: { name: provider } },
    },
    include: { withdrawal: { include: { publisher: true } } },
  })
  if (!execution) {
    logger.warn("no execution found for providerExecutionId", {
      providerExecutionId: normalized.providerExecutionId,
    })
    return { skipped: true, reason: "Execution not found" }
  }

  if (execution.status !== "PROCESSING") {
    logger.warn("execution not PROCESSING — ignoring webhook", {
      executionId: execution.id,
      status: execution.status,
    })
    return {
      skipped: true,
      reason: `Execution is ${execution.status}, not PROCESSING`,
    }
  }

  const webhookStatus = normalized.status
  if (webhookStatus === "COMPLETED") {
    await completeExecution(execution, "webhook", {
      provider,
      event,
      rawStatus: normalized.rawStatus,
    })
    logger.info("withdrawal completed via webhook", {
      withdrawalId: execution.withdrawalId,
      executionId: execution.id,
    })
  } else if (webhookStatus === "FAILED") {
    await failExecution(
      execution,
      "webhook",
      normalized.error ?? "Provider reported failure",
      { provider, event, rawStatus: normalized.rawStatus },
    )
    logger.info("withdrawal failed via webhook", {
      withdrawalId: execution.withdrawalId,
      executionId: execution.id,
    })
  } else {
    logger.info("webhook state non-terminal — no transition", {
      rawStatus: normalized.rawStatus,
      executionId: execution.id,
    })
  }
  return {
    executionId: execution.id,
    webhookStatus,
    rawStatus: normalized.rawStatus,
  }
}

export function createPayoutWorker() {
  const worker = createObservableWorker(
    QUEUES.PAYOUT,
    async (job) => {
      // Phase 7.8 #27 — payout-check-status (repeatable) bypasses
      // freshness; non-repeatable jobs (currently only payout-webhook)
      // get a 72h window to accommodate provider-outage retry storms
      // across long weekends.
      const maxAgeMs = isRepeatableJob(job.name) ? 0 : 72 * 60 * 60 * 1000
      if (!verifyJobPayload(job.data, { maxAgeMs })) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }
      switch (job.name) {
        case "payout-check-status":
          return handleCheckStatus(job)
        case "payout-webhook":
          return handleWebhook(job)
        default:
          logger.warn("unknown job name", { jobName: job.name })
      }
    },
    { connection, concurrency: 5 },
  )

  worker.on("completed", (job) =>
    logger.info("job completed", { jobId: job.id }),
  )
  worker.on("failed", (job, err) =>
    logger.error("job failed", { jobId: job?.id, err: err?.message }),
  )
  return worker
}
