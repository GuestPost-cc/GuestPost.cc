export enum IntegrationProvider {
  GOOGLE_SEARCH_CONSOLE = "GOOGLE_SEARCH_CONSOLE",
  GOOGLE_ANALYTICS = "GOOGLE_ANALYTICS",
  BING_WEBMASTER = "BING_WEBMASTER",
}

export enum IntegrationStatus {
  PENDING = "PENDING",
  DISCOVERING = "DISCOVERING",
  ACTIVE = "ACTIVE",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  REAUTH_REQUIRED = "REAUTH_REQUIRED",
  DISCONNECTED = "DISCONNECTED",
  ERROR = "ERROR",
}

export enum WebsiteIntegrationStatus {
  CONNECTED = "CONNECTED",
  SYNCING = "SYNCING",
  OUT_OF_SYNC = "OUT_OF_SYNC",
  REMOVED = "REMOVED",
  DISABLED = "DISABLED",
}

export enum IntegrationSyncStatus {
  PENDING = "PENDING",
  PROCESSING = "PROCESSING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}

export enum IntegrationSyncTrigger {
  MANUAL = "MANUAL",
  SCHEDULED = "SCHEDULED",
  OAUTH = "OAUTH",
}

export enum IntegrationSyncJobType {
  SYNC = "SYNC",
  BACKFILL = "BACKFILL",
}

export enum ExternalAccountStatus {
  ACTIVE = "ACTIVE",
  EXPIRED = "EXPIRED",
  REVOKED = "REVOKED",
  ERROR = "ERROR",
}

export enum IntegrationOwnerType {
  PUBLISHER = "PUBLISHER",
  PLATFORM = "PLATFORM",
}

export interface OwnerContext {
  ownerType: IntegrationOwnerType
  ownerId: string
}

export interface CredentialTokens {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scopes: string[]
}

export interface DiscoveredResource {
  externalResourceId: string
  externalResourceName: string
  metadata?: Record<string, unknown>
}

export interface SyncResult {
  success: boolean
  recordsProcessed: number
  syncedAt: Date
  error?: string
  durationMs: number
}

export interface OAuthStatePayload {
  ownerType: IntegrationOwnerType
  ownerId: string
  provider: IntegrationProvider
  nonce: string
  returnUrl: string
  createdAt: string
}

export interface ProviderCapabilities {
  oauth: boolean
  discovery: boolean
  sync: boolean
  backfill: boolean
  incrementalScopes: boolean
}

export interface DiscoveryResource {
  externalResourceId: string
  externalResourceName: string
  metadata?: Record<string, unknown>
}
