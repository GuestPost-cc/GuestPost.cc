import type { CredentialTokens, DiscoveryResource, SyncResult } from "../types"

export interface OAuthProvider {
  getAuthorizationUrl(state: string, redirectUri: string): Promise<string>
  exchangeCodeForTokens(
    code: string,
    redirectUri: string,
  ): Promise<CredentialTokens>
  refreshTokens(refreshToken: string): Promise<CredentialTokens>
  revokeToken(accessToken: string): Promise<void>
}

export interface DiscoveryProvider {
  discoverResources(accessToken: string): Promise<DiscoveryResource[]>
}

export interface SyncProvider {
  sync(
    accessToken: string,
    externalResourceId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<SyncResult>
}

export interface ProviderRegistration {
  name: string
  scopes: string[]
  capabilities: {
    oauth: boolean
    discovery: boolean
    sync: boolean
    backfill: boolean
    incrementalScopes: boolean
  }
  oauthProvider?: OAuthProvider
  discoveryProvider?: DiscoveryProvider
  syncProvider?: SyncProvider
}

export interface ProviderRegistry {
  get(provider: string): ProviderRegistration
  list(): ProviderRegistration[]
  has(provider: string): boolean
}
