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
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"

const logger = createLogger("worker.notification")

export function createNotificationWorker() {
  const worker = createObservableWorker(
    QUEUES.NOTIFICATION,
    async (job) => {
      if (!verifyJobPayload(job.data)) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
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
            logger.info("in-app notification created", { userId })
          } catch (err) {
            if (isUniqueViolation(err)) {
              // Phase 7.4 — a retry of this same logical event already wrote
              // the row. Treat as success; the notification has been delivered
              // to this user for this (dedupKey) and the retry is a no-op.
              const total = incrementDedupHits()
              logger.info("notification deduped (P2002)", {
                dedupKey,
                userId,
                dedup_hits_total: total,
              })
              break
            }
            throw err
          }
          break
        default:
          logger.warn("unknown job name", { jobName: job.name })
      }

      return { notified: true, dedupHitsTotal: getDedupHitsTotal() }
    },
    { connection },
  )

  worker.on("completed", (job) => {
    logger.info("job completed", { jobId: job.id })
  })

  worker.on("failed", (job, err) => {
    logger.error("job failed", { jobId: job?.id, err: err?.message })
  })

  return worker
}
