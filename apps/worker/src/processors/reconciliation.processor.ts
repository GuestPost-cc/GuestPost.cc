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

// Scheduled financial drift sweep. Same core checks as the API's on-demand
// GET /admin/reconciliation. On any finding: audit row + in-app notification
// to every staff member — drift must never depend on a human remembering to
// run the endpoint.
async function handleReconciliationRun() {
  const report = await runReconciliation(prisma)

  if (report.ok) {
    console.log(`[RECONCILIATION] Sweep clean at ${report.ranAt}`)
    return { ok: true, ranAt: report.ranAt }
  }

  const problems = {
    walletDrift: report.walletDrift.length,
    publisherDrift: report.publisherDrift.length,
    stuckOrders: report.stuckOrders.length,
    stuckPayouts: report.stuckPayouts.length,
  }
  console.error(`[RECONCILIATION] DRIFT DETECTED: ${JSON.stringify(problems)}`)

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
        console.log(
          `[RECONCILIATION] deduped key=${dedupKey} user=${s.userId} dedup_hits_total=${total}`,
        )
        continue
      }
      console.error(`[RECONCILIATION] Failed to notify staff ${s.userId}:`, err)
    }
  }

  return { ok: false, dedupHitsTotal: getDedupHitsTotal(), ...problems }
}

export function createReconciliationWorker() {
  const worker = createObservableWorker(
    QUEUES.RECONCILIATION,
    async (job) => {
      if (!verifyJobPayload(job.data)) {
        console.error(`[RECONCILIATION] Job ${job.id} has missing/invalid signature — rejecting`)
        throw new Error("Invalid job signature")
      }
      switch (job.name) {
        case "reconciliation-run":
          return handleReconciliationRun()
        default:
          console.warn(`[RECONCILIATION] Unknown job: ${job.name}`)
      }
    },
    { connection, concurrency: 1 },
  )

  worker.on("completed", (job) => console.log(`[RECONCILIATION] Job ${job.id} completed`))
  worker.on("failed", (job, err) => console.error(`[RECONCILIATION] Job ${job?.id} failed:`, err))
  return worker
}
