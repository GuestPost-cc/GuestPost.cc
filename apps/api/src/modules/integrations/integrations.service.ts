import { randomBytes } from "node:crypto"
import type { OAuthStatePayload, OwnerContext } from "@guestpost/integrations"
import {
  DiscoveryService,
  IntegrationProvider,
  IntegrationService,
  IntegrationSyncTrigger,
  OAuthStateService,
  QUEUES,
  SyncService,
} from "@guestpost/integrations"
import { Injectable } from "@nestjs/common"
import { Queue } from "bullmq"
import { Redis } from "ioredis"

@Injectable()
export class IntegrationsService {
  private readonly integrationService: IntegrationService
  private readonly syncService: SyncService
  private readonly oauthStateService: OAuthStateService
  private readonly discoveryService: DiscoveryService
  private readonly redis: Redis
  private readonly syncQueue: Queue
  private readonly discoveryQueue: Queue

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379")
    this.integrationService = new IntegrationService()
    this.syncService = new SyncService(this.redis)
    this.oauthStateService = new OAuthStateService(this.redis)
    this.discoveryService = new DiscoveryService(this.redis)
    const connection = {
      host: process.env.REDIS_HOST ?? "localhost",
      port: Number(process.env.REDIS_PORT ?? 6379),
    }
    this.syncQueue = new Queue(QUEUES.SYNC, { connection })
    this.discoveryQueue = new Queue(QUEUES.DISCOVERY, { connection })
  }

  async initiateConnect(
    owner: OwnerContext,
    provider: string,
    returnUrl: string,
  ): Promise<{ authorizationUrl: string }> {
    const parsedProvider = provider as IntegrationProvider
    const nonce = randomBytes(32).toString("hex")
    const statePayload: OAuthStatePayload = {
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      provider: parsedProvider,
      nonce,
      returnUrl,
      createdAt: new Date().toISOString(),
    }
    await this.oauthStateService.createState(statePayload)
    const authorizationUrl = await this.integrationService.initiateOAuth(
      owner,
      parsedProvider,
      returnUrl,
      nonce,
    )
    return { authorizationUrl }
  }

  async handleCallback(
    provider: string,
    code: string,
    state: string,
  ): Promise<{ integrationId: string }> {
    const statePayload = await this.oauthStateService.consumeState(state)
    const owner: OwnerContext = {
      ownerType: statePayload.ownerType,
      ownerId: statePayload.ownerId,
    }
    const { integrationId } = await this.integrationService.handleOAuthCallback(
      owner,
      statePayload.provider,
      code,
    )

    await this.discoveryQueue.add("discover", {
      integrationId,
    })

    return { integrationId }
  }

  async listIntegrations(owner: OwnerContext, page: number, pageSize: number) {
    return this.integrationService.listIntegrations(owner, page, pageSize)
  }

  async getIntegration(owner: OwnerContext, integrationId: string) {
    return this.integrationService.getIntegration(owner, integrationId)
  }

  async enqueueDiscovery(
    owner: OwnerContext,
    integrationId: string,
  ): Promise<{ enqueued: boolean }> {
    await this.discoveryService.enqueueDiscovery(owner, integrationId)
    await this.discoveryQueue.add("discover", {
      integrationId,
    })
    return { enqueued: true }
  }

  async getCachedResources(owner: OwnerContext, integrationId: string) {
    return this.discoveryService.getCachedResources(owner, integrationId)
  }

  async linkProperty(
    owner: OwnerContext,
    integrationId: string,
    websiteId: string,
    externalId: string,
  ) {
    return this.integrationService.linkProperty(
      owner,
      integrationId,
      websiteId,
      externalId,
    )
  }

  async unlinkProperty(
    owner: OwnerContext,
    integrationId: string,
    websiteIntegrationId: string,
  ): Promise<void> {
    await this.integrationService.unlinkProperty(
      owner,
      integrationId,
      websiteIntegrationId,
    )
  }

  async triggerSync(
    owner: OwnerContext,
    integrationId: string,
    options: {
      trigger?: IntegrationSyncTrigger
      propertyUrl?: string
      startDate?: string
      endDate?: string
    },
  ) {
    const { syncId, websiteIntegrationIds } =
      await this.syncService.triggerSync(
        owner,
        integrationId,
        options.trigger ?? IntegrationSyncTrigger.MANUAL,
        options.propertyUrl,
      )

    await this.syncQueue.add("sync", {
      integrationId,
      trigger: options.trigger ?? IntegrationSyncTrigger.MANUAL,
      propertyUrl: options.propertyUrl,
      startDate: options.startDate,
      endDate: options.endDate,
    })

    return { syncId, websiteIntegrationIds }
  }

  async getSyncHistory(
    owner: OwnerContext,
    integrationId: string,
    options: {
      page: number
      pageSize: number
      filters?: {
        status?: string
        trigger?: string
        dateFrom?: string
        dateTo?: string
      }
    },
  ) {
    return this.syncService.getSyncHistory(
      owner,
      integrationId,
      options.page,
      options.pageSize,
      options.filters,
    )
  }

  async getSyncStatus(syncId: string) {
    return this.syncService.getSyncStatus(syncId)
  }

  async disconnect(owner: OwnerContext, integrationId: string): Promise<void> {
    await this.integrationService.disconnect(owner, integrationId)
  }
}
