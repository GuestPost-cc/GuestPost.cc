import { config } from "dotenv"
// Dev env file loads ONLY under explicit NODE_ENV=development — unset NODE_ENV
// (staging, CI) fails closed instead of silently using dev secrets
if (process.env.NODE_ENV === "development") {
  config({ path: require("path").resolve(__dirname, "../../../.env.development") })
}
import { createEmailWorker } from "./processors/email.processor"
import { createReportWorker } from "./processors/report.processor"
import { createNotificationWorker } from "./processors/notification.processor"
import { createVerificationWorker } from "./processors/verification.processor"
import { createPayoutWorker } from "./processors/payout.processor"
import { createReconciliationWorker } from "./processors/reconciliation.processor"
import { createWebsiteVerificationWorker } from "./processors/website-verification.processor"
import { createDeliveryVerificationWorker } from "./processors/delivery-verification.processor"
import { createPublisherTrustWorker } from "./processors/publisher-trust.processor"
import { connection } from "./redis"
import { prisma } from "@guestpost/database"
import { Queue } from "bullmq"
import { QUEUES, signJobPayload } from "@guestpost/shared"

// Stuck-payout safety net: webhooks are the primary completion signal, this
// poll catches transfers whose webhook was lost or never configured.
async function registerPayoutStatusPoll() {
  const queue = new Queue(QUEUES.PAYOUT, { connection })
  await queue.add(
    "payout-check-status",
    signJobPayload({ limit: 50 }),
    {
      repeat: { every: 10 * 60 * 1000 },
      jobId: "payout-check-status-poll",
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 10 },
    },
  )
  await queue.close()
  console.log("[WORKER] Registered payout status poll (every 10m)")
}

// Scheduled drift sweep — alerting must not depend on a human remembering to
// call GET /admin/reconciliation. Interval configurable for ops tuning.
async function registerReconciliationSweep() {
  const everyMs = Math.max(Number(process.env.RECONCILIATION_SWEEP_MINUTES ?? 60), 5) * 60 * 1000
  const queue = new Queue(QUEUES.RECONCILIATION, { connection })
  await queue.add(
    "reconciliation-run",
    signJobPayload({}),
    {
      repeat: { every: everyMs },
      jobId: "reconciliation-sweep",
      removeOnComplete: { count: 24 },
      removeOnFail: { count: 24 },
    },
  )
  await queue.close()
  console.log(`[WORKER] Registered reconciliation sweep (every ${everyMs / 60000}m)`)
}

// Domain re-verification sweep — every VERIFIED site is re-checked every 30d
// and REVOKED if its TXT record vanished. Trust must decay, not persist forever.
async function registerWebsiteReverifySweep() {
  const everyMs = Math.max(Number(process.env.WEBSITE_REVERIFY_DAYS ?? 30), 1) * 24 * 60 * 60 * 1000
  const queue = new Queue(QUEUES.WEBSITE_VERIFICATION, { connection })
  await queue.add(
    "website-reverify-sweep",
    signJobPayload({}),
    {
      repeat: { every: everyMs },
      jobId: "website-reverify-sweep",
      removeOnComplete: { count: 12 },
      removeOnFail: { count: 12 },
    },
  )
  await queue.close()
  console.log(`[WORKER] Registered website re-verify sweep (every ${everyMs / 86400000}d)`)
}

// Settlement-hold link monitoring — re-check the live link for every order
// whose payout is still on hold. If removed, raises a fraud flag that blocks
// release. Default every 6h.
async function registerSettlementHoldLinkSweep() {
  const everyMs = Math.max(Number(process.env.SETTLEMENT_LINK_SWEEP_HOURS ?? 6), 1) * 60 * 60 * 1000
  const queue = new Queue(QUEUES.DELIVERY_VERIFICATION, { connection })
  await queue.add(
    "settlement-hold-sweep",
    signJobPayload({}),
    {
      repeat: { every: everyMs },
      jobId: "settlement-hold-sweep",
      removeOnComplete: { count: 24 },
      removeOnFail: { count: 24 },
    },
  )
  await queue.close()
  console.log(`[WORKER] Registered settlement-hold link sweep (every ${everyMs / 3600000}h)`)
}

async function checkConnections() {
  try {
    await connection.ping()
  } catch (err) {
    console.error("[WORKER] FATAL: Redis connection failed:", err)
    process.exit(1)
  }
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    console.error("[WORKER] FATAL: Database connection failed:", err)
    process.exit(1)
  }
  console.log("[WORKER] Redis + database connections verified")
}

const workers: Array<{ close: () => Promise<void> }> = []

checkConnections().then(() => {
  workers.push(
    createEmailWorker(),
    createReportWorker(),
    createNotificationWorker(),
    createVerificationWorker(),
    createPayoutWorker(),
    createReconciliationWorker(),
    createWebsiteVerificationWorker(),
    createDeliveryVerificationWorker(),
    createPublisherTrustWorker(),
  )
  console.log(`[WORKER] Started ${workers.length} workers`)
  registerPayoutStatusPoll().catch((err) => {
    console.error("[WORKER] Failed to register payout status poll:", err)
  })
  registerReconciliationSweep().catch((err) => {
    console.error("[WORKER] Failed to register reconciliation sweep:", err)
  })
  registerWebsiteReverifySweep().catch((err) => {
    console.error("[WORKER] Failed to register website re-verify sweep:", err)
  })
  registerSettlementHoldLinkSweep().catch((err) => {
    console.error("[WORKER] Failed to register settlement-hold link sweep:", err)
  })
})

process.on("SIGTERM", async () => {
  console.log("[WORKER] Shutting down...")
  await Promise.all(workers.map((w) => w.close()))
  process.exit(0)
})

process.on("SIGINT", async () => {
  console.log("[WORKER] Shutting down...")
  await Promise.all(workers.map((w) => w.close()))
  process.exit(0)
})
