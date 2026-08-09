const mockDecrypt = jest.fn()
const mockDiscoverResources = jest.fn()

const mockDb = {
  externalAccount: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  publisherIntegration: {
    findFirst: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  integrationSchedule: {
    findUnique: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  websiteIntegration: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
}

jest.mock("@guestpost/database", () => ({
  createPrismaClient: () => mockDb,
}))
jest.mock("@guestpost/shared/dist/job-signing", () => ({
  signJobPayload: (payload: unknown) => payload,
}))
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    getJob: jest.fn(),
  })),
}))
jest.mock("../../adapters/encryption.adapter", () => ({
  IntegrationEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: mockDecrypt,
  })),
  integrationTokenEncryptionContext: jest.fn(() => "token-context"),
}))
jest.mock("../../google-metrics-gate", () => ({
  // This suite exercises the dormant reconnect path. The production gate has
  // dedicated fail-closed coverage in google-metrics-services.spec.ts.
  assertGoogleMetricsEnabled: jest.fn(),
}))
jest.mock("../../providers", () => ({
  getProvider: () => ({
    discoveryProvider: { discoverResources: mockDiscoverResources },
  }),
}))
jest.mock("../../redis", () => ({
  createIntegrationQueueConnection: () => ({}),
}))
jest.mock("../../worker-wakeup", () => ({ wakeOnDemandWorker: jest.fn() }))

import { DiscoveryService } from "../discovery.service"

describe("integration discovery reconnect lifecycle", () => {
  const account = {
    id: "account-1",
    provider: "GOOGLE_SEARCH_CONSOLE",
    externalUserId: "google-user-1",
    ownerType: "PUBLISHER",
    ownerId: "publisher-1",
    status: "ACTIVE",
    encryptedAccessToken: "encrypted-access-token",
    encryptionKeyVersion: 7,
    grantedScopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  }
  const disconnected = {
    id: "integration-1",
    ownerType: "PUBLISHER",
    ownerId: "publisher-1",
    provider: "GOOGLE_SEARCH_CONSOLE",
    connectionId: "account-1",
    status: "DISCONNECTED",
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb.externalAccount.findUnique.mockResolvedValue(account)
    mockDb.externalAccount.update.mockResolvedValue({})
    mockDb.publisherIntegration.findFirst.mockResolvedValue(disconnected)
    mockDb.publisherIntegration.updateMany.mockResolvedValue({ count: 1 })
    mockDb.integrationSchedule.findUnique.mockResolvedValue({
      id: "schedule-1",
      integrationId: "integration-1",
      enabled: false,
    })
    mockDb.integrationSchedule.updateMany.mockResolvedValue({ count: 1 })
    mockDb.websiteIntegration.findMany.mockResolvedValue([])
    mockDecrypt.mockReturnValue({ value: "access-token" })
    mockDiscoverResources.mockResolvedValue([
      {
        externalResourceId: "sc-domain:publisher.example",
        externalResourceName: "publisher.example",
      },
    ])
  })

  it("reactivates only the exact owner, provider, and credential aggregate", async () => {
    await expect(
      new DiscoveryService().processDiscoveryJob({
        externalAccountId: "account-1",
        ownerType: "PUBLISHER",
        ownerId: "publisher-1",
      }),
    ).resolves.toEqual({
      success: true,
      gsc: { found: 1, created: 0 },
      analytics: undefined,
    })

    expect(mockDb.publisherIntegration.findFirst).toHaveBeenCalledWith({
      where: {
        ownerType: "PUBLISHER",
        ownerId: "publisher-1",
        provider: "GOOGLE_SEARCH_CONSOLE",
        connectionId: "account-1",
      },
    })
    expect(mockDb.publisherIntegration.updateMany).toHaveBeenCalledWith({
      where: {
        id: "integration-1",
        ownerType: "PUBLISHER",
        ownerId: "publisher-1",
        provider: "GOOGLE_SEARCH_CONSOLE",
        connectionId: "account-1",
        status: "DISCONNECTED",
      },
      data: { status: "ACTIVE" },
    })
    expect(mockDb.publisherIntegration.create).not.toHaveBeenCalled()
    expect(mockDb.integrationSchedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: "schedule-1",
        integrationId: "integration-1",
        enabled: false,
      },
      data: {
        enabled: true,
        nextRunAt: expect.any(Date),
        version: { increment: 1 },
      },
    })
    expect(mockDb.websiteIntegration.findMany).toHaveBeenCalledWith({
      where: {
        integrationId: "integration-1",
        status: { not: "REMOVED" },
      },
    })
  })

  it("fails closed if a concurrent reconnect does not leave the exact aggregate active", async () => {
    mockDb.publisherIntegration.findFirst
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValueOnce({ ...disconnected, status: "ERROR" })
    mockDb.publisherIntegration.updateMany.mockResolvedValue({ count: 0 })

    await expect(
      new DiscoveryService().processDiscoveryJob({
        externalAccountId: "account-1",
        ownerType: "PUBLISHER",
        ownerId: "publisher-1",
      }),
    ).resolves.toEqual({
      success: false,
      error: "Integration not found",
    })

    expect(mockDb.integrationSchedule.findUnique).not.toHaveBeenCalled()
    expect(mockDb.websiteIntegration.findMany).not.toHaveBeenCalled()
  })
})
