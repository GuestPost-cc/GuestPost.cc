import { createPrismaClient } from "@guestpost/database"
import { signJobPayload } from "@guestpost/shared/dist/job-signing"
import { Queue } from "bullmq"
import { IntegrationEncryptionService } from "../adapters/encryption.adapter"
import { DiscoveryInProgressError, IntegrationNotFoundError } from "../errors"
import { getProvider } from "../providers"
import { INTEGRATION_QUEUES } from "../queue-names"
import { createIntegrationQueueConnection } from "../redis"
import type { OwnerContext } from "../types"
import { wakeOnDemandWorker } from "../worker-wakeup"

const db = createPrismaClient()
const encryption = new IntegrationEncryptionService()

function createDiscoveryQueue(): Queue {
  return new Queue(INTEGRATION_QUEUES.DISCOVERY, {
    connection: createIntegrationQueueConnection(),
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
  ownerType: string
  ownerId: string
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
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
    })
    if (!account) throw new IntegrationNotFoundError()

    return await this.enqueueJob(account.id, owner)
  }

  async rediscover(
    owner: OwnerContext,
    externalAccountId: string,
  ): Promise<{ enqueued: boolean }> {
    const account = await (db as any).externalAccount.findFirst({
      where: {
        id: externalAccountId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
    })
    if (!account) throw new IntegrationNotFoundError()

    return await this.enqueueJob(account.id, owner)
  }

  private async enqueueJob(
    externalAccountId: string,
    owner: OwnerContext,
  ): Promise<{ enqueued: boolean }> {
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
      signJobPayload({
        externalAccountId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      } satisfies DiscoveryJobPayload),
      {
        jobId,
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 5 },
      },
    )
    wakeOnDemandWorker()

    return { enqueued: true }
  }

  async processDiscoveryJob(payload: DiscoveryJobPayload): Promise<{
    success: boolean
    gsc?: { found: number; created: number }
    analytics?: { found: number; created: number }
    error?: string
  }> {
    const { externalAccountId, ownerType, ownerId } = payload

    try {
      const account = await (db as any).externalAccount.findUnique({
        where: { id: externalAccountId },
      })
      if (
        !account ||
        account.ownerType !== ownerType ||
        account.ownerId !== ownerId
      ) {
        return { success: false, error: "ExternalAccount not found" }
      }

      const accessToken = (
        encryption.decrypt(account.encryptedAccessToken) as {
          value: string
        }
      ).value

      const grantedScopes: string[] = account.grantedScopes ?? []
      const results: Record<string, { found: number; created: number }> = {}

      // The scope strings used to check which services the user granted
      const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
      const GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly"

      const serviceMap: Array<{ provider: string; scope: string }> = [
        { provider: "GOOGLE_SEARCH_CONSOLE", scope: GSC_SCOPE },
        { provider: "GOOGLE_ANALYTICS", scope: GA_SCOPE },
      ]

      for (const { provider, scope } of serviceMap) {
        // Check if the user granted this specific scope
        if (!grantedScopes.includes(scope)) {
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
                ownerType,
                ownerId,
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

          // WebsiteIntegration represents an explicit website-to-property
          // link. Discovery must never create placeholder rows with a blank
          // websiteId (that violates the FK and was the reason discovery did
          // not complete). Refresh only links the owner already confirmed;
          // unlinked resources are returned live by GET /resources.
          let refreshed = 0
          const foundById = new Map(
            resources.map((resource) => [
              resource.externalResourceId,
              resource,
            ]),
          )
          const linked = await (db as any).websiteIntegration.findMany({
            where: { integrationId: integration.id },
          })
          for (const websiteIntegration of linked) {
            const resource = foundById.get(
              websiteIntegration.externalResourceId,
            )
            await (db as any).websiteIntegration.update({
              where: { id: websiteIntegration.id },
              data: resource
                ? {
                    externalResourceName: resource.externalResourceName,
                    metadata: resource.metadata ?? undefined,
                    status: "CONNECTED",
                  }
                : { status: "INACCESSIBLE" },
            })
            if (resource) refreshed++
          }

          results[provider] = {
            found: resources.length,
            created: refreshed,
          }

          if (isNew) {
            // Enqueue an initial sync for newly created integrations
            const { SyncService } = await import("./sync.service")
            const syncService = new SyncService()
            await syncService
              .triggerSync(
                { ownerType: ownerType as any, ownerId },
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
}
