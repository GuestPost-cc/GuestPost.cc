const mockDecrypt = jest.fn()
const mockRevokeToken = jest.fn()
const mockGetProvider = jest.fn()

const mockDb = {
  publisherIntegration: {
    findFirst: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
  },
  integrationSchedule: { updateMany: jest.fn() },
  websiteIntegration: { updateMany: jest.fn() },
  externalAccount: { update: jest.fn() },
  $queryRaw: jest.fn(),
  $transaction: jest.fn(),
}

jest.mock("@guestpost/database", () => ({
  createPrismaClient: () => mockDb,
}))
jest.mock("../../adapters/encryption.adapter", () => ({
  IntegrationEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: mockDecrypt,
  })),
  integrationTokenEncryptionContext: jest.fn(
    (identity: { ownerId: string }, purpose: string) =>
      `context:${identity.ownerId}:${purpose}`,
  ),
}))
jest.mock("../../google-metrics-gate", () => ({
  assertGoogleMetricsEnabled: jest.fn(),
}))
jest.mock("../../providers", () => ({
  getProvider: mockGetProvider,
}))

import { IntegrationOwnerType } from "../../types"
import { IntegrationService } from "../integration.service"

describe("integration disconnect credential lifecycle", () => {
  const owner = {
    ownerType: IntegrationOwnerType.PUBLISHER,
    ownerId: "publisher-1",
  }
  const integration = {
    id: "integration-ga-1",
    ownerType: "PUBLISHER",
    ownerId: "publisher-1",
    provider: "GOOGLE_ANALYTICS",
    connectionId: "account-1",
    status: "ACTIVE",
    connection: {
      id: "account-1",
      // OAuth belongs to the shared credential, not necessarily the service
      // integration being disconnected.
      provider: "GOOGLE",
      externalUserId: "google-user-1",
      ownerType: "PUBLISHER",
      ownerId: "publisher-1",
      status: "ACTIVE",
      encryptedAccessToken: "encrypted-access-token",
      encryptionKeyVersion: 7,
    },
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb.publisherIntegration.findFirst.mockResolvedValue(integration)
    mockDb.publisherIntegration.count.mockResolvedValue(0)
    mockDb.publisherIntegration.updateMany.mockResolvedValue({ count: 1 })
    mockDb.integrationSchedule.updateMany.mockResolvedValue({ count: 1 })
    mockDb.websiteIntegration.updateMany.mockResolvedValue({ count: 1 })
    mockDb.externalAccount.update.mockResolvedValue({})
    mockDb.$queryRaw.mockResolvedValue([{ id: "account-1" }])
    mockDb.$transaction.mockImplementation(
      async (callback: (tx: typeof mockDb) => unknown) => callback(mockDb),
    )
    mockDecrypt.mockReturnValue({ value: "access-token" })
    mockRevokeToken.mockResolvedValue(undefined)
    mockGetProvider.mockReturnValue({
      oauthProvider: { revokeToken: mockRevokeToken },
    })
  })

  it("keeps a shared credential active while a non-disconnected sibling uses it", async () => {
    mockDb.publisherIntegration.count.mockResolvedValue(1)

    await expect(
      new IntegrationService().disconnect(owner, integration.id),
    ).resolves.toBeUndefined()

    expect(mockDb.publisherIntegration.count).toHaveBeenCalledWith({
      where: {
        connectionId: "account-1",
        id: { not: "integration-ga-1" },
        status: { not: "DISCONNECTED" },
      },
    })
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1)
    expect(mockDb.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.publisherIntegration.count.mock.invocationCallOrder[0],
    )
    expect(mockDecrypt).not.toHaveBeenCalled()
    expect(mockRevokeToken).not.toHaveBeenCalled()
    expect(mockDb.externalAccount.update).not.toHaveBeenCalled()
    expect(mockDb.publisherIntegration.updateMany).toHaveBeenCalledWith({
      where: {
        id: "integration-ga-1",
        ownerType: IntegrationOwnerType.PUBLISHER,
        ownerId: "publisher-1",
        connectionId: "account-1",
      },
      data: { status: "DISCONNECTED" },
    })
  })

  it("revokes the shared provider credential before committing the last disconnect", async () => {
    await expect(
      new IntegrationService().disconnect(owner, integration.id),
    ).resolves.toBeUndefined()

    expect(mockGetProvider).toHaveBeenCalledWith("GOOGLE_SEARCH_CONSOLE")
    expect(mockDecrypt).toHaveBeenCalledWith(
      "encrypted-access-token",
      7,
      "context:publisher-1:access",
    )
    expect(mockRevokeToken).toHaveBeenCalledWith("access-token")
    expect(mockRevokeToken.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.publisherIntegration.updateMany.mock.invocationCallOrder[0],
    )
    expect(mockDb.externalAccount.update).toHaveBeenCalledWith({
      where: { id: "account-1" },
      data: { status: "REVOKED" },
    })
    expect(mockDb.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 30_000,
    })
  })

  it("surfaces decryption failure without reporting or recording a disconnect", async () => {
    const decryptionFailure = new Error("ciphertext authentication failed")
    mockDecrypt.mockImplementation(() => {
      throw decryptionFailure
    })

    await expect(
      new IntegrationService().disconnect(owner, integration.id),
    ).rejects.toBe(decryptionFailure)

    expect(mockRevokeToken).not.toHaveBeenCalled()
    expect(mockDb.publisherIntegration.updateMany).not.toHaveBeenCalled()
    expect(mockDb.integrationSchedule.updateMany).not.toHaveBeenCalled()
    expect(mockDb.websiteIntegration.updateMany).not.toHaveBeenCalled()
    expect(mockDb.externalAccount.update).not.toHaveBeenCalled()
  })

  it("surfaces provider revocation failure without committing the disconnect", async () => {
    const providerFailure = new Error("provider did not confirm revocation")
    mockRevokeToken.mockRejectedValue(providerFailure)

    await expect(
      new IntegrationService().disconnect(owner, integration.id),
    ).rejects.toBe(providerFailure)

    expect(mockDb.publisherIntegration.updateMany).not.toHaveBeenCalled()
    expect(mockDb.integrationSchedule.updateMany).not.toHaveBeenCalled()
    expect(mockDb.websiteIntegration.updateMany).not.toHaveBeenCalled()
    expect(mockDb.externalAccount.update).not.toHaveBeenCalled()
  })
})
