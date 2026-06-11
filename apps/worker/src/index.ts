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
  )
  console.log(`[WORKER] Started ${workers.length} workers`)
  registerPayoutStatusPoll().catch((err) => {
    console.error("[WORKER] Failed to register payout status poll:", err)
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
