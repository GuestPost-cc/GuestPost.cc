// Phase 7.0 — Worker health endpoint.
//
// Raw node:http (no Express dep) for minimum runtime overhead. Three routes:
//
//   GET /health
//     200 { status: "ok" } — process alive. Maps to K8s liveness probe.
//
//   GET /ready
//     200 if Redis PING + Prisma SELECT 1 both succeed.
//     503 with per-check breakdown otherwise. Maps to K8s readiness probe.
//
//   GET /metrics/queues
//     Per-queue counts via BullMQ Queue.getJobCounts() + a totals aggregate.
//     Useful for dashboards and ops triage. Not the basis for any alerting —
//     Sentry's failed-event hook is the source of truth for "something went wrong".
//
// Port defaults to 3004 (only free port in 3000–4000). Override via WORKER_HEALTH_PORT.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import { prisma } from "@guestpost/database"
import { getDedupHitsTotal, QUEUES } from "@guestpost/shared"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { Queue } from "bullmq"
import { connection } from "../redis"
import { getStalledHitsTotal } from "./queue-observability"

const logger = createLogger("worker.health-server")

// Phase 7.7 D — service block exposed on /metrics/queues. Captured at module
// init so uptime can be computed on every request without per-request work.
const SERVICE_NAME = "guestpost-worker"
const SERVICE_VERSION = process.env.npm_package_version ?? "unknown"
const STARTED_AT = new Date()
const PROCESS_PID = process.pid

interface ReadinessCheck {
  status: "ok" | "error"
  message?: string
}

interface ReadinessResponse {
  ready: boolean
  redis: ReadinessCheck
  database: ReadinessCheck
}

async function checkRedis(): Promise<ReadinessCheck> {
  try {
    const result = await connection.ping()
    if (result !== "PONG")
      return { status: "error", message: `unexpected PING response: ${result}` }
    return { status: "ok" }
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

async function checkDatabase(): Promise<ReadinessCheck> {
  try {
    await prisma.$queryRaw`SELECT 1`
    return { status: "ok" }
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

async function buildReadiness(): Promise<ReadinessResponse> {
  const [redis, database] = await Promise.all([checkRedis(), checkDatabase()])
  return {
    ready: redis.status === "ok" && database.status === "ok",
    redis,
    database,
  }
}

interface QueueCounts {
  waiting: number
  active: number
  delayed: number
  completed: number
  failed: number
  paused: number
}

async function getQueueCounts(
  queueName: string,
): Promise<QueueCounts | { error: string }> {
  const queue = new Queue(queueName, { connection })
  try {
    const counts = await queue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "completed",
      "failed",
      "paused",
    )
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      paused: counts.paused ?? 0,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    await queue.close().catch(() => {
      /* close failure is non-fatal — best-effort cleanup */
    })
  }
}

async function buildQueueMetrics() {
  const queueNames =
    process.env.WORKER_MODE === "realtime"
      ? [
          QUEUES.EMAIL,
          QUEUES.NOTIFICATION,
          QUEUES.WEBSITE_VERIFICATION,
          QUEUES.DELIVERY_VERIFICATION,
        ]
      : Object.values(QUEUES)
  const entries = await Promise.all(
    queueNames.map(async (name) => [name, await getQueueCounts(name)] as const),
  )
  const queues: Record<string, QueueCounts | { error: string }> = {}
  const totals: QueueCounts = {
    waiting: 0,
    active: 0,
    delayed: 0,
    completed: 0,
    failed: 0,
    paused: 0,
  }
  for (const [name, counts] of entries) {
    queues[name] = counts
    if (!("error" in counts)) {
      totals.waiting += counts.waiting
      totals.active += counts.active
      totals.delayed += counts.delayed
      totals.completed += counts.completed
      totals.failed += counts.failed
      totals.paused += counts.paused
    }
  }
  // Phase 7.7 D — extended payload: cumulative counters + service block.
  const uptimeMs = Date.now() - STARTED_AT.getTime()
  return {
    service: {
      name: SERVICE_NAME,
      version: SERVICE_VERSION,
      pid: PROCESS_PID,
      started_at: STARTED_AT.toISOString(),
      uptime_s: Math.floor(uptimeMs / 1000),
    },
    queues,
    totals,
    dedupHitsTotal: getDedupHitsTotal(),
    stalledHitsTotal: getStalledHitsTotal(),
  }
}

const METRICS_CACHE_MS = Math.max(
  Number(process.env.QUEUE_METRICS_CACHE_MS) || 30 * 60_000,
  10_000,
)
let queueMetricsCache:
  | { expiresAt: number; value: Awaited<ReturnType<typeof buildQueueMetrics>> }
  | undefined
let queueMetricsInFlight: ReturnType<typeof buildQueueMetrics> | undefined

async function getCachedQueueMetrics() {
  if (queueMetricsCache && queueMetricsCache.expiresAt > Date.now()) {
    return queueMetricsCache.value
  }
  if (queueMetricsInFlight) return queueMetricsInFlight
  queueMetricsInFlight = buildQueueMetrics()
  try {
    const value = await queueMetricsInFlight
    queueMetricsCache = { expiresAt: Date.now() + METRICS_CACHE_MS, value }
    return value
  } finally {
    queueMetricsInFlight = undefined
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  })
  res.end(payload)
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "GET") {
    writeJson(res, 405, { error: "method not allowed" })
    return
  }
  // Strip query string for matching; we don't accept any params today.
  const url = (req.url ?? "/").split("?")[0]
  switch (url) {
    case "/health":
      writeJson(res, 200, { status: "ok" })
      return
    case "/ready": {
      const readiness = await buildReadiness()
      writeJson(res, readiness.ready ? 200 : 503, readiness)
      return
    }
    case "/metrics/queues": {
      try {
        const metrics = await getCachedQueueMetrics()
        writeJson(res, 200, metrics)
      } catch (err) {
        writeJson(res, 500, {
          error: "failed to collect queue metrics",
          message: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    default:
      writeJson(res, 404, { error: "not found", path: url })
  }
}

export interface HealthServerHandle {
  close: () => Promise<void>
  port: number
}

export async function startHealthServer(): Promise<HealthServerHandle> {
  const port = Number(process.env.WORKER_HEALTH_PORT) || 3004
  const server: Server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error("health handler crashed", {
        err: err instanceof Error ? err.message : String(err),
      })
      if (!res.headersSent) {
        writeJson(res, 500, { error: "internal server error" })
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening)
      reject(err)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port)
  })
  logger.info("worker health server listening", {
    port,
    routes: ["/health", "/ready", "/metrics/queues"],
  })
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
