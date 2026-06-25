import { config } from "dotenv"

// Dev env file loads ONLY under explicit NODE_ENV=development — unset NODE_ENV
// (staging, CI) fails closed instead of silently using dev secrets
if (process.env.NODE_ENV === "development") {
  config({
    path: require("node:path").resolve(__dirname, "../../../.env.development"),
  })
}

import { initSentry } from "@guestpost/shared"
// Sentry must initialize BEFORE any other module so its auto-instrumentation
// can wrap http / pg / undici. Phase 7.0.
import * as Sentry from "@sentry/node"

initSentry(Sentry, { runtime: "worker" })

import { validateEnv } from "./lib/env"

validateEnv()

import { prisma } from "@guestpost/database"
import { QUEUES } from "@guestpost/shared"
import { signJobPayload } from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { Queue } from "bullmq"
import { type HealthServerHandle, startHealthServer } from "./lib/health-server"
import { createDeliveryVerificationWorker } from "./processors/delivery-verification.processor"
import { createEmailWorker } from "./processors/email.processor"
import { createNotificationWorker } from "./processors/notification.processor"
import { createPayoutWorker } from "./processors/payout.processor"
import { createPublisherTrustWorker } from "./processors/publisher-trust.processor"
import { createReconciliationWorker } from "./processors/reconciliation.processor"
import { createReportWorker } from "./processors/report.processor"
import { createSettlementAutoApproveWorker } from "./processors/settlement-auto-approve.processor"
import { createVerificationWorker } from "./processors/verification.processor"
import { createWebsiteVerificationWorker } from "./processors/website-verification.processor"
import { connection } from "./redis"

const logger = createLogger("worker.bootstrap")

// Phase 7.8 #27 — IF YOU ADD A NEW REPEATABLE BELOW, add its job name
// to REPEATABLE_JOB_NAMES in apps/worker/src/repeatable-job-registry.ts.
// The drift-guard spec at __tests__/repeatable-job-registry.spec.ts
// asserts both directions and will fail CI loudly if either side moves
// without the other. Reason: the iat freshness check in
// verifyJobPayload rejects payloads older than maxAgeMs, and a
// repeatable's payload is signed ONCE at boot then reused across
// recurrences — so without the bypass, every recurrence after the
// window expires fails verification.

// Stuck-payout safety net: webhooks are the primary completion signal, this
// poll catches transfers whose webhook was lost or never configured.
async function registerPayoutStatusPoll() {
  const queue = new Queue(QUEUES.PAYOUT, { connection })
  await queue.add("payout-check-status", signJobPayload({ limit: 50 }), {
    repeat: { every: 10 * 60 * 1000 },
    jobId: "payout-check-status-poll",
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 10 },
  })
  await queue.close()
  logger.info("registered payout status poll", { intervalMs: 10 * 60 * 1000 })
}

// Scheduled drift sweep — alerting must not depend on a human remembering to
// call GET /admin/reconciliation. Interval configurable for ops tuning.
async function registerReconciliationSweep() {
  const everyMs =
    Math.max(Number(process.env.RECONCILIATION_SWEEP_MINUTES ?? 60), 5) *
    60 *
    1000
  const queue = new Queue(QUEUES.RECONCILIATION, { connection })
  await queue.add("reconciliation-run", signJobPayload({}), {
    repeat: { every: everyMs },
    jobId: "reconciliation-sweep",
    removeOnComplete: { count: 24 },
    removeOnFail: { count: 24 },
  })
  await queue.close()
  logger.info("registered reconciliation sweep", {
    intervalMs: everyMs,
    intervalMin: everyMs / 60000,
  })
}

// Domain re-verification sweep — every VERIFIED site is re-checked every 30d
// and REVOKED if its TXT record vanished. Trust must decay, not persist forever.
async function registerWebsiteReverifySweep() {
  const everyMs =
    Math.max(Number(process.env.WEBSITE_REVERIFY_DAYS ?? 30), 1) *
    24 *
    60 *
    60 *
    1000
  const queue = new Queue(QUEUES.WEBSITE_VERIFICATION, { connection })
  await queue.add("website-reverify-sweep", signJobPayload({}), {
    repeat: { every: everyMs },
    jobId: "website-reverify-sweep",
    removeOnComplete: { count: 12 },
    removeOnFail: { count: 12 },
  })
  await queue.close()
  logger.info("registered website re-verify sweep", {
    intervalMs: everyMs,
    intervalDays: everyMs / 86400000,
  })
}

// Settlement-hold link monitoring — re-check the live link for every order
// whose payout is still on hold. If removed, raises a fraud flag that blocks
// release. Default every 6h.
async function registerSettlementHoldLinkSweep() {
  const everyMs =
    Math.max(Number(process.env.SETTLEMENT_LINK_SWEEP_HOURS ?? 6), 1) *
    60 *
    60 *
    1000
  const queue = new Queue(QUEUES.DELIVERY_VERIFICATION, { connection })
  await queue.add("settlement-hold-sweep", signJobPayload({}), {
    repeat: { every: everyMs },
    jobId: "settlement-hold-sweep",
    removeOnComplete: { count: 24 },
    removeOnFail: { count: 24 },
  })
  await queue.close()
  logger.info("registered settlement-hold link sweep", {
    intervalMs: everyMs,
    intervalHours: everyMs / 3600000,
  })
}

// Phase 7.3 — settlement review window auto-approval. Replaces the per-API-pod
// setInterval; one worker, one cron, one sweep per cadence cluster-wide via
// BullMQ jobId dedup. Preserves the two existing env vars
// (SETTLEMENT_AUTO_APPROVE_INTERVAL_MS, SETTLEMENT_AUTO_APPROVE_DISABLED) so
// ops muscle memory keeps working. Adds SETTLEMENT_AUTO_APPROVE_BATCH_SIZE
// for tuning during backlog recovery.
async function registerSettlementAutoApproveSweep() {
  if (process.env.SETTLEMENT_AUTO_APPROVE_DISABLED === "true") {
    logger.info(
      "settlement auto-approve disabled — skipping cron registration",
      {
        env: "SETTLEMENT_AUTO_APPROVE_DISABLED",
      },
    )
    return
  }
  const everyMs = Math.max(
    Number(process.env.SETTLEMENT_AUTO_APPROVE_INTERVAL_MS ?? 15 * 60 * 1000),
    60_000,
  )
  const batchSize = Math.min(
    Math.max(Number(process.env.SETTLEMENT_AUTO_APPROVE_BATCH_SIZE) || 100, 1),
    10_000,
  )
  const queue = new Queue(QUEUES.SETTLEMENT, { connection })
  await queue.add("settlement-auto-approve", signJobPayload({ batchSize }), {
    repeat: { every: everyMs },
    jobId: "settlement-auto-approve",
    removeOnComplete: { count: 24 },
    removeOnFail: { count: 24 },
  })
  await queue.close()
  logger.info("registered settlement auto-approve sweep", {
    intervalMs: everyMs,
    intervalMin: everyMs / 60000,
    batchSize,
  })
}

async function checkConnections() {
  try {
    await connection.ping()
  } catch (err) {
    logger.error("FATAL: Redis connection failed", {
      err: err instanceof Error ? err.message : String(err),
    })
    process.exit(1)
  }
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    logger.error("FATAL: Database connection failed", {
      err: err instanceof Error ? err.message : String(err),
    })
    process.exit(1)
  }
  logger.info("Redis + database connections verified")
}

const workers: Array<{ close: () => Promise<void> }> = []
let healthServer: HealthServerHandle | undefined

// Phase 7.0 — unhandledRejection policy.
//
// Default: capture to Sentry, flush, exit(1). Let the orchestrator restart.
// Override with UNHANDLED_REJECTION_EXIT=false for dev convenience (e.g.
// debugging a hanging Promise without losing the worker process).
//
// Why exit by default in a worker handling money: a worker mid-processing a
// settlement-release or refund clawback that suffers an unhandled rejection
// has potentially-corrupted in-memory state. Continuing to process the next
// job risks committing inconsistent state. A pod restart loses one in-flight
// job (BullMQ retries it); continuing in a bad state loses N future ones.
const SHOULD_EXIT_ON_UNHANDLED_REJECTION =
  process.env.UNHANDLED_REJECTION_EXIT !== "false"

async function flushAndExit(
  code: number,
  reason: string,
  err: unknown,
): Promise<never> {
  logger.error("FATAL: process exit", {
    reason,
    err: err instanceof Error ? err.message : String(err),
  })
  Sentry.captureException(err)
  try {
    await Sentry.flush(2000)
  } catch {
    /* nothing we can do — exiting anyway */
  }
  process.exit(code)
}

process.on("unhandledRejection", (reason: unknown) => {
  if (SHOULD_EXIT_ON_UNHANDLED_REJECTION) {
    void flushAndExit(1, "unhandledRejection", reason)
    return
  }
  logger.error(
    "unhandledRejection (continuing — UNHANDLED_REJECTION_EXIT=false)",
    {
      reason: reason instanceof Error ? reason.message : String(reason),
    },
  )
  Sentry.captureException(reason)
})

process.on("uncaughtException", (err: Error) => {
  // uncaughtException ALWAYS exits — Node's default is exit, and a worker
  // with a corrupt V8 state cannot be trusted to continue regardless of env.
  void flushAndExit(1, "uncaughtException", err)
})

async function bootstrap() {
  await checkConnections()
  healthServer = await startHealthServer()

  workers.push(
    createEmailWorker(),
    createReportWorker(),
    createNotificationWorker(),
    createVerificationWorker(),
    createPayoutWorker(),
    createReconciliationWorker(),
    createWebsiteVerificationWorker(),
    createDeliveryVerificationWorker(),
    createPublisherTrustWorker(),
    createSettlementAutoApproveWorker(),
  )
  logger.info("workers started", { count: workers.length })
  await Promise.all([
    registerPayoutStatusPoll().catch((err) =>
      logger.error("failed to register payout status poll", {
        err: err instanceof Error ? err.message : String(err),
      }),
    ),
    registerReconciliationSweep().catch((err) =>
      logger.error("failed to register reconciliation sweep", {
        err: err instanceof Error ? err.message : String(err),
      }),
    ),
    registerWebsiteReverifySweep().catch((err) =>
      logger.error("failed to register website re-verify sweep", {
        err: err instanceof Error ? err.message : String(err),
      }),
    ),
    registerSettlementHoldLinkSweep().catch((err) =>
      logger.error("failed to register settlement-hold link sweep", {
        err: err instanceof Error ? err.message : String(err),
      }),
    ),
    registerSettlementAutoApproveSweep().catch((err) =>
      logger.error("failed to register settlement auto-approve sweep", {
        err: err instanceof Error ? err.message : String(err),
      }),
    ),
  ])
}

bootstrap().catch((err) => {
  logger.error("FATAL: bootstrap failed", {
    err: err instanceof Error ? err.message : String(err),
  })
  Sentry.captureException(err)
  void Sentry.flush(2000).finally(() => process.exit(1))
})

async function shutdown(signal: string): Promise<void> {
  logger.info("signal received — draining workers", { signal })
  await Promise.all(
    workers.map((w) =>
      w.close().catch((err) =>
        logger.error("worker close error", {
          err: err instanceof Error ? err.message : String(err),
        }),
      ),
    ),
  )
  if (healthServer) {
    await healthServer.close().catch((err) =>
      logger.error("health server close error", {
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  try {
    await prisma.$disconnect()
  } catch (err) {
    logger.error("prisma $disconnect error", {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    await Sentry.flush(2000)
  } catch {
    /* best-effort */
  }
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
