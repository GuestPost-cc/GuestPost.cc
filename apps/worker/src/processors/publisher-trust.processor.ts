import { Worker } from "bullmq"
import { connection } from "../redis"
import { QUEUES, verifyJobPayload, recomputePublisherTrustCore } from "@guestpost/shared"
import { prisma } from "@guestpost/database"

// Event-driven publisher trust recompute. Any trust-affecting event enqueues a
// debounced, deduped job here; this re-scores the publisher from live data and
// syncs tier + audit + ops notification. Concurrency 1 per publisher is already
// guaranteed by the jobId dedup at enqueue time.
export function createPublisherTrustWorker() {
  const worker = new Worker(
    QUEUES.PUBLISHER_TRUST,
    async (job) => {
      if (!verifyJobPayload(job.data)) {
        console.error(`[TRUST] Job ${job.id} missing/invalid signature — rejecting`)
        throw new Error("Invalid job signature")
      }
      const { publisherId, sourceEvent, reason } = job.data as { publisherId: string; sourceEvent: string; reason?: string }
      const res = await recomputePublisherTrustCore(prisma, publisherId, { sourceEvent, reason })
      return res ?? { skipped: "publisher_not_found" }
    },
    { connection, concurrency: 4 },
  )

  worker.on("completed", (job) => console.log(`[TRUST] Job ${job.id} completed`))
  worker.on("failed", (job, err) => console.error(`[TRUST] Job ${job?.id} failed:`, err?.message))
  return worker
}
