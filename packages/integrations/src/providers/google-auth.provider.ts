import { ProviderError, ReauthRequiredError } from "../errors"
import type { CredentialTokens } from "../types"
import type { OAuthProvider } from "./provider.interface"

interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  error?: string
}

interface GoogleErrorResponse {
  error: string
  error_description?: string
}

/**
 * Shared OAuth handler for Google services.
 * Implements OAuthProvider using Google OAuth2 endpoints.
 */
export class GoogleAuthProvider implements OAuthProvider {
  private readonly clientId: string
  private readonly clientSecret: string

  constructor(private readonly scopes: string[]) {
    this.clientId = GoogleAuthProvider.getRequiredEnv("GOOGLE_CLIENT_ID")
    this.clientSecret = GoogleAuthProvider.getRequiredEnv(
      "GOOGLE_CLIENT_SECRET",
    )
  }

  async getAuthorizationUrl(
    state: string,
    redirectUri: string,
  ): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.clientId,
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
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    })

    if (!response.ok) {
      const err = (await response.json()) as GoogleErrorResponse
      throw new ProviderError(
        `Failed to exchange code for tokens: ${err.error_description ?? err.error}`,
        err.error,
      )
    }

    const data = (await response.json()) as GoogleTokenResponse
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? "",
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(" ") ?? this.scopes,
    }
  }

  async refreshTokens(refreshToken: string): Promise<CredentialTokens> {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    })

    if (!response.ok) {
      const err = (await response.json()) as GoogleErrorResponse
      if (err.error === "invalid_grant") {
        throw new ReauthRequiredError()
      }
      throw new ProviderError(
        `Failed to refresh token: ${err.error_description ?? err.error}`,
        err.error,
      )
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

  private static getRequiredEnv(
    name: "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET",
  ): string {
    const value = process.env[name]?.trim()
    if (!value) {
      throw new ProviderError(
        `Google OAuth is not configured. Set ${name} in the API/worker environment.`,
        "GOOGLE_OAUTH_CONFIG_MISSING",
      )
    }
    return value
  }
}
