import { connection } from "../redis"
import { QUEUES, verifyJobPayload } from "@guestpost/shared"
import { prisma } from "@guestpost/database"
import { createObservableWorker } from "../lib/queue-observability"

export function createNotificationWorker() {
  const worker = createObservableWorker(
    QUEUES.NOTIFICATION,
    async (job) => {
      if (!verifyJobPayload(job.data)) {
        console.error(`[NOTIFICATION] Job ${job.id} has missing/invalid signature — rejecting`)
        throw new Error("Invalid job signature")
      }

      const { userId, organizationId, type, message } = job.data

      switch (job.name) {
        case "push-in-app":
          await prisma.notification.create({
            data: { userId, organizationId, type, message },
          })
          console.log(`[NOTIFICATION] In-app notification for user ${userId}`)
          break
        default:
          console.warn(`[NOTIFICATION] Unknown job: ${job.name}`)
      }

      return { notified: true }
    },
    { connection },
  )

  worker.on("completed", (job) => {
    console.log(`[NOTIFICATION] Job ${job.id} completed`)
  })

  worker.on("failed", (job, err) => {
    console.error(`[NOTIFICATION] Job ${job?.id} failed:`, err)
  })

  return worker
}
