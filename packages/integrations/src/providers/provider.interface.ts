import type {
  CredentialTokens,
  DiscoveredResource,
  SyncResult,
  ValidationResult,
} from "../types"

export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: Date
}

export abstract class IntegrationProviderBase {
  abstract readonly name: string
  abstract readonly scopes: string[]

  abstract validateOwnership(
    accessToken: string,
    propertyUrl: string,
  ): Promise<ValidationResult>

  abstract discoverResources(accessToken: string): Promise<DiscoveredResource[]>

  abstract refreshTokens(refreshToken: string): Promise<CredentialTokens>

  abstract revokeToken(accessToken: string): Promise<void>

  abstract triggerSync(
    accessToken: string,
    propertyUrl: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<SyncResult>

  abstract getAuthorizationUrl(
    state: string,
    redirectUri: string,
  ): Promise<string>

  abstract exchangeCodeForTokens(
    code: string,
    redirectUri: string,
  ): Promise<CredentialTokens>
}

export interface ProviderRegistry {
  get(provider: string): IntegrationProviderBase
  list(): IntegrationProviderBase[]
  has(provider: string): boolean
}
