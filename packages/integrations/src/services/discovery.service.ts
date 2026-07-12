import { createPrismaClient } from "@guestpost/database"
import { Queue } from "bullmq"
import { IntegrationEncryptionService } from "../adapters/encryption.adapter"
import { DiscoveryInProgressError, IntegrationNotFoundError } from "../errors"
import { getProvider } from "../providers"
import type { OwnerContext } from "../types"
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
  externalAccountId: string
}

export class DiscoveryService {
  private readonly discoveryQueue: Queue

  constructor() {
    this.discoveryQueue = createDiscoveryQueue()
  }

  async enqueueDiscovery(
    owner: OwnerContext,
    externalAccountId: string,
  ): Promise<{ enqueued: boolean }> {
    const account = await (db as any).externalAccount.findFirst({
      where: {
        id: externalAccountId,
      },
    })
    if (!account) throw new IntegrationNotFoundError()

    return await this.rediscoverForAccount(account, owner)
  }

  async rediscover(
    owner: OwnerContext,
    externalAccountId: string,
  ): Promise<{ enqueued: boolean }> {
    const account = await (db as any).externalAccount.findFirst({
      where: {
        id: externalAccountId,
      },
    })
    if (!account) throw new IntegrationNotFoundError()

    // Enqueue discovery in the background — runs as a BullMQ job
    const jobId = `discover-${externalAccountId}`
    const existing = await this.discoveryQueue.getJob(jobId)
    if (
      existing &&
      ["active", "waiting", "delayed"].includes((existing as any).status ?? "")
    ) {
      throw new DiscoveryInProgressError()
    }

    await this.discoveryQueue.add(
      "discover",
      {
        externalAccountId,
      } satisfies DiscoveryJobPayload,
      {
        jobId,
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 5 },
      },
    )

    return { enqueued: true }
  }

  async processDiscoveryJob(payload: DiscoveryJobPayload): Promise<{
    success: boolean
    gsc?: { found: number; created: number }
    analytics?: { found: number; created: number }
    error?: string
  }> {
    const { externalAccountId } = payload

    try {
      const account = await (db as any).externalAccount.findUnique({
        where: { id: externalAccountId },
      })
      if (!account) {
        return { success: false, error: "ExternalAccount not found" }
      }

      const accessToken = (
        encryption.decrypt(account.encryptedAccessToken) as {
          value: string
        }
      ).value

      const grantedScopes = account.grantedScopes ?? []
      const results: Record<string, { found: number; created: number }> = {}

      // Determine which Google services have been granted access via scopes
      const serviceMap: Record<string, string> = {
        GOOGLE_SEARCH_CONSOLE:
          "https://www.googleapis.com/auth/webmasters.readonly",
        GOOGLE_ANALYTICS: "https://www.googleapis.com/auth/analytics.readonly",
      }

      for (const [provider, scope] of Object.entries(serviceMap)) {
        if (
          !grantedScopes.some(
            (s: string) => scope.startsWith(s.split(".")[0]) || s === scope,
          )
        ) {
          continue
        }

        const registration = getProvider(provider)
        if (!registration?.discoveryProvider) continue

        const resources =
          await registration.discoveryProvider.discoverResources(accessToken)

        if (resources.length > 0) {
          // Find or create PublisherIntegration for this provider + connection
          let integration = await (db as any).publisherIntegration.findFirst({
            where: {
              provider,
              connectionId: externalAccountId,
            },
          })

          let isNew = false
          if (!integration) {
            integration = await (db as any).publisherIntegration.create({
              data: {
                ownerType: account.ownerType ?? "PUBLISHER",
                ownerId: account.ownerId ?? "",
                provider,
                connectionId: externalAccountId,
                status: "ACTIVE",
              },
            })
            isNew = true
          }

          // Create IntegrationSchedule if new or missing
          const schedule = await (db as any).integrationSchedule.findUnique({
            where: { integrationId: integration.id },
          })
          if (!schedule) {
            await (db as any).integrationSchedule.create({
              data: {
                integrationId: integration.id,
                nextRunAt: new Date(),
              },
            })
          }

          // Upsert WebsiteIntegration rows in a transaction
          let created = 0
          await (db as any).$transaction(async (tx: any) => {
            const existingResources = await tx.websiteIntegration.findMany({
              where: { integrationId: integration.id },
              select: { externalResourceId: true },
            })
            const existingIds = new Set(
              existingResources.map((r: any) => r.externalResourceId as string),
            )
            const foundIds = new Set(resources.map((r) => r.externalResourceId))

            // Upsert found resources
            for (const resource of resources) {
              await tx.websiteIntegration.upsert({
                where: {
                  integrationId_externalResourceId: {
                    integrationId: integration.id,
                    externalResourceId: resource.externalResourceId,
                  },
                },
                update: {
                  externalResourceName: resource.externalResourceName,
                  metadata: resource.metadata ?? undefined,
                  status: "CONNECTED",
                },
                create: {
                  integrationId: integration.id,
                  websiteId: "",
                  externalResourceId: resource.externalResourceId,
                  externalResourceName: resource.externalResourceName,
                  metadata: resource.metadata ?? undefined,
                  status: "CONNECTED",
                },
              })
              if (!existingIds.has(resource.externalResourceId)) {
                created++
              }
            }

            // Mark resources that disappeared as INACCESSIBLE
            for (const existingId of Array.from(existingIds)) {
              if (!foundIds.has(existingId as string)) {
                await tx.websiteIntegration.updateMany({
                  where: {
                    integrationId: integration.id,
                    externalResourceId: existingId,
                  },
                  data: { status: "INACCESSIBLE" },
                })
              }
            }
          })

          results[provider] = {
            found: resources.length,
            created,
          }

          if (isNew) {
            // Enqueue an initial sync for newly created integrations
            const { SyncService } = await import("./sync.service")
            const syncService = new SyncService()
            await syncService
              .triggerSync(
                { ownerType: account.ownerType, ownerId: account.ownerId },
                integration.id,
                "SCHEDULED",
              )
              .catch(() => {})
          }
        }

        // Update lastDiscoveryAt on the ExternalAccount
        await (db as any).externalAccount.update({
          where: { id: externalAccountId },
          data: { lastDiscoveryAt: new Date() },
        })
      }

      return {
        success: true,
        gsc: results.GOOGLE_SEARCH_CONSOLE,
        analytics: results.GOOGLE_ANALYTICS,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      return { success: false, error: errorMessage }
    }
  }

  private async rediscoverForAccount(
    account: any,
    owner: OwnerContext,
  ): Promise<{ enqueued: boolean }> {
    const jobId = `discover-${account.id}`
    const existing = await this.discoveryQueue.getJob(jobId)
    if (
      existing &&
      ["active", "waiting", "delayed"].includes((existing as any).status ?? "")
    ) {
      throw new DiscoveryInProgressError()
    }

    await this.discoveryQueue.add(
      "discover",
      {
        externalAccountId: account.id,
      } satisfies DiscoveryJobPayload,
      {
        jobId,
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 5 },
      },
    )

    return { enqueued: true }
  }
}
