import { createPrismaClient } from "@guestpost/database"
import { Queue } from "bullmq"
import { IntegrationEncryptionService } from "../adapters/encryption.adapter"
import {
  IntegrationNotFoundError,
  NoActiveCredentialError,
  SyncNotFoundError,
} from "../errors"
import { getProvider } from "../providers"
import { createIntegrationQueueConnection } from "../redis"
import type { OwnerContext, SyncResult } from "../types"
import { IntegrationSyncJobType } from "../types"
import { QUEUES } from "../workers"

const db = createPrismaClient()
const encryption = new IntegrationEncryptionService()

function createSyncQueue(): Queue {
  return new Queue(QUEUES.SYNC, {
    connection: createIntegrationQueueConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  })
}

export interface SyncJobPayload {
  integrationId: string
  websiteIntegrationId?: string
  trigger?: string
  startDate?: string
  endDate?: string
  jobType?: IntegrationSyncJobType
}

export class SyncService {
  private readonly syncQueue: Queue

  constructor() {
    this.syncQueue = createSyncQueue()
  }

  async triggerSync(
    owner: OwnerContext,
    integrationId: string,
    trigger: string = "MANUAL",
    websiteIntegrationId?: string,
  ): Promise<{ syncId: string; websiteIntegrationIds: string[] }> {
    const integration = await (db as any).publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
      include: { websiteIntegrations: true },
    })
    if (!integration) throw new IntegrationNotFoundError()

    const websiteIntegrations = websiteIntegrationId
      ? integration.websiteIntegrations.filter(
          (w: any) => w.id === websiteIntegrationId,
        )
      : integration.websiteIntegrations

    if (websiteIntegrations.length === 0) {
      throw new SyncNotFoundError()
    }

    // Create IntegrationSync record
    const sync = await (db as any).integrationSync.create({
      data: {
        integrationId,
        websiteIntegrationId: websiteIntegrationId ?? null,
        jobType: IntegrationSyncJobType.SYNC,
        trigger,
        status: "PENDING",
        itemsTotal: websiteIntegrations.length,
        recordsExpected: 0,
        itemsCompleted: 0,
      },
    })

    // Enqueue BullMQ job
    await this.syncQueue.add("sync", {
      integrationId,
      websiteIntegrationId: websiteIntegrationId ?? undefined,
      trigger,
    } satisfies SyncJobPayload)

    return {
      syncId: sync.id,
      websiteIntegrationIds: websiteIntegrations.map((w: any) => w.id),
    }
  }

  async processSyncJob(payload: SyncJobPayload): Promise<SyncResult> {
    const startMs = Date.now()
    const { integrationId, websiteIntegrationId } = payload
    const progress = { itemsCompleted: 0, itemsTotal: 0, recordsProcessed: 0 }

    try {
      // Find the sync record by integrationId and PENDING status
      const syncRecord = await (db as any).integrationSync.findFirst({
        where: {
          integrationId,
          status: "PENDING",
        },
        orderBy: { startedAt: "desc" },
      })

      if (syncRecord) {
        await (db as any).integrationSync.update({
          where: { id: syncRecord.id },
          data: { status: "PROCESSING" },
        })
      }

      // Find the integration with its connection
      const integration = await (db as any).publisherIntegration.findFirst({
        where: { id: integrationId },
        include: {
          connection: true,
          websiteIntegrations: websiteIntegrationId
            ? { where: { id: websiteIntegrationId } }
            : { take: 1 },
        },
      })

      if (!integration?.connection) {
        throw new NoActiveCredentialError()
      }

      // Decrypt access token
      const accessToken = (
        encryption.decrypt(integration.connection.encryptedAccessToken) as {
          value: string
        }
      ).value

      const registration = getProvider(integration.provider)
      if (!registration?.syncProvider) {
        throw new NoActiveCredentialError()
      }

      progress.itemsTotal = integration.websiteIntegrations.length

      for (let i = 0; i < integration.websiteIntegrations.length; i++) {
        const wi = integration.websiteIntegrations[i]

        // Call sync provider with the external resource ID
        const result = await registration.syncProvider.sync(
          accessToken,
          wi.externalResourceId,
          payload.startDate ? new Date(payload.startDate) : undefined,
          payload.endDate ? new Date(payload.endDate) : undefined,
        )
        progress.recordsProcessed += result.recordsProcessed

        // Update WebsiteIntegration
        await (db as any).websiteIntegration
          .update({
            where: { id: wi.id },
            data: {
              syncedAt: result.syncedAt,
              status: result.success ? "CONNECTED" : "OUT_OF_SYNC",
            },
          })
          .catch(() => {})

        progress.itemsCompleted = i + 1
      }

      // Mark sync record as completed
      if (syncRecord) {
        await (db as any).integrationSync
          .update({
            where: { id: syncRecord.id },
            data: {
              status: "COMPLETED",
              recordsProcessed: progress.recordsProcessed,
              completedAt: new Date(),
            },
          })
          .catch(() => {})
      }

      // Update schedule
      await (db as any).integrationSchedule
        .updateMany({
          where: { integrationId },
          data: { lastRunAt: new Date(), lastSuccessAt: new Date() },
        })
        .catch(() => {})

      return {
        success: true,
        recordsProcessed: progress.recordsProcessed,
        syncedAt: new Date(),
        durationMs: Date.now() - startMs,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)

      // Mark sync record as failed
      const syncRecord = await (db as any).integrationSync.findFirst({
        where: { integrationId, status: "PROCESSING" },
        orderBy: { startedAt: "desc" },
      })
      if (syncRecord) {
        await (db as any).integrationSync
          .update({
            where: { id: syncRecord.id },
            data: {
              status: "FAILED",
              errorMessage,
              completedAt: new Date(),
            },
          })
          .catch(() => {})
      }

      return {
        success: false,
        recordsProcessed: progress.recordsProcessed,
        syncedAt: new Date(),
        error: errorMessage,
        durationMs: Date.now() - startMs,
      }
    }
  }

  async getSyncHistory(
    owner: OwnerContext,
    integrationId: string,
    page = 1,
    pageSize = 20,
    filters?: {
      status?: string
      trigger?: string
      dateFrom?: string
      dateTo?: string
    },
  ) {
    const integration = await (db as any).publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
    })
    if (!integration) throw new IntegrationNotFoundError()

    const where: Record<string, unknown> = { integrationId }
    if (filters?.status) where.status = filters.status
    if (filters?.trigger) where.trigger = filters.trigger
    if (filters?.dateFrom || filters?.dateTo) {
      where.startedAt = {
        ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
        ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
      }
    }

    const [items, total] = await Promise.all([
      (db as any).integrationSync.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { startedAt: "desc" },
      }),
      (db as any).integrationSync.count({ where }),
    ])

    return {
      data: items.map((s: any) => ({
        id: s.id,
        integrationId: s.integrationId,
        websiteIntegrationId: s.websiteIntegrationId,
        jobType: s.jobType,
        status: s.status,
        trigger: s.trigger,
        recordsProcessed: s.recordsProcessed,
        progress: {
          completed: s.itemsCompleted,
          total: s.itemsTotal,
        },
        errorMessage: s.errorMessage,
        startedAt: s.startedAt.toISOString(),
        completedAt: s.completedAt?.toISOString() ?? null,
      })),
      pagination: {
        page,
        pageSize,
        total,
        hasNext: page * pageSize < total,
      },
    }
  }

  async getSyncStatus(syncId: string) {
    const sync = await (db as any).integrationSync.findUnique({
      where: { id: syncId },
    })
    if (!sync) throw new SyncNotFoundError()
    return {
      id: sync.id,
      integrationId: sync.integrationId,
      websiteIntegrationId: sync.websiteIntegrationId,
      jobType: sync.jobType,
      status: sync.status,
      trigger: sync.trigger,
      recordsProcessed: sync.recordsProcessed,
      progress: {
        completed: sync.itemsCompleted,
        total: sync.itemsTotal,
      },
      errorMessage: sync.errorMessage,
      startedAt: sync.startedAt.toISOString(),
      completedAt: sync.completedAt?.toISOString() ?? null,
    }
  }
}
