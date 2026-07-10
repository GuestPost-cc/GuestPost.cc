import { GOOGLE_SEARCH_CONSOLE_SCOPES } from "../constants"
import {
  ProviderError,
  ProviderRateLimitError,
  ReauthRequiredError,
  TokenExpiredError,
} from "../errors"
import type {
  CredentialTokens,
  DiscoveredResource,
  SyncResult,
  ValidationResult,
} from "../types"
import { GooglePermissionLevel, IntegrationProvider } from "../types"
import type { IntegrationProviderBase } from "./provider.interface"

interface GscSite {
  siteUrl: string
  permissionLevel: string
}

interface GscSiteWithUrl {
  url: string
  permissionLevel: string
}

interface GscSearchAnalyticsRow {
  keys: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  error?: string
}

interface GoogleErrorResponse {
  error: string
}

export class GoogleSearchConsoleProvider implements IntegrationProviderBase {
  readonly name = IntegrationProvider.GOOGLE_SEARCH_CONSOLE
  readonly scopes = GOOGLE_SEARCH_CONSOLE_SCOPES

  private readonly baseUrl = "https://www.googleapis.com/webmasters/v3"

  async validateOwnership(
    accessToken: string,
    propertyUrl: string,
  ): Promise<ValidationResult> {
    const sites = await this.listSites(accessToken)
    const normalizedProperty = this.normalizeUrl(propertyUrl)
    const found = sites.find(
      (s) => this.normalizeUrl(s.url) === normalizedProperty,
    )

    if (!found) {
      return {
        valid: false,
        ownershipVerified: false,
        permissionLevel: GooglePermissionLevel.NONE,
        issues: ["Property not found in Google Search Console"],
      }
    }

    const level = found.permissionLevel as GooglePermissionLevel
    const isOwner =
      level === GooglePermissionLevel.SITE_OWNER ||
      level === GooglePermissionLevel.SITE_FULL_USER

    return {
      valid: isOwner,
      ownershipVerified: isOwner,
      permissionLevel: level,
      issues: isOwner ? undefined : ["You must be a site owner or full user"],
    }
  }

  async discoverResources(accessToken: string): Promise<DiscoveredResource[]> {
    const sites = await this.listSites(accessToken)
    return sites.map((site) => ({
      externalId: site.url,
      url: site.url,
      permissionLevel: site.permissionLevel,
    }))
  }

  async refreshTokens(refreshToken: string): Promise<CredentialTokens> {
    const { clientId, clientSecret } = this.getOAuthConfig()
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })

    if (!response.ok) {
      const err = (await response.json()) as GoogleErrorResponse
      if (err.error === "invalid_grant") {
        throw new ReauthRequiredError()
      }
      throw new ProviderError("Failed to refresh token", err.error)
    }

    const data = (await response.json()) as GoogleTokenResponse
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(" ") ?? this.scopes,
    }
  }

  async revokeToken(accessToken: string): Promise<void> {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }),
    })
  }

  async triggerSync(
    _accessToken: string,
    _propertyUrl: string,
    _startDate?: Date,
    _endDate?: Date,
  ): Promise<SyncResult> {
    const startMs = Date.now()
    return {
      success: true,
      recordsProcessed: 0,
      syncedAt: new Date(),
      durationMs: Date.now() - startMs,
    }
  }

  async getAuthorizationUrl(
    state: string,
    redirectUri: string,
  ): Promise<string> {
    const clientId = this.getRequiredEnv("GOOGLE_CLIENT_ID")
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: this.scopes.join(" "),
      access_type: "offline",
      state,
      prompt: "consent",
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
  }

  async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
  ): Promise<CredentialTokens> {
    const { clientId, clientSecret } = this.getOAuthConfig()
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })

    if (!response.ok) {
      const err = (await response.json()) as GoogleErrorResponse
      throw new ProviderError("Failed to exchange code for tokens", err.error)
    }

    const data = (await response.json()) as GoogleTokenResponse
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? "",
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(" ") ?? this.scopes,
    }
  }

  private async listSites(accessToken: string): Promise<GscSiteWithUrl[]> {
    const response = await fetch(
      `${this.baseUrl}/sites?fields=sites%2FpermissionLevel%2Csites%2FsiteUrl`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    )

    if (response.status === 401) throw new TokenExpiredError()
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After")
      throw new ProviderRateLimitError(
        `Google rate limit. Retry after ${retryAfter ?? "unknown"}`,
      )
    }
    if (!response.ok) {
      throw new ProviderError("Failed to list GSC sites")
    }

    const data = (await response.json()) as { sites?: GscSite[] }
    return (data.sites ?? []).map((s: GscSite) => ({
      url: s.siteUrl,
      permissionLevel: s.permissionLevel,
    }))
  }

  private getOAuthConfig(): { clientId: string; clientSecret: string } {
    return {
      clientId: this.getRequiredEnv("GOOGLE_CLIENT_ID"),
      clientSecret: this.getRequiredEnv("GOOGLE_CLIENT_SECRET"),
    }
  }

  private getRequiredEnv(name: "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET") {
    const value = process.env[name]?.trim()
    if (!value) {
      throw new ProviderError(
        `Google Search Console OAuth is not configured. Set ${name} in the API/worker environment before connecting Google Search Console.`,
        "GOOGLE_OAUTH_CONFIG_MISSING",
      )
    }
    return value
  }

  private normalizeUrl(url: string): string {
    let normalized = url.toLowerCase().trim()
    if (normalized.startsWith("http://")) {
      normalized = `https://${normalized.slice("http://".length)}`
    } else if (!normalized.startsWith("https://")) {
      normalized = `https://${normalized}`
    }
    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1)
    }
    if (normalized.startsWith("https://www.")) {
      normalized = `https://${normalized.slice("https://www.".length)}`
    }
    return normalized
  }
}
