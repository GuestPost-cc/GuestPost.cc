import { connection } from "../redis"
import { QUEUES, verifyJobPayload, checkProviderTransferStatus, normalizeProviderWebhook } from "@guestpost/shared"
import { prisma } from "@guestpost/database"
import { createObservableWorker } from "../lib/queue-observability"

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
  console.log(`[PAYOUT] Processing withdrawal ${withdrawalId} via ${providerName}`)
  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
  })
  if (!withdrawal) throw new Error(`Withdrawal ${withdrawalId} not found`)
  if (withdrawal.status !== "APPROVED" && withdrawal.status !== "PROCESSING") {
    console.warn(`[PAYOUT] Withdrawal ${withdrawalId} is ${withdrawal.status} — skipping`)
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
  console.log(`[PAYOUT] Polling provider status for ${pendingExecutions.length} PROCESSING executions`)

  let completed = 0
  let failed = 0
  let skipped = 0
  for (const execution of pendingExecutions) {
    let result
    try {
      result = await checkProviderTransferStatus(execution.provider.name, execution.providerExecutionId!)
    } catch (err: any) {
      // Provider API hiccup on one transfer must not abort the sweep
      console.error(`[PAYOUT] Status check failed for execution ${execution.id}: ${err.message}`)
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
        console.log(`[PAYOUT] Execution ${execution.id} completed via status poll`)
      } else if (result.status === "FAILED") {
        await failExecution(execution, "status-poll", "Provider reports transfer failed/cancelled", result.metadata ?? {})
        failed++
        console.log(`[PAYOUT] Execution ${execution.id} failed via status poll`)
      }
    } catch (err: any) {
      // Lost a race against a webhook — fine, the state already moved
      console.warn(`[PAYOUT] Transition skipped for execution ${execution.id}: ${err.message}`)
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
    console.error(`[PAYOUT] Unverified webhook job rejected — must be verified by API before queueing`)
    throw new Error("Unverified webhook — signature check required before enqueueing")
  }
  console.log(`[PAYOUT] Processing ${provider} webhook event: ${event}`)

  // Real Wise payloads carry the transfer id at data.resource.id and state at
  // current_state; Stripe at data.object.id / status. The normalizer maps both
  // (and pre-normalized internal payloads) through the same status maps the
  // poller uses — raw provider shapes previously matched nothing and every
  // genuine webhook was skipped.
  const normalized = normalizeProviderWebhook(provider, data)
  if (!normalized.providerExecutionId) {
    console.warn(`[PAYOUT] No providerExecutionId in webhook data`)
    return { skipped: true, reason: "No providerExecutionId" }
  }
  const execution = await prisma.payoutExecution.findFirst({
    where: { providerExecutionId: normalized.providerExecutionId },
    include: { withdrawal: { include: { publisher: true } } },
  })
  if (!execution) {
    console.warn(`[PAYOUT] No execution found for providerExecutionId: ${normalized.providerExecutionId}`)
    return { skipped: true, reason: "Execution not found" }
  }

  if (execution.status !== "PROCESSING") {
    console.warn(`[PAYOUT] Execution ${execution.id} is ${execution.status}, not PROCESSING — ignoring webhook`)
    return { skipped: true, reason: `Execution is ${execution.status}, not PROCESSING` }
  }

  const webhookStatus = normalized.status
  if (webhookStatus === "COMPLETED") {
    await completeExecution(execution, "webhook", { provider, event, rawStatus: normalized.rawStatus })
    console.log(`[PAYOUT] Withdrawal ${execution.withdrawalId} completed via webhook`)
  } else if (webhookStatus === "FAILED") {
    await failExecution(execution, "webhook", normalized.error ?? "Provider reported failure", { provider, event, rawStatus: normalized.rawStatus })
    console.log(`[PAYOUT] Withdrawal ${execution.withdrawalId} failed via webhook`)
  } else {
    console.log(`[PAYOUT] Webhook state "${normalized.rawStatus}" is non-terminal — no transition`)
  }
  return { executionId: execution.id, webhookStatus, rawStatus: normalized.rawStatus }
}

export function createPayoutWorker() {
  const worker = createObservableWorker(
    QUEUES.PAYOUT,
    async (job) => {
      if (!verifyJobPayload(job.data)) {
        console.error(`[PAYOUT] Job ${job.id} has missing/invalid signature — rejecting`)
        throw new Error("Invalid job signature")
      }
      switch (job.name) {
        case "payout-execute": return handleExecute(job)
        case "payout-check-status": return handleCheckStatus(job)
        case "payout-webhook": return handleWebhook(job)
        default:
          console.warn(`[PAYOUT] Unknown job: ${job.name}`)
      }
    },
    { connection, concurrency: 5 },
  )

  worker.on("completed", (job) => console.log(`[PAYOUT] Job ${job.id} completed`))
  worker.on("failed", (job, err) => console.error(`[PAYOUT] Job ${job?.id} failed:`, err))
  return worker
}
