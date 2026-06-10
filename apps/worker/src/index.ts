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
import { connection } from "./redis"
import { prisma } from "@guestpost/database"

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
  )
  console.log(`[WORKER] Started ${workers.length} workers`)
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
