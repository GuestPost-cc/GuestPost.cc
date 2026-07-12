import { Job, Worker } from "bullmq"
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

export const QUEUES = {
  SYNC: "integration-sync",
  DISCOVERY: "integration-discovery",
} as const

export function createSyncWorker(connection: Record<string, unknown>) {
  if (syncWorker) return syncWorker

  const service = new SyncService()

  syncWorker = new Worker<SyncJobPayload>(
    QUEUES.SYNC,
    async (job: Job<SyncJobPayload>) => {
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
    QUEUES.DISCOVERY,
    async (job: Job<DiscoveryJobPayload>) => {
      logger.log(
        `Processing discovery job ${job.id} for integration ${job.data.integrationId}`,
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
