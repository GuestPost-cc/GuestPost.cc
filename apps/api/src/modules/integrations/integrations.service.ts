import { randomBytes } from "node:crypto"
import type { OAuthStatePayload } from "@guestpost/integrations"
import {
  IntegrationProvider,
  IntegrationService,
  IntegrationSyncTrigger,
  OAuthStateService,
  SyncService,
} from "@guestpost/integrations"
import { Injectable } from "@nestjs/common"
import { Redis } from "ioredis"

@Injectable()
export class IntegrationsService {
  private readonly integrationService: IntegrationService
  private readonly syncService: SyncService
  private readonly oauthStateService: OAuthStateService

  constructor() {
    const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379")
    this.integrationService = new IntegrationService()
    this.syncService = new SyncService()
    this.oauthStateService = new OAuthStateService(redis)
  }

  async initiateConnect(
    publisherId: string,
    provider: string,
    returnUrl: string,
  ): Promise<{ authorizationUrl: string }> {
    const parsedProvider = provider as IntegrationProvider
    const nonce = randomBytes(32).toString("hex")
    const statePayload: OAuthStatePayload = {
      publisherId,
      provider: parsedProvider,
      nonce,
      returnUrl,
      createdAt: new Date().toISOString(),
    }
    await this.oauthStateService.createState(statePayload)
    const authorizationUrl = await this.integrationService.initiateOAuth(
      publisherId,
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
    const integrationId = await this.integrationService.handleOAuthCallback(
      statePayload.publisherId,
      statePayload.provider,
      code,
    )
    return { integrationId }
  }

  async listIntegrations(publisherId: string, page: number, pageSize: number) {
    return this.integrationService.listIntegrations(publisherId, page, pageSize)
  }

  async getIntegration(publisherId: string, integrationId: string) {
    return this.integrationService.getIntegration(publisherId, integrationId)
  }

  async discoverAvailableProperties(
    publisherId: string,
    integrationId: string,
  ) {
    return this.integrationService.discoverAvailableProperties(
      publisherId,
      integrationId,
    )
  }

  async linkProperty(
    publisherId: string,
    integrationId: string,
    websiteId: string,
    propertyUrl: string,
  ) {
    return this.integrationService.linkProperty(
      publisherId,
      integrationId,
      websiteId,
      propertyUrl,
    )
  }

  async triggerSync(
    publisherId: string,
    integrationId: string,
    options: {
      trigger?: IntegrationSyncTrigger
      propertyUrl?: string
      startDate?: string
      endDate?: string
    },
  ) {
    const syncId = await this.syncService.triggerSync(
      publisherId,
      integrationId,
      options.trigger ?? IntegrationSyncTrigger.MANUAL,
    )
    return { syncId }
  }

  async getSyncHistory(
    publisherId: string,
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
      publisherId,
      integrationId,
      options.page,
      options.pageSize,
      options.filters,
    )
  }

  async getSyncStatus(syncId: string) {
    return this.syncService.getSyncStatus(syncId)
  }

  async disconnect(publisherId: string, integrationId: string): Promise<void> {
    await this.integrationService.disconnect(publisherId, integrationId)
  }
}
