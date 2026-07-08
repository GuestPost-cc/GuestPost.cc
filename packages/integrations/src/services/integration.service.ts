import { createPrismaClient, IntegrationStatus } from "@guestpost/database"
import { IntegrationEncryptionService } from "../adapters/encryption.adapter"
import {
  IntegrationNotFoundError,
  NoActiveCredentialError,
  PropertyAlreadyLinkedError,
  PropertyNotFoundError,
  ReauthRequiredError,
  TokenExpiredError,
  WebsiteAlreadyLinkedError,
} from "../errors"
import { getProvider } from "../providers"
import type {
  DiscoveredResource,
  LinkedResource,
  OwnerContext,
  ValidationResult,
} from "../types"
import {
  GooglePermissionLevel,
  IntegrationProvider,
  WebsiteIntegrationStatus,
} from "../types"
import { isPropertyUrlMatch, normalizePropertyUrl } from "../utils"

const db = createPrismaClient()
const encryption = new IntegrationEncryptionService()

export class IntegrationService {
  async initiateOAuth(
    _owner: OwnerContext,
    provider: IntegrationProvider,
    returnUrl: string,
    stateNonce: string,
  ): Promise<string> {
    const providerImpl = getProvider(provider)
    const redirectUri = `${process.env.API_BASE_URL}/integrations/${provider}/callback`
    return providerImpl.getAuthorizationUrl(stateNonce, redirectUri)
  }

  async handleOAuthCallback(
    owner: OwnerContext,
    provider: IntegrationProvider,
    code: string,
  ): Promise<{ integrationId: string; providerAccountId: string }> {
    const providerImpl = getProvider(provider)
    const redirectUri = `${process.env.API_BASE_URL}/integrations/${provider}/callback`

    const tokens = await providerImpl.exchangeCodeForTokens(code, redirectUri)

    const discovered = await providerImpl.discoverResources(tokens.accessToken)
    const primarySite = discovered[0]

    const existing = await db.publisherIntegration.findFirst({
      where: {
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        provider,
        providerAccountId: primarySite?.externalId ?? "",
      },
    })
    if (existing) {
      await db.publisherIntegration.update({
        where: { id: existing.id },
        data: { status: IntegrationStatus.DISCOVERING },
      })
      await db.integrationCredential.upsert({
        where: { integrationId: existing.id },
        update: {
          encryptedAccessToken: encryption.encrypt({
            value: tokens.accessToken,
          }).ciphertext,
          encryptedRefreshToken: encryption.encrypt({
            value: tokens.refreshToken,
          }).ciphertext,
          tokenExpiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
        },
        create: {
          integrationId: existing.id,
          encryptedAccessToken: encryption.encrypt({
            value: tokens.accessToken,
          }).ciphertext,
          encryptedRefreshToken: encryption.encrypt({
            value: tokens.refreshToken,
          }).ciphertext,
          tokenExpiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
        },
      })
      return {
        integrationId: existing.id,
        providerAccountId: primarySite?.externalId ?? "",
      }
    }

    const integration = await db.publisherIntegration.create({
      data: {
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        provider,
        providerAccountId: primarySite?.externalId ?? "",
        status: IntegrationStatus.DISCOVERING,
      },
    })

    await db.integrationCredential.create({
      data: {
        integrationId: integration.id,
        encryptedAccessToken: encryption.encrypt({ value: tokens.accessToken })
          .ciphertext,
        encryptedRefreshToken: encryption.encrypt({
          value: tokens.refreshToken,
        }).ciphertext,
        tokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
      },
    })

    return {
      integrationId: integration.id,
      providerAccountId: primarySite?.externalId ?? "",
    }
  }

  async listIntegrations(owner: OwnerContext, page = 1, pageSize = 20) {
    const where = { ownerType: owner.ownerType, ownerId: owner.ownerId }
    const [items, total] = await Promise.all([
      db.publisherIntegration.findMany({
        where,
        include: {
          websiteIntegrations: {
            select: {
              id: true,
              websiteId: true,
              propertyUrl: true,
              status: true,
              syncedAt: true,
            },
          },
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
      }),
      db.publisherIntegration.count({ where }),
    ])

    return {
      data: items.map((i) => ({
        id: i.id,
        ownerType: i.ownerType,
        ownerId: i.ownerId,
        provider: i.provider,
        providerAccountId: i.providerAccountId,
        status: i.status,
        linkedWebsites: i.websiteIntegrations,
        lastSyncAt: i.lastSyncAt?.toISOString() ?? null,
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
    const integration = await db.publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
      include: {
        credentials: true,
        websiteIntegrations: {
          include: { integration: false },
        },
        syncs: {
          take: 10,
          orderBy: { startedAt: "desc" },
        },
      },
    })
    if (!integration) throw new IntegrationNotFoundError()

    const creds = integration.credentials
    if (!creds) throw new NoActiveCredentialError()

    const accessToken = (
      encryption.decrypt(creds.encryptedAccessToken) as { value: string }
    ).value
    const providerImpl = getProvider(integration.provider)
    let permissionValidated: ValidationResult | null = null

    if (integration.websiteIntegrations.length > 0) {
      const primaryProperty = integration.websiteIntegrations[0]
      permissionValidated = await providerImpl
        .validateOwnership(accessToken, primaryProperty.propertyUrl)
        .catch((err) => {
          if (
            err instanceof TokenExpiredError ||
            err instanceof ReauthRequiredError
          ) {
            return null
          }
          throw err
        })
    }

    return {
      id: integration.id,
      ownerType: integration.ownerType,
      ownerId: integration.ownerId,
      provider: integration.provider,
      providerAccountId: integration.providerAccountId,
      status:
        permissionValidated === null &&
        integration.status === IntegrationStatus.ACTIVE
          ? IntegrationStatus.TOKEN_EXPIRED
          : integration.status,
      linkedWebsites: integration.websiteIntegrations.map((w) => ({
        id: w.id,
        websiteId: w.websiteId,
        propertyUrl: w.propertyUrl,
        status: w.status,
        syncedAt: w.syncedAt?.toISOString() ?? null,
      })),
      lastSyncAt: integration.lastSyncAt?.toISOString() ?? null,
      createdAt: integration.createdAt.toISOString(),
      updatedAt: integration.updatedAt.toISOString(),
    }
  }

  async discoverAvailableProperties(
    owner: OwnerContext,
    integrationId: string,
  ): Promise<DiscoveredResource[]> {
    const integration = await db.publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
      include: { credentials: true },
    })
    if (!integration) throw new IntegrationNotFoundError()
    const creds = integration.credentials
    if (!creds) throw new NoActiveCredentialError()

    const accessToken = (
      encryption.decrypt(creds.encryptedAccessToken) as { value: string }
    ).value
    const providerImpl = getProvider(integration.provider)
    return providerImpl.discoverResources(accessToken)
  }

  async linkProperty(
    owner: OwnerContext,
    integrationId: string,
    websiteId: string,
    externalId: string,
  ): Promise<LinkedResource> {
    const integration = await db.publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
      include: {
        credentials: true,
        websiteIntegrations: { where: { websiteId } },
      },
    })
    if (!integration) throw new IntegrationNotFoundError()

    const existingForWebsite = await db.websiteIntegration.findFirst({
      where: { websiteId },
    })
    if (existingForWebsite) {
      throw new WebsiteAlreadyLinkedError(existingForWebsite.propertyUrl)
    }

    const cachedResources =
      (integration.discoveredResources as unknown as
        | DiscoveredResource[]
        | null) ?? []
    const resource = cachedResources.find(
      (r) =>
        r.externalId === externalId ||
        normalizePropertyUrl(r.url) === normalizePropertyUrl(externalId),
    )
    if (!resource) {
      throw new PropertyNotFoundError()
    }

    const normalizedPropertyUrl = normalizePropertyUrl(resource.url)

    const alreadyLinked = integration.websiteIntegrations.find((w) =>
      isPropertyUrlMatch(w.propertyUrl, resource.url),
    )
    if (alreadyLinked) {
      const linkedWebsite = await db.website.findUnique({
        where: { id: alreadyLinked.websiteId },
      })
      throw new PropertyAlreadyLinkedError(linkedWebsite?.url ?? undefined)
    }

    const creds = integration.credentials
    if (!creds) throw new NoActiveCredentialError()
    const accessToken = (
      encryption.decrypt(creds.encryptedAccessToken) as { value: string }
    ).value
    const providerImpl = getProvider(integration.provider)

    const validation = await providerImpl.validateOwnership(
      accessToken,
      resource.url,
    )
    if (!validation.valid) {
      throw new IntegrationNotFoundError()
    }

    const linked = await db.websiteIntegration.create({
      data: {
        integrationId,
        websiteId,
        propertyUrl: normalizedPropertyUrl,
        permissionLevel: validation.permissionLevel as GooglePermissionLevel,
        status: WebsiteIntegrationStatus.CONNECTED,
      },
    })

    return {
      externalPropertyId: externalId,
      propertyUrl: normalizedPropertyUrl,
      permissionLevel: validation.permissionLevel,
      alreadyLinked: false,
      linkedWebsiteId: linked.websiteId,
      linkedWebsiteUrl: null,
    }
  }

  async unlinkProperty(
    owner: OwnerContext,
    integrationId: string,
    websiteIntegrationId: string,
  ): Promise<void> {
    const integration = await db.publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
    })
    if (!integration) throw new IntegrationNotFoundError()

    const websiteIntegration = await db.websiteIntegration.findFirst({
      where: { id: websiteIntegrationId, integrationId },
    })
    if (!websiteIntegration) {
      throw new IntegrationNotFoundError()
    }

    await db.websiteIntegration.delete({
      where: { id: websiteIntegrationId },
    })
  }

  async disconnect(owner: OwnerContext, integrationId: string): Promise<void> {
    const integration = await db.publisherIntegration.findFirst({
      where: {
        id: integrationId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      },
      include: { credentials: true },
    })
    if (!integration) throw new IntegrationNotFoundError()

    if (integration.credentials) {
      try {
        const accessToken = (
          encryption.decrypt(integration.credentials.encryptedAccessToken) as {
            value: string
          }
        ).value
        const providerImpl = getProvider(integration.provider)
        await providerImpl.revokeToken(accessToken)
      } catch {
        // best-effort revocation
      }
      await db.integrationCredential.delete({ where: { integrationId } })
    }

    await db.websiteIntegration.deleteMany({ where: { integrationId } })
    await db.publisherIntegration.update({
      where: { id: integrationId },
      data: { status: IntegrationStatus.DISCONNECTED },
    })
  }

  async getActiveAccessToken(integrationId: string): Promise<string> {
    const creds = await db.integrationCredential.findUnique({
      where: { integrationId },
    })
    if (!creds) throw new NoActiveCredentialError()

    const isExpired =
      creds.tokenExpiresAt.getTime() - Date.now() < 30 * 60 * 1000
    if (isExpired) {
      const refreshToken = (
        encryption.decrypt(creds.encryptedRefreshToken) as { value: string }
      ).value
      const providerImpl = getProvider(
        process.env.DEFAULT_INTEGRATION_PROVIDER ?? "GOOGLE_SEARCH_CONSOLE",
      )
      const tokens = await providerImpl.refreshTokens(refreshToken)

      await db.integrationCredential.update({
        where: { integrationId },
        data: {
          encryptedAccessToken: encryption.encrypt({
            value: tokens.accessToken,
          }).ciphertext,
          encryptedRefreshToken: encryption.encrypt({
            value: tokens.refreshToken,
          }).ciphertext,
          tokenExpiresAt: tokens.expiresAt,
        },
      })

      return tokens.accessToken
    }

    return (encryption.decrypt(creds.encryptedAccessToken) as { value: string })
      .value
  }
}
