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

export enum IntegrationOwnerType {
  PUBLISHER = "PUBLISHER",
  PLATFORM = "PLATFORM",
}

export interface OwnerContext {
  ownerType: IntegrationOwnerType
  ownerId: string
}

export enum GooglePermissionLevel {
  SITE_OWNER = "siteOwner",
  SITE_FULL_USER = "siteFullUser",
  SITE_LIMITED_USER = "siteLimitedUser",
  SITE_ASSOCIATE = "siteAssociate",
  NONE = "none",
}

export interface CredentialTokens {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scopes: string[]
}

export interface DiscoveredResource {
  externalId: string
  url: string
  permissionLevel: string
}

export interface ValidationResult {
  valid: boolean
  ownershipVerified: boolean
  permissionLevel: string
  issues?: string[]
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

export interface LinkedResource {
  externalPropertyId: string
  propertyUrl: string
  permissionLevel: string
  alreadyLinked: boolean
  linkedWebsiteId?: string | null
  linkedWebsiteUrl?: string | null
}
