const mockUpsert = jest.fn()
const mockFindUniqueOrThrow = jest.fn()
const mockFindUnique = jest.fn()
const mockUpdateMany = jest.fn()
const mockEncrypt = jest.fn((payload: { value: string }) => ({
  ciphertext: `encrypted:${payload.value}`,
  version: 7,
}))
const mockDecrypt = jest.fn((ciphertext: string) => ({
  value: ciphertext.includes("refresh")
    ? "refresh-token"
    : ciphertext.includes("current")
      ? "current-access-token"
      : "access-token",
}))
const mockExchangeCodeForTokens = jest.fn()
const mockRefreshTokens = jest.fn()

const mockDb = {
  externalAccount: {
    upsert: mockUpsert,
    findUniqueOrThrow: mockFindUniqueOrThrow,
    findUnique: mockFindUnique,
    updateMany: mockUpdateMany,
  },
}

jest.mock("@guestpost/database", () => ({
  createPrismaClient: () => mockDb,
}))
jest.mock("../../adapters/encryption.adapter", () => ({
  IntegrationEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: mockEncrypt,
    decrypt: mockDecrypt,
  })),
  integrationTokenEncryptionContext: jest.fn(
    (identity: { ownerId: string }, purpose: string) =>
      `context:${identity.ownerId}:${purpose}`,
  ),
}))
jest.mock("../../google-metrics-gate", () => ({
  // This suite isolates credential encryption/version persistence. The
  // production-facing quarantine behavior has dedicated service tests.
  assertGoogleMetricsEnabled: jest.fn(),
}))
jest.mock("../../providers", () => ({
  getProvider: () => ({
    oauthProvider: {
      exchangeCodeForTokens: mockExchangeCodeForTokens,
      refreshTokens: mockRefreshTokens,
    },
  }),
}))

import { IntegrationOwnerType } from "../../types"
import { IntegrationService } from "../integration.service"

describe("Integration token encryption version persistence", () => {
  const originalFetch = global.fetch
  const originalApiBaseUrl = process.env.API_BASE_URL
  const owner = {
    ownerType: IntegrationOwnerType.PUBLISHER,
    ownerId: "publisher-1",
  }

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.API_BASE_URL = "https://api.example.test/api/v1"
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "google-user-1", email: "owner@example.test" }),
    }) as any
  })

  afterAll(() => {
    global.fetch = originalFetch
    if (originalApiBaseUrl === undefined) {
      delete process.env.API_BASE_URL
    } else {
      process.env.API_BASE_URL = originalApiBaseUrl
    }
  })

  it("stores one explicit key version with both OAuth token ciphertexts", async () => {
    mockExchangeCodeForTokens.mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      scopes: ["scope"],
    })
    mockUpsert.mockResolvedValue({})
    mockFindUniqueOrThrow.mockResolvedValue({ id: "account-1" })

    await new IntegrationService().handleOAuthCallback(
      owner,
      "GOOGLE_SEARCH_CONSOLE",
      "oauth-code",
    )

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          encryptedAccessToken: "encrypted:new-access-token",
          encryptedRefreshToken: "encrypted:new-refresh-token",
          encryptionKeyVersion: 7,
        }),
        update: expect.objectContaining({
          encryptedAccessToken: "encrypted:new-access-token",
          encryptedRefreshToken: "encrypted:new-refresh-token",
          encryptionKeyVersion: 7,
        }),
      }),
    )
    expect(mockEncrypt).toHaveBeenNthCalledWith(
      1,
      { value: "new-access-token" },
      { authenticatedContext: "context:publisher-1:access" },
    )
    expect(mockEncrypt).toHaveBeenNthCalledWith(
      2,
      { value: "new-refresh-token" },
      { authenticatedContext: "context:publisher-1:refresh" },
    )
  })

  it("decrypts a stored access token only with its row key version", async () => {
    mockFindUnique.mockResolvedValue({
      id: "account-1",
      provider: "GOOGLE_SEARCH_CONSOLE",
      externalUserId: "google-user-1",
      ownerType: "PUBLISHER",
      ownerId: "publisher-1",
      status: "ACTIVE",
      encryptedAccessToken: "encrypted:access",
      encryptedRefreshToken: "encrypted:refresh",
      encryptionKeyVersion: 4,
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })

    await expect(
      new IntegrationService().getActiveAccessToken("account-1"),
    ).resolves.toBe("access-token")
    expect(mockDecrypt).toHaveBeenCalledWith(
      "encrypted:access",
      4,
      "context:publisher-1:access",
    )
  })

  it("does not overwrite a concurrent refresh or key rotation winner", async () => {
    const expired = {
      id: "account-1",
      provider: "GOOGLE_SEARCH_CONSOLE",
      externalUserId: "google-user-1",
      ownerType: "PUBLISHER",
      ownerId: "publisher-1",
      status: "ACTIVE",
      encryptedAccessToken: "encrypted:old-access",
      encryptedRefreshToken: "encrypted:old-refresh",
      encryptionKeyVersion: 4,
      tokenExpiresAt: new Date(Date.now() - 60_000),
    }
    const current = {
      ...expired,
      encryptedAccessToken: "encrypted:current-access",
      encryptedRefreshToken: "encrypted:current-refresh",
      encryptionKeyVersion: 7,
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }
    mockFindUnique.mockResolvedValueOnce(expired).mockResolvedValueOnce(current)
    mockRefreshTokens.mockResolvedValue({
      accessToken: "provider-access",
      refreshToken: "provider-refresh",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scopes: ["scope"],
    })
    mockUpdateMany.mockResolvedValue({ count: 0 })

    await expect(
      new IntegrationService().getActiveAccessToken("account-1"),
    ).resolves.toBe("current-access-token")

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "account-1",
          status: "ACTIVE",
          encryptionKeyVersion: 4,
          encryptedRefreshToken: "encrypted:old-refresh",
        },
        data: expect.objectContaining({ encryptionKeyVersion: 7 }),
      }),
    )
    expect(mockDecrypt).toHaveBeenCalledWith(
      "encrypted:current-access",
      7,
      "context:publisher-1:access",
    )
  })

  it("rejects inactive credentials before decrypting or refreshing", async () => {
    mockFindUnique.mockResolvedValue({
      id: "account-1",
      provider: "GOOGLE_SEARCH_CONSOLE",
      externalUserId: "google-user-1",
      ownerType: "PUBLISHER",
      ownerId: "publisher-1",
      status: "REVOKED",
      encryptedAccessToken: "encrypted:access",
      encryptedRefreshToken: "encrypted:refresh",
      encryptionKeyVersion: 4,
      tokenExpiresAt: new Date(Date.now() - 60_000),
    })

    await expect(
      new IntegrationService().getActiveAccessToken("account-1"),
    ).rejects.toThrow()
    expect(mockDecrypt).not.toHaveBeenCalled()
    expect(mockRefreshTokens).not.toHaveBeenCalled()
  })
})
