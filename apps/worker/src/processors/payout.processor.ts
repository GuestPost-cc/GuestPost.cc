import { connection } from "../redis"
import { QUEUES, verifyJobPayload, checkProviderTransferStatus, normalizeProviderWebhook } from "@guestpost/shared"
import { prisma } from "@guestpost/database"
import { createObservableWorker } from "../lib/queue-observability"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"

const logger = createLogger("worker.payout")

// Shared state transitions for "the provider says this transfer finished".
// Used by both the webhook path and the status poller. All guards are
// conditional updateMany — a concurrent webhook/poller loses the race cleanly.
async function completeExecution(execution: any, source: string, metadata: Record<string, unknown>) {
  await prisma.$transaction(async (tx: any) => {
    const execUpdated = await tx.payoutExecution.updateMany({
      where: { id: execution.id, status: "PROCESSING" },
      data: { status: "COMPLETED", providerMetadata: metadata as any },
    })
    if (execUpdated.count === 0) throw new Error("Execution already transitioned")

    const wdUpdated = await tx.withdrawal.updateMany({
      where: { id: execution.withdrawalId, status: "PROCESSING", version: execution.withdrawal.version },
      data: { status: "COMPLETED", version: { increment: 1 } },
    })
    if (wdUpdated.count === 0) {
      await tx.payoutExecution.update({
        where: { id: execution.id },
        data: { status: "PROCESSING" },
      })
      throw new Error("Withdrawal state changed before completion could apply")
    }

    const balance = await tx.publisherBalance.findUnique({
      where: { publisherId: execution.withdrawal.publisherId },
    })
    if (balance) {
      await tx.publisherBalance.updateMany({
        where: { publisherId: execution.withdrawal.publisherId, version: balance.version },
        data: { lifetimePaid: { increment: Number(execution.amount) }, version: { increment: 1 } },
      })
    }

    await tx.auditLog.create({
      data: {
        action: source === "webhook" ? "PAYOUT_WEBHOOK_COMPLETED" : "PAYOUT_STATUS_POLL_COMPLETED",
        entityType: "PayoutExecution",
        entityId: execution.id,
        metadata: { providerExecutionId: execution.providerExecutionId, source, ...metadata },
        userId: null,
        organizationId: null,
      },
    })
  })
}

async function failExecution(execution: any, source: string, errorMessage: string, metadata: Record<string, unknown>) {
  await prisma.$transaction(async (tx: any) => {
    const execUpdated = await tx.payoutExecution.updateMany({
      where: { id: execution.id, status: "PROCESSING" },
      data: { status: "FAILED", errorMessage, providerMetadata: metadata as any },
    })
    if (execUpdated.count === 0) throw new Error("Execution already transitioned")

    await tx.withdrawal.updateMany({
      where: { id: execution.withdrawalId, status: "PROCESSING", version: execution.withdrawal.version },
      data: { status: "FAILED", version: { increment: 1 } },
    })

    await tx.auditLog.create({
      data: {
        action: source === "webhook" ? "PAYOUT_WEBHOOK_FAILED" : "PAYOUT_STATUS_POLL_FAILED",
        entityType: "PayoutExecution",
        entityId: execution.id,
        metadata: { providerExecutionId: execution.providerExecutionId, source, error: errorMessage, ...metadata },
        userId: null,
        organizationId: null,
      },
    })
  })
}

async function handleExecute(job: any) {
  const { withdrawalId, providerName } = job.data
  if (!withdrawalId || !providerName) {
    throw new Error("Missing withdrawalId or providerName in job data")
  }
  logger.info("processing withdrawal", { withdrawalId, providerName })
  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
  })
  if (!withdrawal) throw new Error(`Withdrawal ${withdrawalId} not found`)
  if (withdrawal.status !== "APPROVED" && withdrawal.status !== "PROCESSING") {
    logger.warn("withdrawal not eligible — skipping", { withdrawalId, status: withdrawal.status })
    return { skipped: true, reason: `Status is ${withdrawal.status}` }
  }
  return { withdrawalId, providerName, queued: true }
}

async function handleCheckStatus(job: any) {
  const limit = job.data.limit ?? 50
  const pendingExecutions = await prisma.payoutExecution.findMany({
    where: { status: "PROCESSING", providerExecutionId: { not: null } },
    take: limit,
    orderBy: { createdAt: "asc" },
    include: { provider: true, withdrawal: { include: { publisher: true } } },
  })
  logger.info("polling provider status", { pendingCount: pendingExecutions.length })

  let completed = 0
  let failed = 0
  let skipped = 0
  for (const execution of pendingExecutions) {
    let result
    try {
      result = await checkProviderTransferStatus(execution.provider.name, execution.providerExecutionId!)
    } catch (err: any) {
      // Provider API hiccup on one transfer must not abort the sweep
      logger.error("status check failed", { executionId: execution.id, err: err?.message ?? String(err) })
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
        await completeExecution(execution, "status-poll", { ...result.metadata, fee: result.fee })
        completed++
        logger.info("execution completed via status poll", { executionId: execution.id })
      } else if (result.status === "FAILED") {
        await failExecution(execution, "status-poll", "Provider reports transfer failed/cancelled", result.metadata ?? {})
        failed++
        logger.info("execution failed via status poll", { executionId: execution.id })
      }
    } catch (err: any) {
      // Lost a race against a webhook — fine, the state already moved
      logger.warn("transition skipped (lost race against webhook)", { executionId: execution.id, err: err?.message ?? String(err) })
      skipped++
    }
  }

  return { checked: pendingExecutions.length, completed, failed, skipped }
}

async function handleWebhook(job: any) {
  const { provider, event, data, verified } = job.data
  if (!provider || !event || !data) {
    throw new Error("Missing provider, event, or data in webhook job")
  }
  if (!verified) {
    logger.error("unverified webhook job rejected — must be verified by API before queueing", { provider, event })
    throw new Error("Unverified webhook — signature check required before enqueueing")
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
    where: { providerExecutionId: normalized.providerExecutionId },
    include: { withdrawal: { include: { publisher: true } } },
  })
  if (!execution) {
    logger.warn("no execution found for providerExecutionId", { providerExecutionId: normalized.providerExecutionId })
    return { skipped: true, reason: "Execution not found" }
  }

  if (execution.status !== "PROCESSING") {
    logger.warn("execution not PROCESSING — ignoring webhook", { executionId: execution.id, status: execution.status })
    return { skipped: true, reason: `Execution is ${execution.status}, not PROCESSING` }
  }

  const webhookStatus = normalized.status
  if (webhookStatus === "COMPLETED") {
    await completeExecution(execution, "webhook", { provider, event, rawStatus: normalized.rawStatus })
    logger.info("withdrawal completed via webhook", { withdrawalId: execution.withdrawalId, executionId: execution.id })
  } else if (webhookStatus === "FAILED") {
    await failExecution(execution, "webhook", normalized.error ?? "Provider reported failure", { provider, event, rawStatus: normalized.rawStatus })
    logger.info("withdrawal failed via webhook", { withdrawalId: execution.withdrawalId, executionId: execution.id })
  } else {
    logger.info("webhook state non-terminal — no transition", { rawStatus: normalized.rawStatus, executionId: execution.id })
  }
  return { executionId: execution.id, webhookStatus, rawStatus: normalized.rawStatus }
}

export function createPayoutWorker() {
  const worker = createObservableWorker(
    QUEUES.PAYOUT,
    async (job) => {
      if (!verifyJobPayload(job.data)) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }
      switch (job.name) {
        case "payout-execute": return handleExecute(job)
        case "payout-check-status": return handleCheckStatus(job)
        case "payout-webhook": return handleWebhook(job)
        default:
          logger.warn("unknown job name", { jobName: job.name })
      }
    },
    { connection, concurrency: 5 },
  )

  worker.on("completed", (job) => logger.info("job completed", { jobId: job.id }))
  worker.on("failed", (job, err) => logger.error("job failed", { jobId: job?.id, err: err?.message }))
  return worker
}
