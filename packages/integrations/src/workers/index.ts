import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { Job, Worker } from "bullmq"
import { INTEGRATION_QUEUES } from "../queue-names"
import type { DiscoveryJobPayload } from "../services/discovery.service"
import { DiscoveryService } from "../services/discovery.service"
import type { SyncJobPayload } from "../services/sync.service"
import { SyncService } from "../services/sync.service"

const logger = {
  log: (msg: string) => console.log(`[IntegrationWorker] ${msg}`),
  error: (msg: string) => console.error(`[IntegrationWorker] ${msg}`),
  warn: (msg: string) => console.warn(`[IntegrationWorker] ${msg}`),
}

let syncWorker: Worker | null = null
let discoveryWorker: Worker | null = null

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const idleWorkerOptions = {
  drainDelay: positiveNumber(process.env.WORKER_DRAIN_DELAY_SECONDS, 300),
  stalledInterval: positiveNumber(
    process.env.WORKER_STALLED_INTERVAL_MS,
    300_000,
  ),
}

export { INTEGRATION_QUEUES as QUEUES } from "../queue-names"

export function createSyncWorker(connection: Record<string, unknown>) {
  if (syncWorker) return syncWorker

  const service = new SyncService()

  syncWorker = new Worker<SyncJobPayload>(
    INTEGRATION_QUEUES.SYNC,
    async (job: Job<SyncJobPayload>) => {
      if (!verifyJobPayload(job.data as unknown as Record<string, unknown>)) {
        throw new Error("Invalid integration sync job signature")
      }
      logger.log(
        `Processing sync job ${job.id} for integration ${job.data.integrationId}`,
      )
      const result = await service.processSyncJob(job.data)
      logger.log(
        `Sync job ${job.id} completed: ${result.success ? "success" : `failed (${result.error})`}`,
      )
      return result
    },
    {
      connection,
      concurrency: 3,
      limiter: {
        max: 10,
        duration: 3600 * 1000,
      },
      ...idleWorkerOptions,
    },
  )

  syncWorker.on("failed", (job, err) => {
    logger.error(`Sync job ${job?.id} failed: ${err.message}`)
  })

  syncWorker.on("completed", (job) => {
    logger.log(`Sync job ${job.id} completed`)
  })

  return syncWorker
}

export function createDiscoveryWorker(connection: Record<string, unknown>) {
  if (discoveryWorker) return discoveryWorker

  const service = new DiscoveryService()

  discoveryWorker = new Worker<DiscoveryJobPayload>(
    INTEGRATION_QUEUES.DISCOVERY,
    async (job: Job<DiscoveryJobPayload>) => {
      if (!verifyJobPayload(job.data as unknown as Record<string, unknown>)) {
        throw new Error("Invalid integration discovery job signature")
      }
      logger.log(
        `Processing discovery job ${job.id} for account ${job.data.externalAccountId}`,
      )
      const result = await service.processDiscoveryJob(job.data)
      logger.log(
        `Discovery job ${job.id} completed: ${result.success ? "success" : `failed (${result.error})`}`,
      )
      return result
    },
    {
      connection,
      concurrency: 1,
      ...idleWorkerOptions,
    },
  )

  discoveryWorker.on("failed", (job, err) => {
    logger.error(`Discovery job ${job?.id} failed: ${err.message}`)
  })

  discoveryWorker.on("completed", (job) => {
    logger.log(`Discovery job ${job.id} completed`)
  })

  return discoveryWorker
}

export async function closeAllWorkers() {
  await Promise.all([syncWorker?.close(), discoveryWorker?.close()])
  syncWorker = null
  discoveryWorker = null
}
