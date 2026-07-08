import { Job, Worker } from "bullmq"
import Redis from "ioredis"
import {
  type DiscoveryJobPayload,
  DiscoveryService,
} from "../services/discovery.service"
import { type SyncJobPayload, SyncService } from "../services/sync.service"

const logger = {
  log: (msg: string) => console.log(`[IntegrationWorker] ${msg}`),
  error: (msg: string) => console.error(`[IntegrationWorker] ${msg}`),
  warn: (msg: string) => console.warn(`[IntegrationWorker] ${msg}`),
}

let syncWorker: Worker | null = null
let healthWorker: Worker | null = null
let refreshWorker: Worker | null = null
let discoveryWorker: Worker | null = null

export const QUEUES = {
  SYNC: "integration-sync",
  HEALTH: "integration-health",
  REFRESH: "integration-refresh",
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

  const redis = new Redis(connection as any)
  const service = new DiscoveryService(redis)

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

export function createHealthWorker(connection: Record<string, unknown>) {
  if (healthWorker) return healthWorker

  healthWorker = new Worker(
    QUEUES.HEALTH,
    async (job: Job<{ integrationId: string }>) => {
      logger.log(
        `Health check job ${job.id} for integration ${job.data.integrationId}`,
      )
      return {
        integrationId: job.data.integrationId,
        checkedAt: new Date().toISOString(),
      }
    },
    { connection, concurrency: 5 },
  )

  healthWorker.on("failed", (job, err) => {
    logger.error(`Health job ${job?.id} failed: ${err.message}`)
  })

  return healthWorker
}

export function createRefreshWorker(connection: Record<string, unknown>) {
  if (refreshWorker) return refreshWorker

  refreshWorker = new Worker(
    QUEUES.REFRESH,
    async (job: Job<{ integrationId: string }>) => {
      logger.log(
        `Token refresh job ${job.id} for integration ${job.data.integrationId}`,
      )
      return {
        integrationId: job.data.integrationId,
        refreshedAt: new Date().toISOString(),
      }
    },
    { connection, concurrency: 2 },
  )

  refreshWorker.on("failed", (job, err) => {
    logger.error(`Refresh job ${job?.id} failed: ${err.message}`)
  })

  return refreshWorker
}

export async function closeAllWorkers() {
  await Promise.all([
    syncWorker?.close(),
    healthWorker?.close(),
    refreshWorker?.close(),
    discoveryWorker?.close(),
  ])
  syncWorker = null
  healthWorker = null
  refreshWorker = null
  discoveryWorker = null
}
