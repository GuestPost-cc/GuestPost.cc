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
  ): Promise<{ externalAccountId: string | null; redirectUrl: string }> {
    const statePayload = await this.oauthStateService.consumeState(state)
    this.assertCallbackProvider(provider, statePayload)
    const owner: OwnerContext = {
      ownerType: statePayload.ownerType,
      ownerId: statePayload.ownerId,
    }

    try {
      const { externalAccountId } =
        await this.integrationService.handleOAuthCallback(
          owner,
          statePayload.provider as string,
          code,
        )

      // Discovery creates provider integrations and schedules. Website links
      // remain an explicit choice so a Google property cannot be attached to
      // the wrong GuestPost website automatically.
      await this.discoveryService.enqueueDiscovery(owner, externalAccountId)

      return {
        externalAccountId,
        redirectUrl: this.buildFrontendReturnUrl(statePayload, {
          connected: externalAccountId,
        }),
      }
    } catch (error) {
      return {
        externalAccountId: null,
        redirectUrl: this.buildFrontendReturnUrl(statePayload, {
          error:
            error instanceof Error ? error.message : "OAuth callback failed",
        }),
      }
    }
  }

  async handleCallbackError(
    provider: string,
    state: string,
    error: string,
  ): Promise<{ redirectUrl: string }> {
    const statePayload = await this.oauthStateService.consumeState(state)
    this.assertCallbackProvider(provider, statePayload)
    return {
      redirectUrl: this.buildFrontendReturnUrl(statePayload, { error }),
    }
  }

  private assertCallbackProvider(
    provider: string,
    statePayload: OAuthStatePayload,
  ): void {
    if (statePayload.provider !== provider) {
      throw new Error("OAuth callback provider does not match its state")
    }
  }

  private buildFrontendReturnUrl(
    statePayload: OAuthStatePayload,
    query: Record<string, string>,
  ): string {
    const isPlatform = statePayload.ownerType === "PLATFORM"
    const envName = isPlatform
      ? "NEXT_PUBLIC_ADMIN_URL"
      : "NEXT_PUBLIC_PUBLISHER_URL"
    const configuredOrigin = process.env[envName]?.trim()
    const developmentOrigin = isPlatform
      ? "http://localhost:3003"
      : "http://localhost:3002"
    const rawOrigin =
      configuredOrigin ||
      (process.env.NODE_ENV !== "production" ? developmentOrigin : "")
    if (!rawOrigin) {
      throw new Error(`${envName} is required for OAuth callback redirects`)
    }

    const parsedOrigin = new URL(rawOrigin)
    if (!["http:", "https:"].includes(parsedOrigin.protocol)) {
      throw new Error(`${envName} must use http or https`)
    }
    const origin = parsedOrigin.origin
    const redirect = new URL(statePayload.returnUrl, `${origin}/`)
    // Defense in depth: the request schema already requires an app-relative
    // path, but callback state must never become an external redirect.
    if (redirect.origin !== origin) {
      throw new Error("OAuth return URL is not allowed")
    }
    for (const [key, value] of Object.entries(query)) {
      redirect.searchParams.set(key, value)
    }
    return redirect.toString()
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

  async discover(owner: OwnerContext, integrationId: string) {
    return this.integrationService.discover(owner, integrationId)
  }

  async listResources(owner: OwnerContext, integrationId: string) {
    return this.integrationService.listResources(owner, integrationId)
  }

  async linkProperty(
    owner: OwnerContext,
    integrationId: string,
    websiteId: string,
    externalResourceId: string,
  ) {
    return this.integrationService.linkProperty(
      owner,
      integrationId,
      websiteId,
      externalResourceId,
    )
  }

  async unlinkProperty(
    owner: OwnerContext,
    integrationId: string,
    websiteIntegrationId: string,
  ) {
    return this.integrationService.unlinkProperty(
      owner,
      integrationId,
      websiteIntegrationId,
    )
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
      options.startDate,
      options.endDate,
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

  async getSyncStatus(owner: OwnerContext, syncId: string) {
    return this.syncService.getSyncStatus(owner, syncId)
  }

  async disconnect(owner: OwnerContext, integrationId: string): Promise<void> {
    await this.integrationService.disconnect(owner, integrationId)
  }
}
