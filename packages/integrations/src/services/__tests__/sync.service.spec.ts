const mockQueueAdd = jest.fn().mockResolvedValue(undefined)
const mockProviderSync = jest.fn().mockResolvedValue({
  success: true,
  recordsProcessed: 1,
  syncedAt: new Date("2026-07-18T00:00:00.000Z"),
  durationMs: 5,
})
const mockDb = {
  publisherIntegration: { findFirst: jest.fn() },
  integrationSync: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  websiteIntegration: { update: jest.fn() },
  integrationSchedule: { updateMany: jest.fn() },
}

jest.mock("@guestpost/database", () => ({
  createPrismaClient: () => mockDb,
}))
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockQueueAdd })),
}))
jest.mock("../../redis", () => ({
  createIntegrationQueueConnection: () => ({}),
}))
jest.mock("../../adapters/encryption.adapter", () => ({
  IntegrationEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: () => ({ value: "access-token" }),
  })),
}))
jest.mock("../../providers", () => ({
  getProvider: () => ({ syncProvider: { sync: mockProviderSync } }),
}))

import { IntegrationOwnerType } from "../../types"
import { SyncService } from "../sync.service"

describe("SyncService ownership and mapping scope", () => {
  const owner = {
    ownerType: IntegrationOwnerType.PLATFORM,
    ownerId: "guestpost.cc",
  }

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.QUEUE_SIGNING_SECRET = "integration-test-signing-secret"
    mockDb.integrationSync.update.mockResolvedValue({})
    mockDb.websiteIntegration.update.mockResolvedValue({})
    mockDb.integrationSchedule.updateMany.mockResolvedValue({ count: 1 })
  })

  it("signs queued sync jobs before Redis accepts them", async () => {
    mockDb.publisherIntegration.findFirst.mockResolvedValue({
      id: "integration-1",
      websiteIntegrations: [{ id: "link-1" }],
    })
    mockDb.integrationSync.create.mockResolvedValue({ id: "sync-1" })

    await new SyncService().triggerSync(owner, "integration-1")

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "sync",
      expect.objectContaining({
        integrationId: "integration-1",
        signature: expect.stringMatching(/^[0-9a-f]{64}$/),
        iat: expect.any(Number),
        v: 1,
      }),
    )
  })

  it("authorizes sync-status reads through the owning integration", async () => {
    mockDb.integrationSync.findFirst.mockResolvedValue({
      id: "sync-1",
      integrationId: "integration-1",
      websiteIntegrationId: "link-1",
      jobType: "SYNC",
      status: "COMPLETED",
      trigger: "MANUAL",
      recordsProcessed: 3,
      itemsCompleted: 1,
      itemsTotal: 1,
      errorMessage: null,
      startedAt: new Date("2026-07-18T00:00:00.000Z"),
      completedAt: new Date("2026-07-18T00:01:00.000Z"),
    })

    await new SyncService().getSyncStatus(owner, "sync-1")

    expect(mockDb.integrationSync.findFirst).toHaveBeenCalledWith({
      where: {
        id: "sync-1",
        integration: {
          ownerType: "PLATFORM",
          ownerId: "guestpost.cc",
        },
      },
    })
  })

  it("passes the exact website integration id to every provider sync", async () => {
    mockDb.integrationSync.findFirst.mockResolvedValueOnce({ id: "sync-1" })
    mockDb.publisherIntegration.findFirst.mockResolvedValue({
      id: "integration-1",
      provider: "GOOGLE_SEARCH_CONSOLE",
      connection: { encryptedAccessToken: "ciphertext" },
      websiteIntegrations: [
        { id: "link-1", externalResourceId: "sc-domain:one.example" },
        { id: "link-2", externalResourceId: "sc-domain:two.example" },
      ],
    })

    await new SyncService().processSyncJob({ integrationId: "integration-1" })

    expect(mockDb.publisherIntegration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          websiteIntegrations: {
            where: { status: { in: ["CONNECTED", "OUT_OF_SYNC"] } },
          },
        }),
      }),
    )
    expect(mockProviderSync).toHaveBeenNthCalledWith(
      1,
      "access-token",
      "sc-domain:one.example",
      undefined,
      undefined,
      "link-1",
    )
    expect(mockProviderSync).toHaveBeenNthCalledWith(
      2,
      "access-token",
      "sc-domain:two.example",
      undefined,
      undefined,
      "link-2",
    )
  })
})
