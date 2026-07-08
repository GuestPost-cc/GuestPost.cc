import { createPrismaClient, IntegrationStatus } from "@guestpost/database"
import { Redis } from "ioredis"
import { IntegrationEncryptionService } from "../adapters/encryption.adapter"
import { REDIS_KEYS } from "../constants"
import {
  DiscoveryInProgressError,
  IntegrationNotFoundError,
  NoActiveCredentialError,
} from "../errors"
import { getProvider } from "../providers"
import type { DiscoveredResource, OwnerContext } from "../types"
import { normalizePropertyUrl } from "../utils"

const db = createPrismaClient()
const encryption = new IntegrationEncryptionService()

export interface DiscoveryJobPayload {
  integrationId: string
}

export class DiscoveryService {
  constructor(private readonly redis: Redis) {}

  async enqueueDiscovery(
    owner: OwnerContext,
    integrationId: string,
  ): Promise<{ enqueued: boolean; message?: string }> {
    const lockKey = `${REDIS_KEYS.DISCOVERY_LOCK}${integrationId}`
    const lockAcquired = await this.redis.set(lockKey, "1", "EX", 300, "NX")
    if (!lockAcquired) {
      throw new DiscoveryInProgressError()
    }

    const integration = await db.publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
      include: { credentials: true },
    })
    if (!integration) throw new IntegrationNotFoundError()
    if (!integration.credentials) throw new NoActiveCredentialError()

    await db.publisherIntegration.update({
      where: { id: integrationId },
      data: { status: IntegrationStatus.DISCOVERING },
    })

    return { enqueued: true }
  }

  async processDiscoveryJob(payload: DiscoveryJobPayload): Promise<{
    success: boolean
    resources: DiscoveredResource[]
    error?: string
  }> {
    const { integrationId } = payload
    const lockKey = `${REDIS_KEYS.DISCOVERY_LOCK}${integrationId}`

    try {
      const integration = await db.publisherIntegration.findFirst({
        where: { id: integrationId },
        include: { credentials: true },
      })

      if (!integration?.credentials) {
        return {
          success: false,
          resources: [],
          error: "Integration or credentials not found",
        }
      }

      const accessToken = (
        encryption.decrypt(integration.credentials.encryptedAccessToken) as {
          value: string
        }
      ).value

      const providerImpl = getProvider(integration.provider)
      const resources = await providerImpl.discoverResources(accessToken)

      await db.publisherIntegration.update({
        where: { id: integrationId },
        data: {
          status: IntegrationStatus.ACTIVE,
          discoveredAt: new Date(),
          discoveredResources: resources.map((r) => ({
            ...r,
            normalizedUrl: normalizePropertyUrl(r.url),
          })),
        },
      })

      return { success: true, resources }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)

      await db.publisherIntegration
        .update({
          where: { id: integrationId },
          data: { status: IntegrationStatus.ERROR },
        })
        .catch(() => {})

      return { success: false, resources: [], error: errorMessage }
    } finally {
      await this.redis.del(lockKey).catch(() => {})
    }
  }

  async getCachedResources(
    owner: OwnerContext,
    integrationId: string,
  ): Promise<{
    resources: DiscoveredResource[]
    discoveredAt: string | null
    isStale: boolean
  }> {
    const integration = await db.publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
    })
    if (!integration) throw new IntegrationNotFoundError()

    const cached = integration.discoveredResources as Array<{
      externalId: string
      url: string
      permissionLevel: string
    }> | null

    const fifteenMinutes = 15 * 60 * 1000
    const isStale =
      !integration.discoveredAt ||
      Date.now() - integration.discoveredAt.getTime() > fifteenMinutes

    return {
      resources: cached ?? [],
      discoveredAt: integration.discoveredAt?.toISOString() ?? null,
      isStale,
    }
  }
}
