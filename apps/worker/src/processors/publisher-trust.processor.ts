import { connection } from "../redis"
import { QUEUES, verifyJobPayload, recomputePublisherTrustCore } from "@guestpost/shared"
import { prisma } from "@guestpost/database"
import { createObservableWorker } from "../lib/queue-observability"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { isRepeatableJob } from "../repeatable-job-registry"

const logger = createLogger("worker.publisher-trust")

// Event-driven publisher trust recompute. Any trust-affecting event enqueues a
// debounced, deduped job here; this re-scores the publisher from live data and
// syncs tier + audit + ops notification. Concurrency 1 per publisher is already
// guaranteed by the jobId dedup at enqueue time.
export function createPublisherTrustWorker() {
  const worker = createObservableWorker(
    QUEUES.PUBLISHER_TRUST,
    async (job) => {
      // Phase 7.8 #27 — repeatable cron jobs bypass freshness (none today
      // in this queue, but the helper future-proofs new repeatables).
      if (!verifyJobPayload(job.data, { maxAgeMs: isRepeatableJob(job.name) ? 0 : undefined })) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }
      const { publisherId, sourceEvent, reason } = job.data as { publisherId: string; sourceEvent: string; reason?: string }
      const res = await recomputePublisherTrustCore(prisma, publisherId, { sourceEvent, reason })
      return res ?? { skipped: "publisher_not_found" }
    },
    { connection, concurrency: 4 },
  )

  worker.on("completed", (job) => logger.info("job completed", { jobId: job.id }))
  worker.on("failed", (job, err) => logger.error("job failed", { jobId: job?.id, err: err?.message }))
  return worker
}
