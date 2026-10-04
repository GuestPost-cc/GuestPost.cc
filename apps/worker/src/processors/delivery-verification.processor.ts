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
  type DeliveryVerificationDispatchCursor,
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
const DISPATCH_SWEEP_CURSOR_KEY =
  "guestpost:worker:delivery-verification-dispatch-cursor:v1"
const DISPATCH_SWEEP_CURSOR_TTL_SECONDS = 30 * 24 * 60 * 60

/** Read a validated cursor so delayed jobs cannot pin the recovery sweep. */
async function loadDispatchSweepCursor(): Promise<
  DeliveryVerificationDispatchCursor | undefined
> {
  try {
    const raw = await connection.get(DISPATCH_SWEEP_CURSOR_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(
      raw,
    ) as Partial<DeliveryVerificationDispatchCursor>
    const createdAt = new Date(parsed.createdAt ?? "")
    if (
      typeof parsed.id !== "string" ||
      parsed.id.length === 0 ||
      parsed.id.length > 200 ||
      !Number.isFinite(createdAt.getTime())
    ) {
      await connection.del(DISPATCH_SWEEP_CURSOR_KEY)
      return undefined
    }
    return { id: parsed.id, createdAt: createdAt.toISOString() }
  } catch (error) {
    logger.warn("delivery verification dispatch cursor read failed", {
      err: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

/** Persist the next page, or clear the cursor after the final page. */
async function saveDispatchSweepCursor(
  cursor: DeliveryVerificationDispatchCursor | null,
): Promise<void> {
  try {
    if (!cursor) {
      await connection.del(DISPATCH_SWEEP_CURSOR_KEY)
      return
    }
    await connection.set(
      DISPATCH_SWEEP_CURSOR_KEY,
      JSON.stringify(cursor),
      "EX",
      DISPATCH_SWEEP_CURSOR_TTL_SECONDS,
    )
  } catch (error) {
    logger.warn("delivery verification dispatch cursor write failed", {
      err: error instanceof Error ? error.message : String(error),
    })
  }
}

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
            await loadDispatchSweepCursor(),
          )
          await saveDispatchSweepCursor(res.nextCursor)
          const { failures, nextCursor: _cursor, ...stats } = res
          logger.info("delivery verification dispatch sweep complete", {
            result: stats,
          })
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              `Failed to dispatch ${failures.length} delivery verifications`,
            )
          }
          return stats
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
