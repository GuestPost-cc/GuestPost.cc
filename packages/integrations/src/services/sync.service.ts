import {
  createPrismaClient,
  IntegrationStatus,
  IntegrationSyncStatus,
  IntegrationSyncTrigger,
} from "@guestpost/database"
import { Redis } from "ioredis"
import { IntegrationEncryptionService } from "../adapters/encryption.adapter"
import { REDIS_KEYS } from "../constants"
import {
  IntegrationNotFoundError,
  NoActiveCredentialError,
  SyncAlreadyRunningError,
  SyncNotFoundError,
} from "../errors"
import { getProvider } from "../providers"
import type { OwnerContext, SyncResult } from "../types"
import { WebsiteIntegrationStatus } from "../types"

const db = createPrismaClient()
const encryption = new IntegrationEncryptionService()

export interface SyncJobPayload {
  integrationId: string
  websiteIntegrationId?: string
  trigger?: IntegrationSyncTrigger
  startDate?: string
  endDate?: string
  propertyUrl?: string
}

export class SyncService {
  constructor(private readonly redis?: Redis) {}

  async triggerSync(
    owner: OwnerContext,
    integrationId: string,
    trigger: IntegrationSyncTrigger = IntegrationSyncTrigger.MANUAL,
    propertyUrl?: string,
  ): Promise<{ syncId: string; websiteIntegrationIds: string[] }> {
    const integration = await db.publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
      include: { websiteIntegrations: true },
    })
    if (!integration) throw new IntegrationNotFoundError()

    const websiteIntegrations = propertyUrl
      ? integration.websiteIntegrations.filter(
          (w) => w.propertyUrl === propertyUrl,
        )
      : integration.websiteIntegrations

    if (websiteIntegrations.length === 0) {
      throw new SyncNotFoundError()
    }

    const locks: string[] = []
    for (const wi of websiteIntegrations) {
      const lockKey = `${REDIS_KEYS.INTEGRATION_LOCK}website:${wi.id}`
      const acquired = await this.redis?.set(lockKey, "1", "EX", 3600, "NX")
      if (!acquired) {
        for (const l of locks) {
          await this.redis?.del(l).catch(() => {})
        }
        throw new SyncAlreadyRunningError()
      }
      locks.push(lockKey)
    }

    const sync = await db.integrationSync.create({
      data: {
        integrationId,
        trigger,
        status: IntegrationSyncStatus.PENDING,
        itemsTotal: websiteIntegrations.length,
        recordsExpected: 0,
        itemsCompleted: 0,
      },
    })

    return {
      syncId: sync.id,
      websiteIntegrationIds: websiteIntegrations.map((w) => w.id),
    }
  }

  async processSyncJob(payload: SyncJobPayload): Promise<SyncResult> {
    const startMs = Date.now()
    const { integrationId, propertyUrl, websiteIntegrationId } = payload

    const progress = { itemsCompleted: 0, itemsTotal: 0, recordsProcessed: 0 }

    try {
      await db.integrationSync
        .update({
          where: { id: integrationId },
          data: { status: IntegrationSyncStatus.PROCESSING },
        })
        .catch(() => {})

      const integration = await db.publisherIntegration.findFirst({
        where: { id: integrationId },
        include: {
          credentials: true,
          websiteIntegrations: propertyUrl
            ? { where: { propertyUrl } }
            : websiteIntegrationId
              ? { where: { id: websiteIntegrationId } }
              : { take: 1 },
        },
      })

      if (!integration?.credentials) {
        throw new NoActiveCredentialError()
      }

      const accessToken = (
        encryption.decrypt(integration.credentials.encryptedAccessToken) as {
          value: string
        }
      ).value
      const providerImpl = getProvider(integration.provider)

      progress.itemsTotal = integration.websiteIntegrations.length

      for (let i = 0; i < integration.websiteIntegrations.length; i++) {
        const wi = integration.websiteIntegrations[i]
        const lockKey = `${REDIS_KEYS.INTEGRATION_LOCK}website:${wi.id}`

        const result = await providerImpl.triggerSync(
          accessToken,
          wi.propertyUrl,
          payload.startDate ? new Date(payload.startDate) : undefined,
          payload.endDate ? new Date(payload.endDate) : undefined,
        )
        progress.recordsProcessed += result.recordsProcessed

        await db.websiteIntegration
          .update({
            where: { id: wi.id },
            data: {
              syncedAt: result.syncedAt,
              status: result.success
                ? WebsiteIntegrationStatus.CONNECTED
                : WebsiteIntegrationStatus.OUT_OF_SYNC,
            },
          })
          .catch(() => {})

        progress.itemsCompleted = i + 1
        await db.integrationSync
          .update({
            where: { id: integrationId },
            data: {
              itemsCompleted: progress.itemsCompleted,
              recordsProcessed: progress.recordsProcessed,
            },
          })
          .catch(() => {})

        await this.redis?.del(lockKey).catch(() => {})
      }

      await db.publisherIntegration
        .update({
          where: { id: integrationId },
          data: { lastSyncAt: new Date() },
        })
        .catch(() => {})

      const syncRecord = await db.integrationSync.findFirst({
        where: { integrationId, status: IntegrationSyncStatus.PROCESSING },
        orderBy: { startedAt: "desc" },
      })
      if (syncRecord) {
        await db.integrationSync
          .update({
            where: { id: syncRecord.id },
            data: {
              status: IntegrationSyncStatus.COMPLETED,
              recordsProcessed: progress.recordsProcessed,
              completedAt: new Date(),
            },
          })
          .catch(() => {})
      }

      return {
        success: true,
        recordsProcessed: progress.recordsProcessed,
        syncedAt: new Date(),
        durationMs: Date.now() - startMs,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      const syncRecord = await db.integrationSync.findFirst({
        where: { integrationId, status: IntegrationSyncStatus.PROCESSING },
        orderBy: { startedAt: "desc" },
      })
      if (syncRecord) {
        await db.integrationSync
          .update({
            where: { id: syncRecord.id },
            data: {
              status: IntegrationSyncStatus.FAILED,
              errorMessage,
              completedAt: new Date(),
            },
          })
          .catch(() => {})
      }

      await db.publisherIntegration
        .update({
          where: { id: integrationId },
          data: { status: IntegrationStatus.ERROR },
        })
        .catch(() => {})

      for (const wi of (
        await db.publisherIntegration.findFirst({
          where: { id: integrationId },
          include: {
            websiteIntegrations: propertyUrl
              ? { where: { propertyUrl } }
              : undefined,
          },
        })
      )?.websiteIntegrations ?? []) {
        const lockKey = `${REDIS_KEYS.INTEGRATION_LOCK}website:${wi.id}`
        await this.redis?.del(lockKey).catch(() => {})
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
    const integration = await db.publisherIntegration.findFirst({
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
      db.integrationSync.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { startedAt: "desc" },
      }),
      db.integrationSync.count({ where }),
    ])

    return {
      data: items.map((s) => ({
        id: s.id,
        integrationId: s.integrationId,
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
    const sync = await db.integrationSync.findUnique({ where: { id: syncId } })
    if (!sync) throw new SyncNotFoundError()
    return {
      id: sync.id,
      integrationId: sync.integrationId,
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
