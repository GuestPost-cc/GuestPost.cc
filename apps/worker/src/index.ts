import { createEmailWorker } from "./processors/email.processor"
import { createReportWorker } from "./processors/report.processor"
import { createNotificationWorker } from "./processors/notification.processor"
import { createVerificationWorker } from "./processors/verification.processor"

const workers = [
  createEmailWorker(),
  createReportWorker(),
  createNotificationWorker(),
  createVerificationWorker(),
]

console.log(`[WORKER] Started ${workers.length} workers`)

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
