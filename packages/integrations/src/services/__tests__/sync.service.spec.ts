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

  it("rejects new sync jobs before creating records or queue messages", async () => {
    mockDb.publisherIntegration.findFirst.mockResolvedValue({
      id: "integration-1",
      websiteIntegrations: [{ id: "link-1" }],
    })
    mockDb.integrationSync.create.mockResolvedValue({ id: "sync-1" })

    await expect(
      new SyncService().triggerSync(owner, "integration-1"),
    ).rejects.toMatchObject({ code: "GOOGLE_METRICS_DISABLED" })

    expect(mockDb.publisherIntegration.findFirst).not.toHaveBeenCalled()
    expect(mockDb.integrationSync.create).not.toHaveBeenCalled()
    expect(mockQueueAdd).not.toHaveBeenCalled()
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

  it("quarantines stale queued syncs before credential or provider access", async () => {
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

    const result = await new SyncService().processSyncJob({
      integrationId: "integration-1",
      websiteIntegrationId: "link-1",
    })

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        recordsProcessed: 0,
        error: expect.stringContaining("temporarily disabled"),
      }),
    )
    expect(mockDb.integrationSync.findFirst).not.toHaveBeenCalled()
    expect(mockDb.publisherIntegration.findFirst).not.toHaveBeenCalled()
    expect(mockProviderSync).not.toHaveBeenCalled()
    expect(mockDb.websiteIntegration.update).not.toHaveBeenCalled()
  })
})
