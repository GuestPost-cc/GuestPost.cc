import {
  ProviderError,
  ProviderRateLimitError,
  ReauthRequiredError,
  TokenExpiredError,
} from "../../errors"
import { GooglePermissionLevel, IntegrationProvider } from "../../types"
import { GoogleSearchConsoleProvider } from "../google-search-console.provider"

const SITES_RESPONSE = {
  sites: [
    { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
    { siteUrl: "https://blog.example.com/", permissionLevel: "siteFullUser" },
    {
      siteUrl: "https://unauthorized.com/",
      permissionLevel: "siteLimitedUser",
    },
  ],
}

function mockFetch(data: unknown, ok = true, status = 200) {
  return jest.spyOn(global, "fetch").mockResolvedValue({
    ok,
    status,
    json: async () => data,
    headers: new Map(),
  } as unknown as Response)
}

describe("GoogleSearchConsoleProvider", () => {
  let provider: GoogleSearchConsoleProvider

  beforeEach(() => {
    provider = new GoogleSearchConsoleProvider()
    process.env.GOOGLE_CLIENT_ID = "test-client-id"
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret"
    jest.clearAllMocks()
  })

  describe("name and scopes", () => {
    it("has correct name", () => {
      expect(provider.name).toBe(IntegrationProvider.GOOGLE_SEARCH_CONSOLE)
    })

    it("has correct scopes", () => {
      expect(provider.scopes).toEqual([
        "https://www.googleapis.com/auth/webmasters.readonly",
      ])
    })
  })

  describe("validateOwnership", () => {
    beforeEach(() => {
      mockFetch(SITES_RESPONSE)
    })

    it("returns valid=true for siteOwner", async () => {
      const result = await provider.validateOwnership(
        "fake-token",
        "https://example.com",
      )
      expect(result.valid).toBe(true)
      expect(result.ownershipVerified).toBe(true)
      expect(result.permissionLevel).toBe(GooglePermissionLevel.SITE_OWNER)
      expect(result.issues).toBeUndefined()
    })

    it("returns valid=true for siteFullUser", async () => {
      const result = await provider.validateOwnership(
        "fake-token",
        "https://blog.example.com",
      )
      expect(result.valid).toBe(true)
      expect(result.ownershipVerified).toBe(true)
      expect(result.permissionLevel).toBe(GooglePermissionLevel.SITE_FULL_USER)
    })

    it("returns valid=false for siteLimitedUser", async () => {
      const result = await provider.validateOwnership(
        "fake-token",
        "https://unauthorized.com",
      )
      expect(result.valid).toBe(false)
      expect(result.ownershipVerified).toBe(false)
      expect(result.issues).toContain("You must be a site owner or full user")
    })

    it("returns valid=false for unrecognized property", async () => {
      const result = await provider.validateOwnership(
        "fake-token",
        "https://not-in-list.com",
      )
      expect(result.valid).toBe(false)
      expect(result.ownershipVerified).toBe(false)
      expect(result.issues).toContain(
        "Property not found in Google Search Console",
      )
    })

    it("normalizes URLs before comparison (no trailing slash)", async () => {
      mockFetch(SITES_RESPONSE)
      const result = await provider.validateOwnership(
        "fake-token",
        "https://example.com",
      )
      expect(result.valid).toBe(true)
    })

    it("normalizes URLs before comparison (with trailing slash)", async () => {
      mockFetch(SITES_RESPONSE)
      const result = await provider.validateOwnership(
        "fake-token",
        "https://example.com/",
      )
      expect(result.valid).toBe(true)
    })

    it("normalizes URLs (www prefix)", async () => {
      mockFetch(SITES_RESPONSE)
      const result = await provider.validateOwnership(
        "fake-token",
        "http://www.example.com",
      )
      expect(result.valid).toBe(true)
    })

    it("throws TokenExpiredError on 401", async () => {
      mockFetch({}, false, 401)
      await expect(
        provider.validateOwnership("expired-token", "https://example.com"),
      ).rejects.toThrow(TokenExpiredError)
    })

    it("throws ProviderRateLimitError on 429", async () => {
      mockFetch({}, false, 429)
      const headers = new Map()
      headers.set("Retry-After", "60")
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({}),
        headers,
      } as unknown as Response)

      await expect(
        provider.validateOwnership("rate-limited-token", "https://example.com"),
      ).rejects.toThrow(ProviderRateLimitError)
    })
  })

  describe("discoverResources", () => {
    it("returns all discovered sites", async () => {
      mockFetch(SITES_RESPONSE)
      const resources = await provider.discoverResources("fake-token")
      expect(resources).toHaveLength(3)
      expect(resources[0]).toEqual({
        externalId: "https://example.com/",
        url: "https://example.com/",
        permissionLevel: "siteOwner",
      })
    })

    it("returns empty array when no sites", async () => {
      mockFetch({ sites: [] })
      const resources = await provider.discoverResources("fake-token")
      expect(resources).toHaveLength(0)
    })

    it("throws TokenExpiredError on 401", async () => {
      mockFetch({}, false, 401)
      await expect(provider.discoverResources("expired-token")).rejects.toThrow(
        TokenExpiredError,
      )
    })
  })

  describe("refreshTokens", () => {
    it("returns new tokens on success", async () => {
      mockFetch({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/webmasters.readonly",
      })
      const result = await provider.refreshTokens("old-refresh-token")
      expect(result.accessToken).toBe("new-access-token")
      expect(result.refreshToken).toBe("new-refresh-token")
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it("preserves refresh token when not returned", async () => {
      mockFetch({
        access_token: "new-access-token",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/webmasters.readonly",
      })
      const result = await provider.refreshTokens("original-refresh")
      expect(result.refreshToken).toBe("original-refresh")
    })

    it("throws ReauthRequiredError on invalid_grant", async () => {
      mockFetch({ error: "invalid_grant" }, false, 400)
      await expect(provider.refreshTokens("bad-refresh-token")).rejects.toThrow(
        ReauthRequiredError,
      )
    })

    it("throws ProviderError on other errors", async () => {
      mockFetch({ error: "server_error" }, false, 500)
      await expect(provider.refreshTokens("any-token")).rejects.toThrow(
        ProviderError,
      )
    })
  })

  describe("exchangeCodeForTokens", () => {
    it("returns tokens on success", async () => {
      mockFetch({
        access_token: "exchanged-access",
        refresh_token: "exchanged-refresh",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/webmasters.readonly",
      })
      const result = await provider.exchangeCodeForTokens(
        "auth-code",
        "https://callback.example.com/oauth",
      )
      expect(result.accessToken).toBe("exchanged-access")
      expect(result.refreshToken).toBe("exchanged-refresh")
    })

    it("throws ProviderError on failure", async () => {
      mockFetch({ error: "invalid_client" }, false, 400)
      await expect(
        provider.exchangeCodeForTokens(
          "bad-code",
          "https://callback.example.com",
        ),
      ).rejects.toThrow(ProviderError)
    })
  })

  describe("revokeToken", () => {
    it("calls revoke endpoint without throwing", async () => {
      const fetchMock = mockFetch({})
      await expect(
        provider.revokeToken("token-to-revoke"),
      ).resolves.toBeUndefined()
      expect(fetchMock).toHaveBeenCalledWith(
        "https://oauth2.googleapis.com/revoke",
        expect.objectContaining({
          method: "POST",
        }),
      )
      const callArgs = fetchMock.mock.calls[0]
      const body = callArgs[1].body as URLSearchParams
      expect(body.get("token")).toBe("token-to-revoke")
    })
  })

  describe("getAuthorizationUrl", () => {
    it("returns a valid Google OAuth URL", async () => {
      const url = await provider.getAuthorizationUrl(
        "test-state",
        "https://api.example.com/integrations/GOOGLE_SEARCH_CONSOLE/callback",
      )
      expect(url).toContain("accounts.google.com/o/oauth2/v2/auth")
      expect(url).toContain("client_id=test-client-id")
      expect(url).toContain("state=test-state")
      expect(url).toContain(
        "scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fwebmasters.readonly",
      )
      expect(url).toContain("access_type=offline")
      expect(url).toContain("prompt=consent")
    })

    it("throws an actionable error when Google client ID is missing", async () => {
      delete process.env.GOOGLE_CLIENT_ID
      await expect(
        provider.getAuthorizationUrl(
          "test-state",
          "https://callback.example.com",
        ),
      ).rejects.toMatchObject({
        code: "PROVIDER_ERROR",
        details: { providerCode: "GOOGLE_OAUTH_CONFIG_MISSING" },
      })
    })
  })

  describe("triggerSync", () => {
    it("returns success result with duration", async () => {
      const result = await provider.triggerSync(
        "fake-token",
        "https://example.com",
        new Date("2026-07-01"),
        new Date("2026-07-07"),
      )
      expect(result.success).toBe(true)
      expect(result.recordsProcessed).toBe(0)
      expect(result.syncedAt).toBeInstanceOf(Date)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })
  })
})
