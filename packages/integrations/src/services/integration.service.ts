import { createPrismaClient } from "@guestpost/database"
import {
  IntegrationEncryptionService,
  type IntegrationTokenIdentity,
  integrationTokenEncryptionContext,
} from "../adapters/encryption.adapter"
import {
  IntegrationNotFoundError,
  NoActiveCredentialError,
  PropertyAlreadyLinkedError,
  PropertyNotFoundError,
  ProviderError,
  WebsiteAlreadyLinkedError,
  WebsiteIntegrationNotFoundError,
} from "../errors"
import { assertGoogleMetricsEnabled } from "../google-metrics-gate"
import { getProvider } from "../providers"
import type { OwnerContext } from "../types"
import { ExternalAccountStatus } from "../types"

const db = createPrismaClient()
let encryptionSingleton: IntegrationEncryptionService | undefined

function integrationEncryption(): IntegrationEncryptionService {
  encryptionSingleton ??= new IntegrationEncryptionService()
  return encryptionSingleton
}

interface GoogleUserInfo {
  id: string
  email?: string
  name?: string
  picture?: string
}

function tokenIdentity(account: {
  provider: string
  externalUserId: string
  ownerType: string
  ownerId: string
}): IntegrationTokenIdentity {
  return {
    provider: account.provider,
    externalUserId: account.externalUserId,
    ownerType: account.ownerType,
    ownerId: account.ownerId,
  }
}

function getCredentialProvider(provider: string) {
  // ExternalAccount.provider historically stores the OAuth authority family
  // (GOOGLE/MICROSOFT), while newer rows may store the service provider enum.
  // Resolve both representations through the one registry registration that
  // owns refresh/revocation for that credential family.
  const registrationKey =
    provider === "GOOGLE"
      ? "GOOGLE_SEARCH_CONSOLE"
      : provider === "MICROSOFT"
        ? "BING_WEBMASTER"
        : provider
  return { registrationKey, registration: getProvider(registrationKey) }
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
    // Do not request fresh provider credentials for a capability that is
    // deliberately quarantined. This must run before config/provider access.
    assertGoogleMetricsEnabled()
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
    // Reject in-flight callbacks before exchanging the authorization code or
    // persisting credentials while Google metric ingestion is quarantined.
    assertGoogleMetricsEnabled()
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

    // 3. Upsert an owner-scoped ExternalAccount. The same Google identity may
    //    be used by a publisher and the platform, but encrypted credentials
    //    are never shared or overwritten across those trust boundaries.
    const identity = tokenIdentity({
      provider,
      externalUserId: userInfo.id,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
    })
    const encryption = integrationEncryption()
    const encryptedAccessToken = encryption.encrypt(
      { value: tokens.accessToken },
      {
        authenticatedContext: integrationTokenEncryptionContext(
          identity,
          "access",
        ),
      },
    )
    const encryptedRefreshToken = encryption.encrypt(
      { value: tokens.refreshToken },
      {
        authenticatedContext: integrationTokenEncryptionContext(
          identity,
          "refresh",
        ),
      },
    )
    if (encryptedAccessToken.version !== encryptedRefreshToken.version) {
      throw new Error("Integration token encryption versions do not match")
    }

    await (db as any).externalAccount.upsert({
      where: {
        provider_externalUserId_ownerType_ownerId: {
          provider,
          externalUserId: userInfo.id,
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
        },
      },
      create: {
        provider,
        externalUserId: userInfo.id,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        email: userInfo.email ?? null,
        displayName: userInfo.name ?? null,
        encryptedAccessToken: encryptedAccessToken.ciphertext,
        encryptedRefreshToken: encryptedRefreshToken.ciphertext,
        encryptionKeyVersion: encryptedAccessToken.version,
        tokenExpiresAt: tokens.expiresAt,
        grantedScopes: tokens.scopes,
        status: ExternalAccountStatus.ACTIVE,
      },
      update: {
        email: userInfo.email ?? null,
        displayName: userInfo.name ?? null,
        encryptedAccessToken: encryptedAccessToken.ciphertext,
        encryptedRefreshToken: encryptedRefreshToken.ciphertext,
        encryptionKeyVersion: encryptedAccessToken.version,
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
        provider_externalUserId_ownerType_ownerId: {
          provider,
          externalUserId: userInfo.id,
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
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
              grantedScopes: true,
              lastDiscoveryAt: true,
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
              grantedScopes: i.connection.grantedScopes ?? [],
              lastDiscoveryAt:
                i.connection.lastDiscoveryAt?.toISOString() ?? null,
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
        grantedScopes: integration.connection.grantedScopes ?? [],
        lastDiscoveryAt:
          integration.connection.lastDiscoveryAt?.toISOString() ?? null,
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

  async discover(
    owner: OwnerContext,
    integrationId: string,
  ): Promise<{ enqueued: boolean }> {
    assertGoogleMetricsEnabled()
    const integration = await (db as any).publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
      select: { connectionId: true },
    })
    if (!integration) throw new IntegrationNotFoundError()

    const { DiscoveryService } = await import("./discovery.service")
    return new DiscoveryService().enqueueDiscovery(
      owner,
      integration.connectionId,
    )
  }

  async listResources(owner: OwnerContext, integrationId: string) {
    assertGoogleMetricsEnabled()
    const integration = await this.findOwnedIntegration(owner, integrationId)
    const accessToken = await this.getActiveAccessToken(
      integration.connectionId,
    )
    const registration = getProvider(integration.provider)
    if (!registration?.discoveryProvider) {
      throw new ProviderError(
        `Provider ${integration.provider} does not support discovery`,
        "DISCOVERY_NOT_SUPPORTED",
      )
    }

    const resources =
      await registration.discoveryProvider.discoverResources(accessToken)
    const discoveredAt = new Date()
    await (db as any).externalAccount.update({
      where: { id: integration.connectionId },
      data: { lastDiscoveryAt: discoveredAt, lastUsedAt: discoveredAt },
    })

    return {
      resources: resources.map((resource) => ({
        externalResourceId: resource.externalResourceId,
        externalResourceName: resource.externalResourceName ?? null,
        metadata: resource.metadata ?? null,
      })),
      discoveredAt: discoveredAt.toISOString(),
      isStale: false,
    }
  }

  async linkProperty(
    owner: OwnerContext,
    integrationId: string,
    websiteId: string,
    externalResourceId: string,
  ) {
    assertGoogleMetricsEnabled()
    const integration = await this.findOwnedIntegration(owner, integrationId)
    if (owner.ownerType === "PLATFORM" && websiteId !== owner.ownerId) {
      throw new WebsiteIntegrationNotFoundError()
    }
    const website = await (db as any).website.findFirst({
      where:
        owner.ownerType === "PLATFORM"
          ? {
              // Platform credentials are owned by exactly one website. Keep
              // this invariant here as defense in depth even though the API
              // owner resolver already checks staff assignment.
              id: owner.ownerId,
              ownershipType: "PLATFORM",
            }
          : {
              id: websiteId,
              ownershipType: "PUBLISHER",
              publisherId: owner.ownerId,
            },
      select: { id: true, url: true },
    })
    if (!website) throw new WebsiteIntegrationNotFoundError()

    const existingProperty = await (db as any).websiteIntegration.findUnique({
      where: {
        integrationId_externalResourceId: {
          integrationId,
          externalResourceId,
        },
      },
      include: { website: { select: { id: true, url: true } } },
    })
    if (existingProperty) {
      if (existingProperty.websiteId !== websiteId) {
        throw new PropertyAlreadyLinkedError(existingProperty.website?.url)
      }
      if (existingProperty.status !== "REMOVED") {
        return {
          externalResourceId: existingProperty.externalResourceId,
          externalResourceName: existingProperty.externalResourceName,
          alreadyLinked: true,
          linkedWebsiteId: website.id,
          linkedWebsiteUrl: website.url,
        }
      }
    }

    const existingWebsite = await (db as any).websiteIntegration.findFirst({
      where: {
        integrationId,
        websiteId,
        status: { not: "REMOVED" },
      },
      select: { externalResourceName: true, externalResourceId: true },
    })
    if (existingWebsite) {
      throw new WebsiteAlreadyLinkedError(
        existingWebsite.externalResourceName ??
          existingWebsite.externalResourceId,
      )
    }

    // Validate the caller-selected property against the provider immediately;
    // clients cannot forge an arbitrary resource id and make workers query it.
    const accessToken = await this.getActiveAccessToken(
      integration.connectionId,
    )
    const registration = getProvider(integration.provider)
    if (!registration?.discoveryProvider) throw new PropertyNotFoundError()
    const resources =
      await registration.discoveryProvider.discoverResources(accessToken)
    const resource = resources.find(
      (candidate) => candidate.externalResourceId === externalResourceId,
    )
    if (!resource) throw new PropertyNotFoundError()

    // A removed link is durable source provenance, so relinking reactivates
    // only the exact same integration + website + provider property identity.
    // updateMany is a compare-and-set: two concurrent relinks cannot both
    // transition the tombstone, and neither can retarget its historical id.
    if (existingProperty?.status === "REMOVED") {
      const reactivated = await (db as any).websiteIntegration.updateMany({
        where: {
          id: existingProperty.id,
          integrationId,
          websiteId,
          externalResourceId,
          status: "REMOVED",
        },
        data: {
          externalResourceName: resource.externalResourceName ?? null,
          metadata: resource.metadata ?? undefined,
          status: "CONNECTED",
          syncedAt: null,
        },
      })
      if (reactivated.count === 1) {
        return {
          externalResourceId: existingProperty.externalResourceId,
          externalResourceName: resource.externalResourceName ?? null,
          alreadyLinked: false,
          linkedWebsiteId: website.id,
          linkedWebsiteUrl: website.url,
        }
      }

      const concurrent = await (db as any).websiteIntegration.findUnique({
        where: { id: existingProperty.id },
      })
      if (
        concurrent?.integrationId === integrationId &&
        concurrent?.websiteId === websiteId &&
        concurrent?.externalResourceId === externalResourceId &&
        concurrent?.status !== "REMOVED"
      ) {
        return {
          externalResourceId: concurrent.externalResourceId,
          externalResourceName: concurrent.externalResourceName,
          alreadyLinked: true,
          linkedWebsiteId: website.id,
          linkedWebsiteUrl: website.url,
        }
      }
      throw new WebsiteAlreadyLinkedError()
    }

    let linked: any
    try {
      linked = await (db as any).websiteIntegration.create({
        data: {
          integrationId,
          websiteId,
          externalResourceId: resource.externalResourceId,
          externalResourceName: resource.externalResourceName ?? null,
          metadata: resource.metadata ?? undefined,
          status: "CONNECTED",
        },
      })
    } catch (error: any) {
      if (error?.code === "P2002") {
        throw new WebsiteAlreadyLinkedError()
      }
      throw error
    }

    return {
      externalResourceId: linked.externalResourceId,
      externalResourceName: linked.externalResourceName,
      alreadyLinked: false,
      linkedWebsiteId: website.id,
      linkedWebsiteUrl: website.url,
    }
  }

  async unlinkProperty(
    owner: OwnerContext,
    integrationId: string,
    websiteIntegrationId: string,
  ): Promise<void> {
    await this.findOwnedIntegration(owner, integrationId)
    const linked = await (db as any).websiteIntegration.findFirst({
      where: { id: websiteIntegrationId, integrationId },
      select: { id: true, status: true },
    })
    if (!linked) throw new WebsiteIntegrationNotFoundError()

    if (linked.status === "REMOVED") return

    // WebsiteIntegration is durable source provenance. Tombstoning keeps its
    // primary key and provider-property identity available to historical daily
    // metrics; a future exact relink uses the CAS path above.
    const removed = await (db as any).websiteIntegration.updateMany({
      where: {
        id: websiteIntegrationId,
        integrationId,
        status: { not: "REMOVED" },
      },
      data: { status: "REMOVED", syncedAt: null },
    })
    if (removed.count !== 1) {
      const concurrent = await (db as any).websiteIntegration.findFirst({
        where: { id: websiteIntegrationId, integrationId },
        select: { status: true },
      })
      if (concurrent?.status !== "REMOVED") {
        throw new WebsiteIntegrationNotFoundError()
      }
    }
  }

  private async findOwnedIntegration(
    owner: OwnerContext,
    integrationId: string,
  ): Promise<any> {
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
    return integration
  }

  async getActiveAccessToken(connectionId: string): Promise<string> {
    const account = await (db as any).externalAccount.findUnique({
      where: { id: connectionId },
    })
    if (!account || account.status !== ExternalAccountStatus.ACTIVE) {
      throw new NoActiveCredentialError()
    }
    const identity = tokenIdentity(account)
    const encryption = integrationEncryption()

    const isExpired =
      account.tokenExpiresAt.getTime() - Date.now() < 30 * 60 * 1000

    if (isExpired && account.encryptedRefreshToken) {
      const refreshTokenPayload = encryption.decrypt(
        account.encryptedRefreshToken,
        account.encryptionKeyVersion,
        integrationTokenEncryptionContext(identity, "refresh"),
      )
      if (
        typeof refreshTokenPayload.value !== "string" ||
        refreshTokenPayload.value.length === 0
      ) {
        throw new NoActiveCredentialError()
      }
      const refreshToken = refreshTokenPayload.value

      const { registration } = getCredentialProvider(account.provider)
      if (!registration?.oauthProvider) {
        throw new ProviderError(
          `Provider ${account.provider} does not support OAuth`,
          "OAUTH_NOT_SUPPORTED",
        )
      }

      const tokens =
        await registration.oauthProvider.refreshTokens(refreshToken)

      const encryptedAccessToken = encryption.encrypt(
        { value: tokens.accessToken },
        {
          authenticatedContext: integrationTokenEncryptionContext(
            identity,
            "access",
          ),
        },
      )
      const encryptedRefreshToken = encryption.encrypt(
        { value: tokens.refreshToken },
        {
          authenticatedContext: integrationTokenEncryptionContext(
            identity,
            "refresh",
          ),
        },
      )
      if (encryptedAccessToken.version !== encryptedRefreshToken.version) {
        throw new Error("Integration token encryption versions do not match")
      }

      const updated = await (db as any).externalAccount.updateMany({
        where: {
          id: connectionId,
          status: ExternalAccountStatus.ACTIVE,
          encryptionKeyVersion: account.encryptionKeyVersion,
          encryptedRefreshToken: account.encryptedRefreshToken,
        },
        data: {
          encryptedAccessToken: encryptedAccessToken.ciphertext,
          encryptedRefreshToken: encryptedRefreshToken.ciphertext,
          encryptionKeyVersion: encryptedAccessToken.version,
          tokenExpiresAt: tokens.expiresAt,
          grantedScopes: tokens.scopes,
          lastUsedAt: new Date(),
        },
      })

      if (updated.count === 1) return tokens.accessToken

      // Another refresh, OAuth callback, or key-rotation worker won the CAS.
      // Never overwrite its newer refresh token/ciphertext with this response.
      const current = await (db as any).externalAccount.findUnique({
        where: { id: connectionId },
      })
      if (!current || current.status !== ExternalAccountStatus.ACTIVE) {
        throw new NoActiveCredentialError()
      }
      const currentIdentity = tokenIdentity(current)
      const currentToken = encryption.decrypt(
        current.encryptedAccessToken,
        current.encryptionKeyVersion,
        integrationTokenEncryptionContext(currentIdentity, "access"),
      )
      if (
        typeof currentToken.value !== "string" ||
        currentToken.value.length === 0
      ) {
        throw new NoActiveCredentialError()
      }
      return currentToken.value
    }

    const accessToken = encryption.decrypt(
      account.encryptedAccessToken,
      account.encryptionKeyVersion,
      integrationTokenEncryptionContext(identity, "access"),
    )
    if (
      typeof accessToken.value !== "string" ||
      accessToken.value.length === 0
    ) {
      throw new NoActiveCredentialError()
    }
    return accessToken.value
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

    // Serialize every integration that shares this credential. This prevents
    // two concurrent sibling disconnects from both observing the other as
    // active and consequently skipping the last-connection revocation.
    //
    // IMPORTANT: the compile-time Google-metrics quarantine currently keeps
    // OAuth callback/discovery reactivation from racing this locked aggregate.
    // Before that gate is removed, every connection/create/reactivation path
    // must take this same ExternalAccount row lock and re-check ACTIVE status.
    await (db as any).$transaction(
      async (tx: any) => {
        const lockedConnections = await tx.$queryRaw`
        SELECT "id"
        FROM "ExternalAccount"
        WHERE "id" = ${integration.connectionId}
        FOR UPDATE
      `
        if (
          !Array.isArray(lockedConnections) ||
          lockedConnections.length !== 1
        ) {
          throw new NoActiveCredentialError()
        }

        const current = await tx.publisherIntegration.findFirst({
          where: {
            id: integrationId,
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
            connectionId: integration.connectionId,
          },
          include: { connection: true },
        })
        if (!current) throw new IntegrationNotFoundError()
        if (!current.connection) throw new NoActiveCredentialError()

        const activeSiblingCount = await tx.publisherIntegration.count({
          where: {
            connectionId: current.connectionId,
            id: { not: current.id },
            status: { not: "DISCONNECTED" },
          },
        })
        const isLastConnection = activeSiblingCount === 0

        if (
          isLastConnection &&
          current.connection.status !== ExternalAccountStatus.REVOKED
        ) {
          const { registrationKey, registration } = getCredentialProvider(
            current.connection.provider,
          )
          if (!registration?.oauthProvider) {
            throw new ProviderError(
              `Credential provider ${registrationKey} does not support token revocation`,
              "TOKEN_REVOCATION_NOT_SUPPORTED",
            )
          }

          const decrypted = integrationEncryption().decrypt(
            current.connection.encryptedAccessToken,
            current.connection.encryptionKeyVersion,
            integrationTokenEncryptionContext(
              tokenIdentity(current.connection),
              "access",
            ),
          )
          if (
            typeof decrypted.value !== "string" ||
            decrypted.value.length === 0
          ) {
            throw new NoActiveCredentialError()
          }

          // Provider errors are deliberately not swallowed. A failed or
          // unconfirmed revocation must leave the aggregate connected so the
          // caller can retry and cannot mistake a local tombstone for evidence
          // that the external credential was revoked.
          await registration.oauthProvider.revokeToken(decrypted.value)
        }

        // Disconnect is an aggregate tombstone, not deletion.
        // WebsiteIntegration ids remain durable daily-metric provenance, and
        // the schedule is disabled in the same commit so no worker can observe
        // a half-disconnected state.
        const disconnected = await tx.publisherIntegration.updateMany({
          where: {
            id: integrationId,
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
            connectionId: current.connectionId,
          },
          data: { status: "DISCONNECTED" },
        })
        if (disconnected.count !== 1) throw new IntegrationNotFoundError()

        await tx.integrationSchedule.updateMany({
          where: { integrationId, enabled: true },
          data: { enabled: false, version: { increment: 1 } },
        })
        await tx.websiteIntegration.updateMany({
          where: { integrationId, status: { not: "REMOVED" } },
          data: { status: "REMOVED", syncedAt: null },
        })

        if (isLastConnection) {
          await tx.externalAccount.update({
            where: { id: current.connectionId },
            data: { status: ExternalAccountStatus.REVOKED },
          })
        }
      },
      { timeout: 30_000 },
    )
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
