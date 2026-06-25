import { QUEUE_JOBS, QUEUES, trustRecomputeJobOptions } from "@guestpost/shared"
import { signJobPayload } from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { Queue } from "bullmq"
import { connection } from "./redis"

const logger = createLogger("worker.trust-enqueue")

// Single shared producer for worker-side trust recompute events (link removal/
// restoration, website revoke/reverify). Signed + jobId-deduped so bursts
// collapse into one recompute per publisher.
let queue: Queue | null = null
function getQueue(): Queue {
  if (!queue) queue = new Queue(QUEUES.PUBLISHER_TRUST, { connection })
  return queue
}

export async function enqueueTrustRecompute(
  publisherId: string | null | undefined,
  sourceEvent: string,
  reason?: string,
): Promise<void> {
  if (!publisherId) return
  try {
    await getQueue().add(
      QUEUE_JOBS[QUEUES.PUBLISHER_TRUST].RECOMPUTE,
      signJobPayload({
        publisherId,
        sourceEvent,
        reason: reason ?? sourceEvent,
      }),
      trustRecomputeJobOptions(publisherId),
    )
    logger.info("trust recompute enqueued", { publisherId, sourceEvent })
  } catch (err) {
    logger.error("trust recompute enqueue failed", {
      publisherId,
      err: String(err),
    })
  }
}
