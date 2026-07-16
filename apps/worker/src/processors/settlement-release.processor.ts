import { prisma } from "@guestpost/database"
import { QUEUES, runSettlementAutoRelease } from "@guestpost/shared"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import * as Sentry from "@sentry/node"
import { createObservableWorker } from "../lib/queue-observability"
import { connection } from "../redis"
import { isRepeatableJob } from "../repeatable-job-registry"
import { enqueueTrustRecompute } from "../trust-enqueue"

const logger = createLogger("worker.settlement-release")

const SLOW_SWEEP_DEFAULT_MS = 30_000

let runsTotal = 0

export function createSettlementReleaseWorker() {
  return createObservableWorker(
    QUEUES.SETTLEMENT_RELEASE,
    async (job) => {
      if (
        !verifyJobPayload(job.data, {
          maxAgeMs: isRepeatableJob(job.name) ? 0 : undefined,
        })
      ) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }

      if (job.name !== "settlement-auto-release") {
        logger.warn("unexpected job name — skipping", { jobName: job.name })
        return
      }

      const batchSize = clampBatchSize(
        (job.data as { batchSize?: number }).batchSize,
      )
      const slowMs = Math.max(
        Number(process.env.SETTLEMENT_RELEASE_SLOW_MS) || SLOW_SWEEP_DEFAULT_MS,
        1000,
      )

      runsTotal++

      const onError = (err: unknown, settlementId: string) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(
          "per-settlement transaction failed in auto-release sweep",
          {
            settlementId,
            err: message,
            jobId: job.id,
          },
        )
        Sentry.captureException(err, {
          tags: {
            queue: "settlement",
            job: job.name,
            sweepRunId: job.id ?? "unknown",
          },
          contexts: { settlement_auto_release: { settlementId } },
          fingerprint: ["settlement-auto-release", settlementId],
        } as any)
      }

      const result = await runSettlementAutoRelease(prisma, {
        batchSize,
        onError,
        onRelease: (s) => {
          enqueueTrustRecompute(
            s.publisherId,
            "SETTLEMENT_RELEASED",
            `auto-release of settlement ${s.id}`,
          )
        },
      })

      logger.info("sweep complete", {
        runs_total: runsTotal,
        scanned: result.scanned,
        released: result.released,
        skipped: result.skipped,
        duration_ms: result.durationMs,
      })

      if (result.durationMs > slowMs) {
        Sentry.captureMessage("Settlement auto-release sweep slow", {
          level: "warning",
          extra: {
            duration_ms: result.durationMs,
            slow_threshold_ms: slowMs,
            scanned: result.scanned,
            released: result.released,
            batch_size: batchSize,
          },
        })
      }
    },
    { connection, concurrency: 1 },
  )
}

function clampBatchSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 100
  const rounded = Math.floor(value)
  if (rounded < 1) return 1
  if (rounded > 10_000) return 10_000
  return rounded
}
