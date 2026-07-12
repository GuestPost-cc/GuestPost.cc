import { randomBytes } from "node:crypto"
import type { OwnerContext } from "@guestpost/integrations"
import {
  DiscoveryService,
  IntegrationService,
  type OAuthStatePayload,
  OAuthStateService,
  SyncService,
} from "@guestpost/integrations"
import { Injectable } from "@nestjs/common"
import { Redis } from "ioredis"

@Injectable()
export class IntegrationsApiService {
  private readonly integrationService: IntegrationService
  private readonly syncService: SyncService
  private readonly oauthStateService: OAuthStateService
  private readonly discoveryService: DiscoveryService
  private readonly redis: Redis

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379")
    this.integrationService = new IntegrationService()
    this.syncService = new SyncService()
    this.oauthStateService = new OAuthStateService(this.redis)
    this.discoveryService = new DiscoveryService()
  }

  async initiateConnect(
    owner: OwnerContext,
    provider: string,
    returnUrl: string,
  ): Promise<{ authorizationUrl: string }> {
    const nonce = randomBytes(32).toString("hex")
    const statePayload: OAuthStatePayload = {
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      provider: provider as any,
      nonce,
      returnUrl,
      createdAt: new Date().toISOString(),
    }
    await this.oauthStateService.createState(statePayload)
    const authorizationUrl = await this.integrationService.initiateOAuth(
      owner,
      provider,
      returnUrl,
      nonce,
    )
    return { authorizationUrl }
  }

  async handleCallback(
    provider: string,
    code: string,
    state: string,
  ): Promise<{ externalAccountId: string }> {
    const statePayload = await this.oauthStateService.consumeState(state)
    const owner: OwnerContext = {
      ownerType: statePayload.ownerType,
      ownerId: statePayload.ownerId,
    }
    const { externalAccountId } =
      await this.integrationService.handleOAuthCallback(
        owner,
        statePayload.provider as string,
        code,
      )

    // Enqueue discovery for the ExternalAccount. Discovery will
    // create PublisherIntegration + IntegrationSchedule + WebsiteIntegration
    // for each Google service (GSC, GA4) that has accessible resources.
    await this.discoveryService.enqueueDiscovery(owner, externalAccountId)

    return { externalAccountId }
  }

  async listIntegrations(owner: OwnerContext, page: number, pageSize: number) {
    return this.integrationService.listIntegrations(owner, page, pageSize)
  }

  async getIntegration(owner: OwnerContext, integrationId: string) {
    return this.integrationService.getIntegration(owner, integrationId)
  }

  async enqueueDiscovery(
    owner: OwnerContext,
    externalAccountId: string,
  ): Promise<{ enqueued: boolean }> {
    return this.discoveryService.enqueueDiscovery(owner, externalAccountId)
  }

  async rediscover(
    owner: OwnerContext,
    externalAccountId: string,
  ): Promise<{ enqueued: boolean }> {
    return this.discoveryService.rediscover(owner, externalAccountId)
  }

  async triggerSync(
    owner: OwnerContext,
    integrationId: string,
    options: {
      trigger?: string
      websiteIntegrationId?: string
      startDate?: string
      endDate?: string
    },
  ) {
    return this.syncService.triggerSync(
      owner,
      integrationId,
      options.trigger ?? "MANUAL",
      options.websiteIntegrationId,
    )
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
