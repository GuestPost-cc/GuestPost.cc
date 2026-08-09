const mockDb = {
  externalAccount: { findFirst: jest.fn(), findUnique: jest.fn() },
  publisherIntegration: { findFirst: jest.fn() },
  websiteIntegration: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
}
const mockQueueAdd = jest.fn()

jest.mock("@guestpost/database", () => ({
  createPrismaClient: () => mockDb,
}))
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    getJob: jest.fn(),
  })),
}))
jest.mock("../../redis", () => ({
  createIntegrationQueueConnection: () => ({}),
}))
jest.mock("../../worker-wakeup", () => ({ wakeOnDemandWorker: jest.fn() }))

import { IntegrationOwnerType } from "../../types"
import { DiscoveryService } from "../discovery.service"
import { IntegrationService } from "../integration.service"

describe("Google metric service quarantine", () => {
  const owner = {
    ownerType: IntegrationOwnerType.PUBLISHER,
    ownerId: "publisher-1",
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("blocks OAuth, resource listing, linking, and discovery before side effects", async () => {
    const service = new IntegrationService()

    await expect(
      service.initiateOAuth(owner, "GOOGLE_SEARCH_CONSOLE", "/return", "nonce"),
    ).rejects.toMatchObject({ code: "GOOGLE_METRICS_DISABLED" })
    await expect(
      service.handleOAuthCallback(owner, "GOOGLE_SEARCH_CONSOLE", "code"),
    ).rejects.toMatchObject({ code: "GOOGLE_METRICS_DISABLED" })
    await expect(
      service.listResources(owner, "integration-1"),
    ).rejects.toMatchObject({ code: "GOOGLE_METRICS_DISABLED" })
    await expect(
      service.linkProperty(
        owner,
        "integration-1",
        "website-1",
        "sc-domain:other.example",
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_METRICS_DISABLED" })
    await expect(
      service.discover(owner, "integration-1"),
    ).rejects.toMatchObject({ code: "GOOGLE_METRICS_DISABLED" })

    expect(mockDb.publisherIntegration.findFirst).not.toHaveBeenCalled()
    expect(mockDb.externalAccount.findFirst).not.toHaveBeenCalled()
  })

  it("blocks newly enqueued and stale discovery jobs without credential access", async () => {
    const service = new DiscoveryService()

    await expect(
      service.enqueueDiscovery(owner, "account-1"),
    ).rejects.toMatchObject({ code: "GOOGLE_METRICS_DISABLED" })
    expect(
      await service.processDiscoveryJob({
        externalAccountId: "account-1",
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      }),
    ).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining("temporarily disabled"),
      }),
    )

    expect(mockDb.externalAccount.findFirst).not.toHaveBeenCalled()
    expect(mockDb.externalAccount.findUnique).not.toHaveBeenCalled()
    expect(mockQueueAdd).not.toHaveBeenCalled()
  })

  it("tombstones an owned link so daily metric source provenance survives unlink", async () => {
    mockDb.publisherIntegration.findFirst.mockResolvedValue({
      id: "integration-1",
      connection: { id: "account-1" },
    })
    mockDb.websiteIntegration.findFirst.mockResolvedValue({
      id: "link-1",
      status: "CONNECTED",
    })
    mockDb.websiteIntegration.updateMany.mockResolvedValue({ count: 1 })

    const service = new IntegrationService()
    await service.unlinkProperty(owner, "integration-1", "link-1")

    expect(mockDb.publisherIntegration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "integration-1",
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
        }),
      }),
    )
    expect(mockDb.websiteIntegration.updateMany).toHaveBeenCalledWith({
      where: {
        id: "link-1",
        integrationId: "integration-1",
        status: { not: "REMOVED" },
      },
      data: { status: "REMOVED", syncedAt: null },
    })
  })
})
