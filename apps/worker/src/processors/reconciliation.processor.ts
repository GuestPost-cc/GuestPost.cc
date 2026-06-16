import {
  QUEUES,
  getDedupHitsTotal,
  incrementDedupHits,
  isUniqueViolation,
  notificationDedupKey,
  runReconciliation,
  verifyJobPayload,
} from "@guestpost/shared"
import { prisma } from "@guestpost/database"
import { connection } from "../redis"
import { createObservableWorker } from "../lib/queue-observability"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"

const logger = createLogger("worker.reconciliation")

// Scheduled financial drift sweep. Same core checks as the API's on-demand
// GET /admin/reconciliation. On any finding: audit row + in-app notification
// to every staff member — drift must never depend on a human remembering to
// run the endpoint.
async function handleReconciliationRun() {
  const report = await runReconciliation(prisma)

  if (report.ok) {
    logger.info("sweep clean", { ranAt: report.ranAt })
    return { ok: true, ranAt: report.ranAt }
  }

  const problems = {
    walletDrift: report.walletDrift.length,
    publisherDrift: report.publisherDrift.length,
    stuckOrders: report.stuckOrders.length,
    stuckPayouts: report.stuckPayouts.length,
  }
  logger.error("DRIFT DETECTED", problems)

  await prisma.auditLog.create({
    data: {
      action: "RECONCILIATION_DRIFT_DETECTED",
      entityType: "Reconciliation",
      entityId: null,
      metadata: report as any,
      userId: null,
      organizationId: null,
    },
  })

  const summary = [
    problems.walletDrift && `${problems.walletDrift} wallet drift`,
    problems.publisherDrift && `${problems.publisherDrift} publisher drift`,
    problems.stuckOrders && `${problems.stuckOrders} stuck orders`,
    problems.stuckPayouts && `${problems.stuckPayouts} stuck/duplicate payouts`,
  ].filter(Boolean).join(", ")

  // Phase 7.4 (audit #12) — drift-keyed notification dedup.
  // Same drift COMPOSITION across hourly cron runs → same key per staff per
  // UTC day → ONE notification per staff per day (not 24×). A different
  // composition (drift appears or clears mid-day) → new key → new notification
  // so the operator still sees the situation evolving. Tomorrow → new UTC
  // dateBucket → re-alert if drift persists (reminds operator it's still there).
  //
  // The "entity" in the dedup key is the drift summary fingerprint — semantically
  // the unique identifier of "this exact drift situation."
  const summaryFingerprint = [
    `wallet=${problems.walletDrift}`,
    `pub=${problems.publisherDrift}`,
    `stuckOrd=${problems.stuckOrders}`,
    `stuckPay=${problems.stuckPayouts}`,
  ].join(",")
  const dateBucket = notificationDedupKey.utcDateBucket()

  const staff = await prisma.staffMembership.findMany({ select: { userId: true } })
  for (const s of staff) {
    const dedupKey = notificationDedupKey.reconDrift({
      driftType: "summary",
      entityId: summaryFingerprint,
      staffUserId: s.userId,
      dateBucket,
    })
    try {
      await prisma.notification.create({
        data: {
          userId: s.userId,
          organizationId: null,
          type: "RECONCILIATION_ALERT",
          message: `Reconciliation drift detected: ${summary}. Review /admin/reconciliation immediately.`,
          dedupKey,
        },
      })
    } catch (err) {
      if (isUniqueViolation(err)) {
        const total = incrementDedupHits()
        logger.info("notification deduped (P2002)", { dedupKey, userId: s.userId, dedup_hits_total: total })
        continue
      }
      logger.error("failed to notify staff", { userId: s.userId, err: err instanceof Error ? err.message : String(err) })
    }
  }

  return { ok: false, dedupHitsTotal: getDedupHitsTotal(), ...problems }
}

export function createReconciliationWorker() {
  const worker = createObservableWorker(
    QUEUES.RECONCILIATION,
    async (job) => {
      if (!verifyJobPayload(job.data)) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }
      switch (job.name) {
        case "reconciliation-run":
          return handleReconciliationRun()
        default:
          logger.warn("unknown job name", { jobName: job.name })
      }
    },
    { connection, concurrency: 1 },
  )

  worker.on("completed", (job) => logger.info("job completed", { jobId: job.id }))
  worker.on("failed", (job, err) => logger.error("job failed", { jobId: job?.id, err: err?.message }))
  return worker
}
