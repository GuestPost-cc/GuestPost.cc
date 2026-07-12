import { createPrismaClient } from "@guestpost/database"
import { Queue } from "bullmq"
import { IntegrationEncryptionService } from "../adapters/encryption.adapter"
import {
  DiscoveryInProgressError,
  IntegrationNotFoundError,
  NoActiveCredentialError,
} from "../errors"
import { getProvider } from "../providers"
import type { DiscoveryResource, OwnerContext } from "../types"
import { QUEUES } from "../workers"

const db = createPrismaClient()
const encryption = new IntegrationEncryptionService()

function createDiscoveryQueue(): Queue {
  return new Queue(QUEUES.DISCOVERY, {
    connection: {
      host: process.env.REDIS_HOST ?? "localhost",
      port: Number(process.env.REDIS_PORT ?? 6379),
    },
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 50,
      removeOnFail: 20,
    },
  })
}

export interface DiscoveryJobPayload {
  integrationId: string
}

export class DiscoveryService {
  private readonly discoveryQueue: Queue

  constructor() {
    this.discoveryQueue = createDiscoveryQueue()
  }

  async enqueueDiscovery(
    owner: OwnerContext,
    integrationId: string,
  ): Promise<{ enqueued: boolean }> {
    const integration = await (db as any).publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
      include: { connection: true },
    })
    if (!integration) throw new IntegrationNotFoundError()
    if (!integration.connection) throw new NoActiveCredentialError()

    // Check for existing in-progress discovery
    const existingDiscovery = await (db as any).integrationDiscovery.findFirst({
      where: {
        integrationId,
        status: "PENDING",
      },
    })
    if (existingDiscovery) {
      throw new DiscoveryInProgressError()
    }

    // Create discovery record
    await (db as any).integrationDiscovery.create({
      data: {
        integrationId,
        status: "PENDING",
      },
    })

    // Enqueue BullMQ job
    await this.discoveryQueue.add("discover", {
      integrationId,
    } satisfies DiscoveryJobPayload)

    return { enqueued: true }
  }

  async processDiscoveryJob(payload: DiscoveryJobPayload): Promise<{
    success: boolean
    resources: DiscoveryResource[]
    error?: string
  }> {
    const { integrationId } = payload

    try {
      const integration = await (db as any).publisherIntegration.findFirst({
        where: { id: integrationId },
        include: { connection: true },
      })

      if (!integration?.connection) {
        return {
          success: false,
          resources: [],
          error: "Integration or connection not found",
        }
      }

      const accessToken = (
        encryption.decrypt(integration.connection.encryptedAccessToken) as {
          value: string
        }
      ).value

      const registration = getProvider(integration.provider)
      if (!registration?.discoveryProvider) {
        return {
          success: false,
          resources: [],
          error: `Provider ${integration.provider} does not support discovery`,
        }
      }

      const resources =
        await registration.discoveryProvider.discoverResources(accessToken)

      // Create WebsiteIntegration rows in a transaction
      let resourcesCreated = 0
      await (db as any).$transaction(async (tx: any) => {
        for (const resource of resources) {
          await tx.websiteIntegration.upsert({
            where: {
              integrationId_externalResourceId: {
                integrationId,
                externalResourceId: resource.externalResourceId,
              },
            },
            update: {
              externalResourceName: resource.externalResourceName,
              metadata: resource.metadata ?? undefined,
              status: "CONNECTED",
            },
            create: {
              integrationId,
              websiteId: "", // Will be linked later by the user
              externalResourceId: resource.externalResourceId,
              externalResourceName: resource.externalResourceName,
              metadata: resource.metadata ?? undefined,
              status: "CONNECTED",
            },
          })
          resourcesCreated++
        }
      })

      // Mark discovery as complete
      await (db as any).integrationDiscovery.updateMany({
        where: {
          integrationId,
          status: "PENDING",
        },
        data: {
          status: "COMPLETED",
          resourcesFound: resources.length,
          resourcesCreated,
          completedAt: new Date(),
        },
      })

      return { success: true, resources }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)

      await (db as any).integrationDiscovery
        .updateMany({
          where: {
            integrationId,
            status: "PENDING",
          },
          data: {
            status: "FAILED",
            errorMessage,
            completedAt: new Date(),
          },
        })
        .catch(() => {})

      return { success: false, resources: [], error: errorMessage }
    }
  }
}
