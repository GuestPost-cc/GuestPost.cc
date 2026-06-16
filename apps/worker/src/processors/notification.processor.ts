import {
  QUEUES,
  getDedupHitsTotal,
  incrementDedupHits,
  isUniqueViolation,
  verifyJobPayload,
} from "@guestpost/shared"
import { prisma } from "@guestpost/database"
import { connection } from "../redis"
import { createObservableWorker } from "../lib/queue-observability"

export function createNotificationWorker() {
  const worker = createObservableWorker(
    QUEUES.NOTIFICATION,
    async (job) => {
      if (!verifyJobPayload(job.data)) {
        console.error(`[NOTIFICATION] Job ${job.id} has missing/invalid signature — rejecting`)
        throw new Error("Invalid job signature")
      }

      // Phase 7.4 — dedupKey is optional; absent means legacy NULL-dedup
      // (the partial unique index excludes NULL rows, so writes without a
      // key always succeed). Writers that want retry idempotency supply a
      // key from packages/shared/src/notification-dedup-keys.ts.
      const { userId, organizationId, type, message, dedupKey } = job.data as {
        userId: string
        organizationId: string | null
        type: string
        message: string
        dedupKey?: string | null
      }

      switch (job.name) {
        case "push-in-app":
          try {
            await prisma.notification.create({
              data: { userId, organizationId, type, message, dedupKey: dedupKey ?? null },
            })
            console.log(`[NOTIFICATION] In-app notification for user ${userId}`)
          } catch (err) {
            if (isUniqueViolation(err)) {
              // Phase 7.4 — a retry of this same logical event already wrote
              // the row. Treat as success; the notification has been delivered
              // to this user for this (dedupKey) and the retry is a no-op.
              const total = incrementDedupHits()
              console.log(
                `[NOTIFICATION] deduped key=${dedupKey} user=${userId} dedup_hits_total=${total}`,
              )
              break
            }
            throw err
          }
          break
        default:
          console.warn(`[NOTIFICATION] Unknown job: ${job.name}`)
      }

      return { notified: true, dedupHitsTotal: getDedupHitsTotal() }
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
