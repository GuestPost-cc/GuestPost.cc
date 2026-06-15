import { config } from "dotenv"
// Dev env file loads ONLY under explicit NODE_ENV=development — unset NODE_ENV
// (staging, CI) fails closed instead of silently using dev secrets
if (process.env.NODE_ENV === "development") {
  config({ path: require("path").resolve(__dirname, "../../../.env.development") })
}
// Sentry must initialize BEFORE any other module so its auto-instrumentation
// can wrap http / pg / undici. Phase 7.0.
import * as Sentry from "@sentry/node"
import { initSentry } from "@guestpost/shared"
initSentry(Sentry, { runtime: "worker" })

import { validateEnv } from "./lib/env"
validateEnv()

import { createEmailWorker } from "./processors/email.processor"
import { createReportWorker } from "./processors/report.processor"
import { createNotificationWorker } from "./processors/notification.processor"
import { createVerificationWorker } from "./processors/verification.processor"
import { createPayoutWorker } from "./processors/payout.processor"
import { createReconciliationWorker } from "./processors/reconciliation.processor"
import { createWebsiteVerificationWorker } from "./processors/website-verification.processor"
import { createDeliveryVerificationWorker } from "./processors/delivery-verification.processor"
import { createPublisherTrustWorker } from "./processors/publisher-trust.processor"
import { connection } from "./redis"
import { prisma } from "@guestpost/database"
import { Queue } from "bullmq"
import { QUEUES, signJobPayload } from "@guestpost/shared"
import { startHealthServer, type HealthServerHandle } from "./lib/health-server"

// Stuck-payout safety net: webhooks are the primary completion signal, this
// poll catches transfers whose webhook was lost or never configured.
async function registerPayoutStatusPoll() {
  const queue = new Queue(QUEUES.PAYOUT, { connection })
  await queue.add(
    "payout-check-status",
    signJobPayload({ limit: 50 }),
    {
      repeat: { every: 10 * 60 * 1000 },
      jobId: "payout-check-status-poll",
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 10 },
    },
  )
  await queue.close()
  console.log("[WORKER] Registered payout status poll (every 10m)")
}

// Scheduled drift sweep — alerting must not depend on a human remembering to
// call GET /admin/reconciliation. Interval configurable for ops tuning.
async function registerReconciliationSweep() {
  const everyMs = Math.max(Number(process.env.RECONCILIATION_SWEEP_MINUTES ?? 60), 5) * 60 * 1000
  const queue = new Queue(QUEUES.RECONCILIATION, { connection })
  await queue.add(
    "reconciliation-run",
    signJobPayload({}),
    {
      repeat: { every: everyMs },
      jobId: "reconciliation-sweep",
      removeOnComplete: { count: 24 },
      removeOnFail: { count: 24 },
    },
  )
  await queue.close()
  console.log(`[WORKER] Registered reconciliation sweep (every ${everyMs / 60000}m)`)
}

// Domain re-verification sweep — every VERIFIED site is re-checked every 30d
// and REVOKED if its TXT record vanished. Trust must decay, not persist forever.
async function registerWebsiteReverifySweep() {
  const everyMs = Math.max(Number(process.env.WEBSITE_REVERIFY_DAYS ?? 30), 1) * 24 * 60 * 60 * 1000
  const queue = new Queue(QUEUES.WEBSITE_VERIFICATION, { connection })
  await queue.add(
    "website-reverify-sweep",
    signJobPayload({}),
    {
      repeat: { every: everyMs },
      jobId: "website-reverify-sweep",
      removeOnComplete: { count: 12 },
      removeOnFail: { count: 12 },
    },
  )
  await queue.close()
  console.log(`[WORKER] Registered website re-verify sweep (every ${everyMs / 86400000}d)`)
}

// Settlement-hold link monitoring — re-check the live link for every order
// whose payout is still on hold. If removed, raises a fraud flag that blocks
// release. Default every 6h.
async function registerSettlementHoldLinkSweep() {
  const everyMs = Math.max(Number(process.env.SETTLEMENT_LINK_SWEEP_HOURS ?? 6), 1) * 60 * 60 * 1000
  const queue = new Queue(QUEUES.DELIVERY_VERIFICATION, { connection })
  await queue.add(
    "settlement-hold-sweep",
    signJobPayload({}),
    {
      repeat: { every: everyMs },
      jobId: "settlement-hold-sweep",
      removeOnComplete: { count: 24 },
      removeOnFail: { count: 24 },
    },
  )
  await queue.close()
  console.log(`[WORKER] Registered settlement-hold link sweep (every ${everyMs / 3600000}h)`)
}

async function checkConnections() {
  try {
    await connection.ping()
  } catch (err) {
    console.error("[WORKER] FATAL: Redis connection failed:", err)
    process.exit(1)
  }
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    console.error("[WORKER] FATAL: Database connection failed:", err)
    process.exit(1)
  }
  console.log("[WORKER] Redis + database connections verified")
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
const SHOULD_EXIT_ON_UNHANDLED_REJECTION = process.env.UNHANDLED_REJECTION_EXIT !== "false"

async function flushAndExit(code: number, reason: string, err: unknown): Promise<never> {
  console.error(`[WORKER] FATAL: ${reason}:`, err)
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
  console.error("[WORKER] unhandledRejection (continuing — UNHANDLED_REJECTION_EXIT=false):", reason)
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
  )
  console.log(`[WORKER] Started ${workers.length} workers`)
  await Promise.all([
    registerPayoutStatusPoll().catch((err) =>
      console.error("[WORKER] Failed to register payout status poll:", err),
    ),
    registerReconciliationSweep().catch((err) =>
      console.error("[WORKER] Failed to register reconciliation sweep:", err),
    ),
    registerWebsiteReverifySweep().catch((err) =>
      console.error("[WORKER] Failed to register website re-verify sweep:", err),
    ),
    registerSettlementHoldLinkSweep().catch((err) =>
      console.error("[WORKER] Failed to register settlement-hold link sweep:", err),
    ),
  ])
}

bootstrap().catch((err) => {
  console.error("[WORKER] FATAL: bootstrap failed:", err)
  Sentry.captureException(err)
  void Sentry.flush(2000).finally(() => process.exit(1))
})

async function shutdown(signal: string): Promise<void> {
  console.log(`[WORKER] ${signal} received — draining workers...`)
  await Promise.all(workers.map((w) => w.close().catch((err) => console.error("[WORKER] worker close error:", err))))
  if (healthServer) {
    await healthServer.close().catch((err) => console.error("[WORKER] health server close error:", err))
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
