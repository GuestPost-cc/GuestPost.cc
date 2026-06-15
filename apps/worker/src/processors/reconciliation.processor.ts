import { connection } from "../redis"
import { QUEUES, verifyJobPayload, runReconciliation } from "@guestpost/shared"
import { prisma } from "@guestpost/database"
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

  const staff = await prisma.staffMembership.findMany({ select: { userId: true } })
  for (const s of staff) {
    await prisma.notification.create({
      data: {
        userId: s.userId,
        organizationId: null,
        type: "RECONCILIATION_ALERT",
        message: `Reconciliation drift detected: ${summary}. Review /admin/reconciliation immediately.`,
      },
    }).catch((err: any) => console.error(`[RECONCILIATION] Failed to notify staff ${s.userId}:`, err))
  }

  return { ok: false, ...problems }
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
