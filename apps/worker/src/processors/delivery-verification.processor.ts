import { prisma } from "@guestpost/database"
import {
  assertFinanceOperationAllowed,
  QUEUE_JOBS,
  QUEUES,
} from "@guestpost/shared"
// Node-only deep imports keep cheerio + aws-sdk + undici/dns out of the
// shared package's public index — the Next.js apps' webpack chokes on
// `node:*` schemes when bundling. safe-fetch (undici Agent + dns) joins
// the same convention as delivery-verification-core, object-storage,
// observability/structured-logger.
import {
  runDeliveryVerification,
  runSettlementHoldLinkSweep,
} from "@guestpost/shared/dist/delivery-verification-core"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { putObject } from "@guestpost/shared/dist/object-storage"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import * as Sentry from "@sentry/node"
import { Queue } from "bullmq"
import {
  deliveryVerificationDispatchBatchSize,
  dispatchPendingDeliveryVerifications,
  isDeliveryVerificationJobEligible,
} from "../delivery-verification-dispatch"
import { fetchWithChain } from "../delivery-verification-fetch"
import {
  dispatchCommunicationDedupKeysBestEffort,
  dispatchCommunicationEventsBestEffort,
} from "../lib/communication-outbox-dispatch"
import { createObservableWorker } from "../lib/queue-observability"
import { connection } from "../redis"
import { isRepeatableJob } from "../repeatable-job-registry"
import { enqueueTrustRecompute } from "../trust-enqueue"

const logger = createLogger("worker.delivery-verification")

// Delivery verification worker. Fetches the published page (SSRF-guarded,
// redirect chain resolved manually), then delegates to the pure core which
// parses HTML, persists evidence + snapshot, runs fraud detection, and
// transitions the delivery version. Retries on transient failure with 5/15/60m
// backoff; after exhaustion the core routes to MANUAL_REVIEW.

export function createDeliveryVerificationWorker() {
  const deps = {
    prisma,
    fetchUrl: fetchWithChain,
    putObject,
    onTrustEvent: enqueueTrustRecompute,
  }
  const worker = createObservableWorker(
    QUEUES.DELIVERY_VERIFICATION,
    async (job) => {
      // Phase 7.8 #27 — settlement-hold-sweep (repeatable) bypasses
      // freshness; ad-hoc verify jobs get a 96h window to accommodate
      // manual-review re-verify after a delivery dispute (backoff cap
      // is 60m × 3 attempts plus staff turnaround time).
      const maxAgeMs = isRepeatableJob(job.name) ? 0 : 96 * 60 * 60 * 1000
      if (!verifyJobPayload(job.data, { maxAgeMs })) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }
      // Settlement-hold link monitoring sweep (repeatable).
      if (job.name === "settlement-hold-sweep") {
        assertFinanceOperationAllowed("reconciliation")
        const res = await runSettlementHoldLinkSweep(deps)
        logger.info("settlement-hold link sweep complete", { result: res })
        if (res.failed > 0 || res.scanCapReached) {
          Sentry.captureMessage("Settlement-hold link sweep incomplete", {
            level: "warning",
            tags: {
              queue: QUEUES.DELIVERY_VERIFICATION,
              job: job.name,
              sweepRunId: job.id ?? "unknown",
            },
            extra: {
              scanned: res.scanned,
              checked: res.checked,
              failed: res.failed,
              scan_cap_reached: res.scanCapReached,
              oldest_unchecked_created_at:
                res.oldestUncheckedCreatedAt?.toISOString() ?? null,
            },
          })
        }
        return res
      }
      if (
        job.name === QUEUE_JOBS[QUEUES.DELIVERY_VERIFICATION].DISPATCH_SWEEP
      ) {
        assertFinanceOperationAllowed("new_liability")
        const queue = new Queue(QUEUES.DELIVERY_VERIFICATION, { connection })
        try {
          const res = await dispatchPendingDeliveryVerifications(
            prisma,
            queue,
            deliveryVerificationDispatchBatchSize(job.data?.batchSize),
          )
          logger.info("delivery verification dispatch sweep complete", {
            result: res,
          })
          return res
        } finally {
          await queue.close()
        }
      }
      if (job.name !== QUEUE_JOBS[QUEUES.DELIVERY_VERIFICATION].VERIFY) {
        logger.warn("unknown job name", { jobName: job.name })
        return
      }
      assertFinanceOperationAllowed("new_liability")
      const { deliveryVersionId, actorUserId } = job.data as {
        deliveryVersionId: string
        actorUserId?: string
      }
      const expectedVerificationVersion = job.data?.verificationVersion
      const eligible = await isDeliveryVerificationJobEligible(
        prisma,
        deliveryVersionId,
        expectedVerificationVersion,
      )
      if (!eligible) {
        logger.info("delivery verification skipped as stale or inactive", {
          deliveryVersionId,
          verificationVersion: job.data?.verificationVersion,
        })
        return { skipped: "stale_or_inactive" }
      }
      const maxAttempts = job.opts.attempts ?? 1
      const isFinalAttempt = job.attemptsMade >= maxAttempts - 1
      const res = await runDeliveryVerification(deps, deliveryVersionId, {
        expectedVerificationVersion,
        actorUserId,
        isFinalAttempt,
      })
      await dispatchCommunicationEventsBestEffort(
        res.communicationEventIds ?? [],
      )
      if (res.skipped === "already_verified") {
        await dispatchCommunicationDedupKeysBestEffort([
          `delivery:${deliveryVersionId}:verified`,
        ])
      }
      logger.info("delivery verification complete", {
        deliveryVersionId,
        attempt: job.attemptsMade + 1,
        maxAttempts,
        result: res,
      })
      return res
    },
    {
      connection,
      concurrency: 4,
      // 5m, 15m, 60m backoff between attempts.
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          const delays = [5, 15, 60].map((m) => m * 60 * 1000)
          return (
            delays[Math.min(attemptsMade - 1, delays.length - 1)] ??
            delays[delays.length - 1]
          )
        },
      },
    },
  )

  worker.on("completed", (job) =>
    logger.info("job completed", { jobId: job.id }),
  )
  worker.on("failed", (job, err) =>
    logger.error("job failed", { jobId: job?.id, err: err?.message }),
  )
  return worker
}
