import { Queue } from "bullmq"
import { connection } from "./redis"
import { QUEUES, QUEUE_JOBS, signJobPayload, trustRecomputeJobOptions } from "@guestpost/shared"

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
      signJobPayload({ publisherId, sourceEvent, reason: reason ?? sourceEvent }),
      trustRecomputeJobOptions(publisherId),
    )
    console.log(`[TRUST] enqueued recompute publisher=${publisherId} source=${sourceEvent}`)
  } catch (err) {
    console.error(`[TRUST] failed to enqueue recompute for ${publisherId}:`, err)
  }
}
