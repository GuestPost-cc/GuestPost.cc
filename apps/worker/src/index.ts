// Worker environment prelude — MUST be the first import.
// dotenv config() must run before any module that reads process.env at
// load-time (e.g. @guestpost/database). See load-env.ts for rationale.
import "./load-env"

import { initSentry } from "@guestpost/shared"
// Sentry must initialize BEFORE any other module so its auto-instrumentation
// can wrap http / pg / undici. Phase 7.0.
import * as Sentry from "@sentry/node"

initSentry(Sentry, { runtime: "worker" })

import { validateEnv } from "./lib/env"

validateEnv()

import { prisma } from "@guestpost/database"
import {
  QUEUE_JOBS,
  QUEUES,
  resolveOrderCancellationConfig,
} from "@guestpost/shared"
import { signJobPayload } from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { Queue, QueueEvents } from "bullmq"
import { type HealthServerHandle, startHealthServer } from "./lib/health-server"
import {
  MAINTENANCE_DISPATCH_TASK,
  type MaintenanceTaskName,
  maintenanceTasksDueAt,
} from "./lib/maintenance-schedule"
import { createAutoAcceptWorker } from "./processors/auto-accept.processor"
import { createDeliveryVerificationWorker } from "./processors/delivery-verification.processor"
import { createDomainMetricsWorker } from "./processors/domain-metrics.processor"
import { createEmailWorker } from "./processors/email.processor"
import { createNotificationWorker } from "./processors/notification.processor"
import {
  createPayoutWorker,
  processPayoutWebhookInbox,
} from "./processors/payout.processor"
import { createPublisherTrustWorker } from "./processors/publisher-trust.processor"
import { createReconciliationWorker } from "./processors/reconciliation.processor"
import { createReportWorker } from "./processors/report.processor"
import { createSettlementAutoApproveWorker } from "./processors/settlement-auto-approve.processor"
import { createSettlementReleaseWorker } from "./processors/settlement-release.processor"
import { createVerificationWorker } from "./processors/verification.processor"
import { createWebsiteVerificationWorker } from "./processors/website-verification.processor"
import { connection } from "./redis"
import { assertNoRegistryDrift, RegisteredJob } from "./repeatable-job-registry"

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
async function registerPayoutStatusPoll(): Promise<RegisteredJob> {
  const queue = new Queue(QUEUES.PAYOUT, { connection })
  // Stale repeatable jobs signed with a previous iat (from an old worker boot)
  // would fail HMAC verification. Remove the old config before registering
  // with a deterministic iat=0 so the payload is bit-identical across restarts.
  await queue
    .removeRepeatable("payout-check-status", { every: 10 * 60 * 1000 })
    .catch(() => {})
  await queue.add("payout-check-status", signJobPayload({ limit: 50 }, 0), {
    repeat: { every: 10 * 60 * 1000 },
    jobId: "payout-check-status-poll",
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 10 },
  })
  await queue.close()
  logger.info("registered payout status poll", { intervalMs: 10 * 60 * 1000 })
  return { name: "payout-check-status", queue: QUEUES.PAYOUT }
}

// Scheduled drift sweep — alerting must not depend on a human remembering to
// call GET /admin/reconciliation. Interval configurable for ops tuning.
async function registerReconciliationSweep(): Promise<RegisteredJob> {
  const everyMs =
    Math.max(Number(process.env.RECONCILIATION_SWEEP_MINUTES ?? 60), 5) *
    60 *
    1000
  const queue = new Queue(QUEUES.RECONCILIATION, { connection })
  await queue
    .removeRepeatable("reconciliation-run", { every: everyMs })
    .catch(() => {})
  await queue.add("reconciliation-run", signJobPayload({}, 0), {
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
  return { name: "reconciliation-run", queue: QUEUES.RECONCILIATION }
}

// Daily governance sweep expires temporary overrides within 24h. The core
// filters normal DNS-backed sites to the 30-day recheck cadence.
async function registerWebsiteReverifySweep(): Promise<RegisteredJob> {
  const everyMs =
    Math.max(Number(process.env.WEBSITE_REVERIFY_SWEEP_HOURS ?? 24), 1) *
    60 *
    60 *
    1000
  const queue = new Queue(QUEUES.WEBSITE_VERIFICATION, { connection })
  const existing = await queue.getRepeatableJobs()
  await Promise.all(
    existing
      .filter((job) => job.name === "website-reverify-sweep")
      .map((job) => queue.removeRepeatableByKey(job.key)),
  )
  await queue.add("website-reverify-sweep", signJobPayload({}, 0), {
    repeat: { every: everyMs },
    jobId: "website-reverify-sweep",
    removeOnComplete: { count: 12 },
    removeOnFail: { count: 12 },
  })
  await queue.close()
  logger.info("registered website re-verify sweep", {
    intervalMs: everyMs,
    intervalHours: everyMs / 3600000,
  })
  return { name: "website-reverify-sweep", queue: QUEUES.WEBSITE_VERIFICATION }
}

async function registerDomainMetricsRefresh(): Promise<RegisteredJob> {
  const everyMs = 30 * 24 * 60 * 60 * 1000
  const queue = new Queue(QUEUES.DOMAIN_METRICS, { connection })
  await queue
    .removeRepeatable("domain-metrics-refresh", { every: everyMs })
    .catch(() => {})
  await queue.add(
    "domain-metrics-refresh",
    signJobPayload({ batchSize: 100 }, 0),
    {
      repeat: { every: everyMs },
      jobId: "domain-metrics-refresh",
      removeOnComplete: { count: 12 },
      removeOnFail: { count: 12 },
    },
  )
  await queue.close()
  logger.info("registered domain metrics refresh", { intervalMs: everyMs })
  return { name: "domain-metrics-refresh", queue: QUEUES.DOMAIN_METRICS }
}

// Settlement-hold link monitoring — re-check the live link for every order
// whose payout is still on hold. If removed, raises a fraud flag that blocks
// release. Default every 6h.
async function registerSettlementHoldLinkSweep(): Promise<RegisteredJob> {
  const everyMs =
    Math.max(Number(process.env.SETTLEMENT_LINK_SWEEP_HOURS ?? 6), 1) *
    60 *
    60 *
    1000
  const queue = new Queue(QUEUES.DELIVERY_VERIFICATION, { connection })
  await queue
    .removeRepeatable("settlement-hold-sweep", { every: everyMs })
    .catch(() => {})
  await queue.add("settlement-hold-sweep", signJobPayload({}, 0), {
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
  return { name: "settlement-hold-sweep", queue: QUEUES.DELIVERY_VERIFICATION }
}

// Phase 7.3 — settlement review window auto-approval. Replaces the per-API-pod
// setInterval; one worker, one cron, one sweep per cadence cluster-wide via
// BullMQ jobId dedup. Preserves the two existing env vars
// (SETTLEMENT_AUTO_APPROVE_INTERVAL_MS, SETTLEMENT_AUTO_APPROVE_DISABLED) so
// ops muscle memory keeps working. Adds SETTLEMENT_AUTO_APPROVE_BATCH_SIZE
// for tuning during backlog recovery.
async function registerSettlementAutoApproveSweep(): Promise<RegisteredJob> {
  if (process.env.SETTLEMENT_AUTO_APPROVE_DISABLED === "true") {
    logger.info(
      "settlement auto-approve disabled — skipping cron registration",
      {
        env: "SETTLEMENT_AUTO_APPROVE_DISABLED",
      },
    )
    // Still return the RegisteredJob for drift-checking purposes.
    // The job name is valid (processor exists); it's just not scheduled.
    return { name: "settlement-auto-approve", queue: QUEUES.SETTLEMENT }
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
  await queue
    .removeRepeatable("settlement-auto-approve", { every: everyMs })
    .catch(() => {})
  await queue.add("settlement-auto-approve", signJobPayload({ batchSize }, 0), {
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
  return { name: "settlement-auto-approve", queue: QUEUES.SETTLEMENT }
}

// Phase 6 — settlement auto-release sweep. Finds CUSTOMER_APPROVED
// settlements with releasePolicy=AUTO and releases them (balance update,
// order complete, transactions). Default every 15 min, tunable via env.
async function registerSettlementAutoReleaseSweep(): Promise<RegisteredJob> {
  // Auto-approve and auto-release used to share QUEUES.SETTLEMENT even though
  // they have separate workers. BullMQ distributes a queue's jobs across all
  // workers, so the wrong processor could claim and skip a sweep. Remove any
  // legacy repeatable release jobs from the shared queue before using the
  // dedicated release queue.
  await removeRepeatableJobsByName(QUEUES.SETTLEMENT, "settlement-auto-release")
  await removeRepeatableJobsByName(
    QUEUES.SETTLEMENT_RELEASE,
    "settlement-auto-release",
  )

  if (process.env.SETTLEMENT_AUTO_RELEASE_DISABLED === "true") {
    logger.info(
      "settlement auto-release disabled — skipping cron registration",
      { env: "SETTLEMENT_AUTO_RELEASE_DISABLED" },
    )
    return {
      name: "settlement-auto-release",
      queue: QUEUES.SETTLEMENT_RELEASE,
    }
  }
  const everyMs = Math.max(
    Number(process.env.SETTLEMENT_AUTO_RELEASE_INTERVAL_MS ?? 15 * 60 * 1000),
    60_000,
  )
  const batchSize = Math.min(
    Math.max(Number(process.env.SETTLEMENT_AUTO_RELEASE_BATCH_SIZE) || 100, 1),
    10_000,
  )
  const queue = new Queue(QUEUES.SETTLEMENT_RELEASE, { connection })
  await queue.add("settlement-auto-release", signJobPayload({ batchSize }, 0), {
    repeat: { every: everyMs },
    jobId: "settlement-auto-release",
    removeOnComplete: { count: 24 },
    removeOnFail: { count: 24 },
  })
  await queue.close()
  logger.info("registered settlement auto-release sweep", {
    intervalMs: everyMs,
    intervalMin: everyMs / 60000,
    batchSize,
  })
  return {
    name: "settlement-auto-release",
    queue: QUEUES.SETTLEMENT_RELEASE,
  }
}

async function removeRepeatableJobsByName(
  queueName: string,
  jobName: string,
): Promise<void> {
  const queue = new Queue(queueName, { connection })
  try {
    const jobs = await queue.getRepeatableJobs()
    await Promise.all(
      jobs
        .filter((job) => job.name === jobName)
        .map((job) => queue.removeRepeatableByKey(job.key)),
    )
  } finally {
    await queue.close()
  }
}

// Phase 1 — auto-accept sweep: processes orders past their review window.
async function registerAutoAcceptSweep(): Promise<RegisteredJob> {
  const everyMs =
    Math.max(Number(process.env.AUTO_ACCEPT_SWEEP_MINUTES ?? 60), 1) * 60 * 1000
  const queue = new Queue(QUEUES.AUTO_ACCEPT, { connection })
  await queue
    .removeRepeatable("auto-accept-sweep", { every: everyMs })
    .catch(() => {})
  await queue.add("auto-accept-sweep", signJobPayload({}, 0), {
    repeat: { every: everyMs },
    jobId: "auto-accept-sweep",
    removeOnComplete: { count: 24 },
    removeOnFail: { count: 24 },
  })
  await queue.close()
  logger.info("registered auto-accept sweep", {
    intervalMs: everyMs,
    intervalMin: everyMs / 60000,
  })
  return { name: "auto-accept-sweep", queue: QUEUES.AUTO_ACCEPT }
}

// Phase 1 — review reminder sweep: sends reminders for orders nearing
// auto-accept. Shares the same cadence as the auto-accept sweep.
async function registerReviewReminderSweep(): Promise<RegisteredJob> {
  const everyMs =
    Math.max(Number(process.env.AUTO_ACCEPT_SWEEP_MINUTES ?? 60), 1) * 60 * 1000
  const queue = new Queue(QUEUES.AUTO_ACCEPT, { connection })
  await queue
    .removeRepeatable("review-reminder-sweep", { every: everyMs })
    .catch(() => {})
  await queue.add("review-reminder-sweep", signJobPayload({}, 0), {
    repeat: { every: everyMs },
    jobId: "review-reminder-sweep",
    removeOnComplete: { count: 24 },
    removeOnFail: { count: 24 },
  })
  await queue.close()
  logger.info("registered review reminder sweep", {
    intervalMs: everyMs,
    intervalMin: everyMs / 60000,
  })
  return { name: "review-reminder-sweep", queue: QUEUES.AUTO_ACCEPT }
}

async function registerCancellationResponseTimeoutSweep(): Promise<RegisteredJob> {
  const { responseSweepMinutes } = resolveOrderCancellationConfig(process.env)
  const everyMs = responseSweepMinutes * 60 * 1000
  const jobName = QUEUE_JOBS[QUEUES.AUTO_ACCEPT].CANCELLATION_TIMEOUT_SWEEP
  const queue = new Queue(QUEUES.AUTO_ACCEPT, { connection })
  await queue.removeRepeatable(jobName, { every: everyMs }).catch(() => {})
  await queue.add(jobName, signJobPayload({}, 0), {
    repeat: { every: everyMs },
    jobId: jobName,
    removeOnComplete: { count: 24 },
    removeOnFail: { count: 24 },
  })
  await queue.close()
  return {
    name: jobName,
    queue: QUEUES.AUTO_ACCEPT,
  }
}

async function registerOrderAcceptanceTimeoutSweep(): Promise<RegisteredJob> {
  const { acceptanceSweepMinutes } = resolveOrderCancellationConfig(process.env)
  const everyMs = acceptanceSweepMinutes * 60 * 1000
  const jobName = QUEUE_JOBS[QUEUES.AUTO_ACCEPT].ACCEPTANCE_TIMEOUT_SWEEP
  const queue = new Queue(QUEUES.AUTO_ACCEPT, { connection })
  await queue.removeRepeatable(jobName, { every: everyMs }).catch(() => {})
  await queue.add(jobName, signJobPayload({}, 0), {
    repeat: { every: everyMs },
    jobId: jobName,
    removeOnComplete: { count: 24 },
    removeOnFail: { count: 24 },
  })
  await queue.close()
  return {
    name: jobName,
    queue: QUEUES.AUTO_ACCEPT,
  }
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

type WorkerFactory = () => { close: () => Promise<void> }
type WorkerMode = "all" | "realtime" | "on-demand" | "scheduled"

const REALTIME_WORKERS: WorkerFactory[] = [
  createEmailWorker,
  createNotificationWorker,
  createWebsiteVerificationWorker,
  createDeliveryVerificationWorker,
]

const ON_DEMAND_WORKERS: WorkerFactory[] = [
  createReportWorker,
  createVerificationWorker,
  createPayoutWorker, // drains pre-inbox rollout jobs only
  createPublisherTrustWorker,
  createDomainMetricsWorker,
]

async function createIntegrationWorkers(): Promise<
  Array<{ close: () => Promise<void> }>
> {
  // Importing the integrations worker package constructs its encryption
  // adapter. Keep that import inside the only lanes that process integration
  // queues so realtime and scheduled workloads do not need the integration
  // encryption key (or Google credentials) merely to boot.
  const { createDiscoveryWorker, createSyncWorker } = await import(
    "@guestpost/integrations/workers"
  )
  return [
    createDiscoveryWorker(connection as any) as {
      close: () => Promise<void>
    },
    createSyncWorker(connection as any) as { close: () => Promise<void> },
  ]
}

const ON_DEMAND_QUEUES = [
  QUEUES.REPORT,
  QUEUES.VERIFICATION,
  QUEUES.PAYOUT,
  QUEUES.PUBLISHER_TRUST,
  QUEUES.INTEGRATION_DISCOVERY,
  QUEUES.INTEGRATION_SYNC,
  QUEUES.DOMAIN_METRICS,
] as const

interface ScheduledTaskConfig {
  queue: string
  jobName: string
  data: Record<string, unknown>
  createWorker: WorkerFactory
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function getScheduledTask(name: string): ScheduledTaskConfig | undefined {
  const cancellation = resolveOrderCancellationConfig(process.env)
  const tasks: Record<string, ScheduledTaskConfig> = {
    "payout-reconcile": {
      queue: QUEUES.PAYOUT,
      jobName: QUEUE_JOBS[QUEUES.PAYOUT].CHECK_STATUS,
      data: { limit: positiveInt(process.env.PAYOUT_STATUS_BATCH_SIZE, 50) },
      createWorker: createPayoutWorker,
    },
    reconciliation: {
      queue: QUEUES.RECONCILIATION,
      jobName: QUEUE_JOBS[QUEUES.RECONCILIATION].RUN,
      data: {},
      createWorker: createReconciliationWorker,
    },
    "website-reverify": {
      queue: QUEUES.WEBSITE_VERIFICATION,
      jobName: QUEUE_JOBS[QUEUES.WEBSITE_VERIFICATION].REVERIFY_SWEEP,
      data: {},
      createWorker: createWebsiteVerificationWorker,
    },
    "domain-metrics-refresh": {
      queue: QUEUES.DOMAIN_METRICS,
      jobName: "domain-metrics-refresh",
      data: { batchSize: 100 },
      createWorker: createDomainMetricsWorker,
    },
    "settlement-link-check": {
      queue: QUEUES.DELIVERY_VERIFICATION,
      jobName: QUEUE_JOBS[QUEUES.DELIVERY_VERIFICATION].HOLD_LINK_SWEEP,
      data: {},
      createWorker: createDeliveryVerificationWorker,
    },
    "settlement-auto-approve": {
      queue: QUEUES.SETTLEMENT,
      jobName: QUEUE_JOBS[QUEUES.SETTLEMENT].AUTO_APPROVE,
      data: {
        batchSize: positiveInt(
          process.env.SETTLEMENT_AUTO_APPROVE_BATCH_SIZE,
          100,
        ),
      },
      createWorker: createSettlementAutoApproveWorker,
    },
    "settlement-auto-release": {
      queue: QUEUES.SETTLEMENT_RELEASE,
      jobName: QUEUE_JOBS[QUEUES.SETTLEMENT_RELEASE].AUTO_RELEASE,
      data: {
        batchSize: positiveInt(
          process.env.SETTLEMENT_AUTO_RELEASE_BATCH_SIZE,
          100,
        ),
      },
      createWorker: createSettlementReleaseWorker,
    },
    "auto-accept": {
      queue: QUEUES.AUTO_ACCEPT,
      jobName: QUEUE_JOBS[QUEUES.AUTO_ACCEPT].SWEEP,
      data: {},
      createWorker: createAutoAcceptWorker,
    },
    "review-reminders": {
      queue: QUEUES.AUTO_ACCEPT,
      jobName: QUEUE_JOBS[QUEUES.AUTO_ACCEPT].REMINDER_SWEEP,
      data: {},
      createWorker: createAutoAcceptWorker,
    },
    "cancellation-timeouts": {
      queue: QUEUES.AUTO_ACCEPT,
      jobName: QUEUE_JOBS[QUEUES.AUTO_ACCEPT].CANCELLATION_TIMEOUT_SWEEP,
      data: { responseSweepMinutes: cancellation.responseSweepMinutes },
      createWorker: createAutoAcceptWorker,
    },
    "acceptance-timeouts": {
      queue: QUEUES.AUTO_ACCEPT,
      jobName: QUEUE_JOBS[QUEUES.AUTO_ACCEPT].ACCEPTANCE_TIMEOUT_SWEEP,
      data: { acceptanceSweepMinutes: cancellation.acceptanceSweepMinutes },
      createWorker: createAutoAcceptWorker,
    },
  }
  return tasks[name]
}

function resolveWorkerMode(): WorkerMode {
  const value = (process.env.WORKER_MODE ?? "all").trim()
  if (
    value === "all" ||
    value === "realtime" ||
    value === "on-demand" ||
    value === "scheduled"
  ) {
    return value
  }
  throw new Error(
    `Invalid WORKER_MODE=${value}; expected all, realtime, on-demand, or scheduled`,
  )
}

async function removeHybridRepeatables(): Promise<void> {
  // Shared queues may gain unrelated repeatables later. Remove only the
  // schedules whose ownership moved to Northflank; deleting an entire queue's
  // repeatable registry could silently disable a future feature.
  const ownedSchedules: Array<{ queue: string; names: string[] }> = [
    {
      queue: QUEUES.PAYOUT,
      names: [QUEUE_JOBS[QUEUES.PAYOUT].CHECK_STATUS],
    },
    {
      queue: QUEUES.RECONCILIATION,
      names: [QUEUE_JOBS[QUEUES.RECONCILIATION].RUN],
    },
    {
      queue: QUEUES.WEBSITE_VERIFICATION,
      names: [QUEUE_JOBS[QUEUES.WEBSITE_VERIFICATION].REVERIFY_SWEEP],
    },
    {
      queue: QUEUES.DOMAIN_METRICS,
      names: ["domain-metrics-refresh"],
    },
    {
      queue: QUEUES.DELIVERY_VERIFICATION,
      names: [QUEUE_JOBS[QUEUES.DELIVERY_VERIFICATION].HOLD_LINK_SWEEP],
    },
    {
      queue: QUEUES.SETTLEMENT,
      // AUTO_RELEASE historically lived on this shared queue.
      names: [
        QUEUE_JOBS[QUEUES.SETTLEMENT].AUTO_APPROVE,
        "settlement-auto-release",
      ],
    },
    {
      queue: QUEUES.SETTLEMENT_RELEASE,
      names: [QUEUE_JOBS[QUEUES.SETTLEMENT_RELEASE].AUTO_RELEASE],
    },
    {
      queue: QUEUES.AUTO_ACCEPT,
      names: [
        QUEUE_JOBS[QUEUES.AUTO_ACCEPT].SWEEP,
        QUEUE_JOBS[QUEUES.AUTO_ACCEPT].REMINDER_SWEEP,
        QUEUE_JOBS[QUEUES.AUTO_ACCEPT].CANCELLATION_TIMEOUT_SWEEP,
        QUEUE_JOBS[QUEUES.AUTO_ACCEPT].ACCEPTANCE_TIMEOUT_SWEEP,
      ],
    },
  ]
  for (const owned of ownedSchedules) {
    const queue = new Queue(owned.queue, { connection })
    try {
      const repeatables = await queue.getRepeatableJobs()
      const names = new Set(owned.names)
      await Promise.all(
        repeatables
          .filter((job) => names.has(job.name))
          .map((job) => queue.removeRepeatableByKey(job.key)),
      )
    } finally {
      await queue.close()
    }
  }
  logger.info("owned legacy BullMQ repeatables removed for hybrid runtime")
}

async function runScheduledTask(taskName: string): Promise<void> {
  const task = getScheduledTask(taskName)
  if (!task) {
    throw new Error(`Unknown WORKER_TASK=${taskName}`)
  }

  if (taskName === "payout-reconcile") {
    const inbox = await processPayoutWebhookInbox(
      positiveInt(process.env.PAYOUT_WEBHOOK_INBOX_BATCH_SIZE, 100),
    )
    logger.info("payout webhook inbox drained", inbox)
  }

  const events = new QueueEvents(task.queue, { connection })
  await events.waitUntilReady()
  const worker = task.createWorker()
  const queue = new Queue(task.queue, { connection })
  try {
    const tenMinuteBucket = Math.floor(Date.now() / (10 * 60 * 1000))
    const job = await queue.add(task.jobName, signJobPayload(task.data), {
      jobId: `scheduled-${taskName}-${tenMinuteBucket}`,
      attempts: 1,
      // Retain through the bucket so an orchestrator retry/duplicate trigger
      // cannot execute the same scheduled mutation twice.
      removeOnComplete: { count: 20, age: 15 * 60 },
      removeOnFail: { count: 20, age: 604800 },
    })
    const timeoutMs = positiveInt(
      process.env.WORKER_SCHEDULED_TIMEOUT_MS,
      15 * 60 * 1000,
    )
    await job.waitUntilFinished(events, timeoutMs)
    logger.info("scheduled task completed", { taskName, jobId: job.id })
  } finally {
    await worker.close()
    await events.close()
    await queue.close()
  }
}

function isMaintenanceTaskDisabled(taskName: MaintenanceTaskName): boolean {
  if (taskName === "settlement-auto-approve") {
    return process.env.SETTLEMENT_AUTO_APPROVE_DISABLED === "true"
  }
  if (taskName === "settlement-auto-release") {
    return process.env.SETTLEMENT_AUTO_RELEASE_DISABLED === "true"
  }
  return false
}

async function runMaintenanceDispatch(now = new Date()): Promise<void> {
  const dueTasks = maintenanceTasksDueAt(now).filter(
    (taskName) => !isMaintenanceTaskDisabled(taskName),
  )
  logger.info("maintenance dispatch started", {
    scheduledAt: now.toISOString(),
    tasks: dueTasks,
  })

  const failures: Array<{ taskName: MaintenanceTaskName; error: Error }> = []
  for (const taskName of dueTasks) {
    try {
      await runScheduledTask(taskName)
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error))
      failures.push({ taskName, error: normalized })
      logger.error("maintenance task failed", {
        taskName,
        err: normalized.message,
      })
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `Maintenance dispatch failed: ${failures.map(({ taskName }) => taskName).join(", ")}`,
    )
  }

  logger.info("maintenance dispatch completed", { tasks: dueTasks })
}

async function drainOnDemandQueues(): Promise<void> {
  const queueHandles = ON_DEMAND_QUEUES.map(
    (name) => new Queue(name, { connection }),
  )
  const timeoutMs = positiveInt(
    process.env.WORKER_ON_DEMAND_MAX_RUNTIME_MS,
    10 * 60 * 1000,
  )
  const deadline = Date.now() + timeoutMs
  let quietChecks = 0
  try {
    while (Date.now() < deadline) {
      const inbox = await processPayoutWebhookInbox(
        positiveInt(process.env.PAYOUT_WEBHOOK_INBOX_BATCH_SIZE, 100),
      )
      const counts = await Promise.all(
        queueHandles.map((queue) =>
          queue.getJobCounts("waiting", "active", "prioritized"),
        ),
      )
      const queued = counts.reduce(
        (sum, count) =>
          sum +
          (count.waiting ?? 0) +
          (count.active ?? 0) +
          (count.prioritized ?? 0),
        0,
      )
      // A delayed retry is durable but not currently runnable. Waiting for it
      // here can hold all six consumers open for ten minutes and burn Redis
      // commands even when its backoff is hours long. The mandatory catch-up
      // run will claim it after its delay expires.
      const inboxPending = inbox.claimed - inbox.processed - inbox.ignored
      if (queued === 0 && inboxPending <= 0) quietChecks++
      else quietChecks = 0
      if (quietChecks >= 2) return
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    logger.warn("on-demand drain reached runtime limit; catch-up will resume", {
      timeoutMs,
    })
  } finally {
    await Promise.all(queueHandles.map((queue) => queue.close()))
  }
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
  const mode = resolveWorkerMode()
  logger.info("worker runtime selected", { mode })

  if (mode === "all") {
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
      createSettlementReleaseWorker(),
      createAutoAcceptWorker(),
      createDomainMetricsWorker(),
    )
    workers.push(...(await createIntegrationWorkers()))
    logger.info("legacy-compatible worker fleet started", {
      count: workers.length,
    })
    const registeredJobs = await Promise.all([
      registerPayoutStatusPoll(),
      registerReconciliationSweep(),
      registerWebsiteReverifySweep(),
      registerDomainMetricsRefresh(),
      registerSettlementHoldLinkSweep(),
      registerSettlementAutoApproveSweep(),
      registerSettlementAutoReleaseSweep(),
      registerAutoAcceptSweep(),
      registerReviewReminderSweep(),
      registerCancellationResponseTimeoutSweep(),
      registerOrderAcceptanceTimeoutSweep(),
    ])
    assertNoRegistryDrift(registeredJobs)
    return
  }

  if (mode === "realtime") {
    await removeHybridRepeatables()
    healthServer = await startHealthServer()
    workers.push(...REALTIME_WORKERS.map((createWorker) => createWorker()))
    logger.info("realtime worker lane started", {
      count: workers.length,
      queues: [
        QUEUES.EMAIL,
        QUEUES.NOTIFICATION,
        QUEUES.WEBSITE_VERIFICATION,
        QUEUES.DELIVERY_VERIFICATION,
      ],
    })
    return
  }

  if (mode === "on-demand") {
    workers.push(...ON_DEMAND_WORKERS.map((createWorker) => createWorker()))
    workers.push(...(await createIntegrationWorkers()))
    logger.info("on-demand worker lane started", {
      count: workers.length,
      queues: ON_DEMAND_QUEUES,
    })
    await drainOnDemandQueues()
    await shutdown("on-demand-complete")
    return
  }

  const taskName = process.env.WORKER_TASK?.trim()
  if (!taskName) {
    throw new Error("WORKER_TASK is required when WORKER_MODE=scheduled")
  }
  if (taskName === MAINTENANCE_DISPATCH_TASK) {
    await runMaintenanceDispatch()
    await shutdown(`scheduled-complete:${taskName}`)
    return
  }
  await runScheduledTask(taskName)
  await shutdown(`scheduled-complete:${taskName}`)
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
  const SHUTDOWN_TIMEOUT_MS = 30_000
  const drainTimeout = setTimeout(() => {
    logger.error("shutdown timeout reached — forcing exit", {
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
    })
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  await Promise.all(
    workers.map((w) =>
      w.close().catch((err) =>
        logger.error("worker close error", {
          err: err instanceof Error ? err.message : String(err),
        }),
      ),
    ),
  )
  try {
    await connection.quit()
  } catch (err) {
    logger.error("redis connection close error", {
      err: err instanceof Error ? err.message : String(err),
    })
  }
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
  clearTimeout(drainTimeout)
  logger.info("shutdown complete", { signal })
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
