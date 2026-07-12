import { createPrismaClient } from "@guestpost/database"
import { IntegrationEncryptionService } from "../adapters/encryption.adapter"
import {
  IntegrationNotFoundError,
  NoActiveCredentialError,
  ProviderError,
} from "../errors"
import { getProvider } from "../providers"
import type { OwnerContext } from "../types"
import { ExternalAccountStatus } from "../types"

const db = createPrismaClient()
const encryption = new IntegrationEncryptionService()

interface GoogleUserInfo {
  id: string
  email?: string
  name?: string
  picture?: string
}

export class IntegrationService {
  private getRedirectUri(provider: string): string {
    const apiBaseUrl = this.getApiBaseUrl()
    return `${apiBaseUrl}/integrations/${provider}/callback`
  }

  private getApiBaseUrl(): string {
    const explicitApiBaseUrl = process.env.API_BASE_URL?.trim()
    if (explicitApiBaseUrl) {
      return explicitApiBaseUrl.replace(/\/$/, "")
    }

    const publicApiOrigin = process.env.NEXT_PUBLIC_API_URL?.trim()
    if (publicApiOrigin) {
      const normalized = publicApiOrigin.replace(/\/$/, "")
      return normalized.endsWith("/api/v1")
        ? normalized
        : `${normalized}/api/v1`
    }

    throw new ProviderError(
      "API_BASE_URL or NEXT_PUBLIC_API_URL is required to build OAuth redirect URIs. Set API_BASE_URL in .env.development, for example http://localhost:4000/api/v1.",
      "API_BASE_URL_MISSING",
    )
  }

  async initiateOAuth(
    _owner: OwnerContext,
    provider: string,
    returnUrl: string,
    stateNonce: string,
  ): Promise<string> {
    const registration = getProvider(provider)
    if (!registration?.oauthProvider) {
      throw new ProviderError(
        `Provider ${provider} does not support OAuth`,
        "OAUTH_NOT_SUPPORTED",
      )
    }
    const redirectUri = this.getRedirectUri(provider)
    return registration.oauthProvider.getAuthorizationUrl(
      stateNonce,
      redirectUri,
    )
  }

  async handleOAuthCallback(
    owner: OwnerContext,
    provider: string,
    code: string,
  ): Promise<{ externalAccountId: string }> {
    const registration = getProvider(provider)
    if (!registration?.oauthProvider) {
      throw new ProviderError(
        `Provider ${provider} does not support OAuth`,
        "OAUTH_NOT_SUPPORTED",
      )
    }
    const redirectUri = this.getRedirectUri(provider)

    // 1. Exchange code for tokens
    const tokens = await registration.oauthProvider.exchangeCodeForTokens(
      code,
      redirectUri,
    )

    // 2. Fetch Google user info to get externalUserId
    const userInfo = await this.fetchGoogleUserInfo(tokens.accessToken)

    // 3. Upsert ExternalAccount with encrypted tokens
    //    One Google identity = one ExternalAccount. If the account already
    //    exists (e.g. reconnecting with new scopes), update tokens in place.
    await (db as any).externalAccount.upsert({
      where: {
        provider_externalUserId: {
          provider,
          externalUserId: userInfo.id,
        },
      },
      create: {
        provider,
        externalUserId: userInfo.id,
        email: userInfo.email ?? null,
        displayName: userInfo.name ?? null,
        encryptedAccessToken: encryption.encrypt({
          value: tokens.accessToken,
        }).ciphertext,
        encryptedRefreshToken: encryption.encrypt({
          value: tokens.refreshToken,
        }).ciphertext,
        tokenExpiresAt: tokens.expiresAt,
        grantedScopes: tokens.scopes,
        status: ExternalAccountStatus.ACTIVE,
      },
      update: {
        email: userInfo.email ?? null,
        displayName: userInfo.name ?? null,
        encryptedAccessToken: encryption.encrypt({
          value: tokens.accessToken,
        }).ciphertext,
        encryptedRefreshToken: encryption.encrypt({
          value: tokens.refreshToken,
        }).ciphertext,
        tokenExpiresAt: tokens.expiresAt,
        grantedScopes: tokens.scopes,
        status: ExternalAccountStatus.ACTIVE,
      },
    })

    // 4. Return externalAccountId so the caller can queue discovery.
    //    Discovery will create PublisherIntegration + IntegrationSchedule
    //    + WebsiteIntegration for each Google service that has resources.
    const account = await (db as any).externalAccount.findUniqueOrThrow({
      where: {
        provider_externalUserId: {
          provider,
          externalUserId: userInfo.id,
        },
      },
    })

    return { externalAccountId: account.id }
  }

  async listIntegrations(owner: OwnerContext, page = 1, pageSize = 20) {
    const where = { ownerType: owner.ownerType, ownerId: owner.ownerId }
    const [items, total] = await Promise.all([
      (db as any).publisherIntegration.findMany({
        where,
        include: {
          connection: {
            select: {
              id: true,
              provider: true,
              email: true,
              displayName: true,
              status: true,
            },
          },
          websiteIntegrations: {
            select: {
              id: true,
              websiteId: true,
              externalResourceId: true,
              externalResourceName: true,
              status: true,
              syncedAt: true,
            },
          },
          schedule: {
            select: {
              id: true,
              enabled: true,
              nextRunAt: true,
            },
          },
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
      }),
      (db as any).publisherIntegration.count({ where }),
    ])

    return {
      data: items.map((i: any) => ({
        id: i.id,
        ownerType: i.ownerType,
        ownerId: i.ownerId,
        provider: i.provider,
        connection: i.connection
          ? {
              id: i.connection.id,
              email: i.connection.email,
              displayName: i.connection.displayName,
              status: i.connection.status,
            }
          : null,
        status: i.status,
        linkedWebsites: (i.websiteIntegrations ?? []).map((w: any) => ({
          id: w.id,
          websiteId: w.websiteId,
          externalResourceId: w.externalResourceId,
          externalResourceName: w.externalResourceName,
          status: w.status,
          syncedAt: w.syncedAt?.toISOString() ?? null,
        })),
        schedule: i.schedule
          ? {
              enabled: i.schedule.enabled,
              nextRunAt: i.schedule.nextRunAt.toISOString(),
            }
          : null,
        createdAt: i.createdAt.toISOString(),
        updatedAt: i.updatedAt.toISOString(),
      })),
      pagination: {
        page,
        pageSize,
        total,
        hasNext: page * pageSize < total,
      },
    }
  }

  async getIntegration(owner: OwnerContext, integrationId: string) {
    const integration = await (db as any).publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
      include: {
        connection: true,
        websiteIntegrations: {
          include: { integration: false },
        },
        schedule: true,
        syncs: {
          take: 10,
          orderBy: { startedAt: "desc" },
        },
      },
    })
    if (!integration) throw new IntegrationNotFoundError()
    if (!integration.connection) throw new NoActiveCredentialError()

    return {
      id: integration.id,
      ownerType: integration.ownerType,
      ownerId: integration.ownerId,
      provider: integration.provider,
      connection: {
        id: integration.connection.id,
        email: integration.connection.email,
        displayName: integration.connection.displayName,
        status: integration.connection.status,
        tokenExpiresAt: integration.connection.tokenExpiresAt.toISOString(),
      },
      status: integration.status,
      linkedWebsites: (integration.websiteIntegrations ?? []).map((w: any) => ({
        id: w.id,
        websiteId: w.websiteId,
        externalResourceId: w.externalResourceId,
        externalResourceName: w.externalResourceName,
        metadata: w.metadata,
        status: w.status,
        syncedAt: w.syncedAt?.toISOString() ?? null,
      })),
      schedule: integration.schedule
        ? {
            enabled: integration.schedule.enabled,
            intervalMinutes: integration.schedule.intervalMinutes,
            nextRunAt: integration.schedule.nextRunAt.toISOString(),
            lastRunAt: integration.schedule.lastRunAt?.toISOString() ?? null,
            lastSuccessAt:
              integration.schedule.lastSuccessAt?.toISOString() ?? null,
          }
        : null,
      createdAt: integration.createdAt.toISOString(),
      updatedAt: integration.updatedAt.toISOString(),
    }
  }

  async getActiveAccessToken(connectionId: string): Promise<string> {
    const account = await (db as any).externalAccount.findUnique({
      where: { id: connectionId },
    })
    if (!account) throw new NoActiveCredentialError()

    const isExpired =
      account.tokenExpiresAt.getTime() - Date.now() < 30 * 60 * 1000

    if (isExpired && account.encryptedRefreshToken) {
      const refreshToken = (
        encryption.decrypt(account.encryptedRefreshToken) as {
          value: string
        }
      ).value

      const registration = getProvider(account.provider)
      if (!registration?.oauthProvider) {
        throw new ProviderError(
          `Provider ${account.provider} does not support OAuth`,
          "OAUTH_NOT_SUPPORTED",
        )
      }

      const tokens =
        await registration.oauthProvider.refreshTokens(refreshToken)

      await (db as any).externalAccount.update({
        where: { id: connectionId },
        data: {
          encryptedAccessToken: encryption.encrypt({
            value: tokens.accessToken,
          }).ciphertext,
          encryptedRefreshToken: encryption.encrypt({
            value: tokens.refreshToken,
          }).ciphertext,
          tokenExpiresAt: tokens.expiresAt,
          grantedScopes: tokens.scopes,
          lastUsedAt: new Date(),
        },
      })

      return tokens.accessToken
    }

    return (
      encryption.decrypt(account.encryptedAccessToken) as {
        value: string
      }
    ).value
  }

  async disconnect(owner: OwnerContext, integrationId: string): Promise<void> {
    const integration = await (db as any).publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
      include: { connection: true },
    })
    if (!integration) throw new IntegrationNotFoundError()

    // Revoke tokens if possible
    if (integration.connection) {
      try {
        const accessToken = (
          encryption.decrypt(integration.connection.encryptedAccessToken) as {
            value: string
          }
        ).value
        const registration = getProvider(integration.provider)
        await registration?.oauthProvider?.revokeToken(accessToken)
      } catch {
        // best-effort revocation
      }
    }

    // Cascade delete will remove websiteIntegrations, syncs, schedule, discoveries
    await (db as any).publisherIntegration.delete({
      where: { id: integrationId },
    })
  }

  private async fetchGoogleUserInfo(
    accessToken: string,
  ): Promise<GoogleUserInfo> {
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    )

    if (!response.ok) {
      throw new ProviderError(
        "Failed to fetch Google user info",
        "GOOGLE_USERINFO_FAILED",
      )
    }

    return response.json() as Promise<GoogleUserInfo>
  }
}
