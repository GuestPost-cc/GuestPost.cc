// Phase 7.3 — Settlement auto-approve worker (audit #10).
//
// Replaces the per-API-pod setInterval timer in apps/api/src/modules/settlements/
// settlement-auto-approve.service.ts (now deleted). One worker, one cron, one
// sweep per cadence cluster-wide — BullMQ jobId dedup is the guarantee.
//
// Three operational alerts wired in:
//   1. Structured log line per sweep — grep-able counters
//      `[SETTLEMENT_AUTO_APPROVE] runs_total=N scanned=M approved=K skipped=L stale=S duration_ms=D`
//   2. Slow-sweep warning to Sentry if duration_ms > SETTLEMENT_AUTO_APPROVE_SLOW_MS
//      (default 30000) — catches future backlog / DB-stall scenarios
//   3. Stale-review warning to Sentry if any settlement is >24h past
//      reviewEndsAt and still PENDING/UNDER_REVIEW — catches a stuck sweeper
//
// Dead-letter alerting is automatic via Phase 7.0's createObservableWorker
// (failed events → Sentry.captureException with attemptsMade tag). Filter
// Sentry by attemptsMade >= 3 for final-failure events.

import * as Sentry from "@sentry/node"
import {
  QUEUES,
  countStaleReviewSettlements,
  runSettlementAutoApprove,
  verifyJobPayload,
} from "@guestpost/shared"
import { prisma } from "@guestpost/database"
import { connection } from "../redis"
import { createObservableWorker } from "../lib/queue-observability"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { isRepeatableJob } from "../repeatable-job-registry"

const logger = createLogger("worker.settlement-auto-approve")

const SLOW_SWEEP_DEFAULT_MS = 30_000

// Cumulative since worker start. Resets on restart — long-term aggregation
// is the log-retention layer's job.
let runsTotal = 0

export function createSettlementAutoApproveWorker() {
  return createObservableWorker(
    QUEUES.SETTLEMENT,
    async (job) => {
      // Phase 7.8 #27 — settlement-auto-approve (repeatable) bypasses
      // freshness; payload is signed once at boot and reused per cron tick.
      if (!verifyJobPayload(job.data, { maxAgeMs: isRepeatableJob(job.name) ? 0 : undefined })) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }

      if (job.name !== "settlement-auto-approve") {
        logger.warn("unexpected job name — skipping", { jobName: job.name })
        return
      }

      const batchSize = clampBatchSize((job.data as { batchSize?: number }).batchSize)
      const slowMs = Math.max(Number(process.env.SETTLEMENT_AUTO_APPROVE_SLOW_MS) || SLOW_SWEEP_DEFAULT_MS, 1000)

      runsTotal++
      const result = await runSettlementAutoApprove(prisma, { batchSize })
      const stale = await countStaleReviewSettlements(prisma)

      logger.info("sweep complete", {
        runs_total: runsTotal,
        scanned: result.scanned,
        approved: result.approved,
        skipped: result.skipped,
        stale,
        duration_ms: result.durationMs,
      })

      if (result.durationMs > slowMs) {
        Sentry.captureMessage("Settlement auto-approve sweep slow", {
          level: "warning",
          extra: {
            duration_ms: result.durationMs,
            slow_threshold_ms: slowMs,
            scanned: result.scanned,
            approved: result.approved,
            batch_size: batchSize,
          },
        })
      }

      if (stale > 0) {
        Sentry.captureMessage("Stale settlement review windows detected", {
          level: "warning",
          extra: { count: stale, stale_threshold_hours: 24 },
        })
      }
    },
    { connection, concurrency: 1 },
  )
}

/**
 * Validates the batch size coming from the signed job payload. Clamps to
 * [1, 10_000]; falls back to 100 on invalid/missing input. Same defensive
 * shape as Phase 7.2's getSettlementReviewDays env override.
 */
function clampBatchSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 100
  const rounded = Math.floor(value)
  if (rounded < 1) return 1
  if (rounded > 10_000) return 10_000
  return rounded
}

// Exported for tests
export const __internals = { clampBatchSize }
