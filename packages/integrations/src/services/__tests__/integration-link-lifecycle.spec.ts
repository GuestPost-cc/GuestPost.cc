const mockDb = {
  publisherIntegration: { findFirst: jest.fn() },
  website: { findFirst: jest.fn() },
  websiteIntegration: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
  },
}
const mockDiscoverResources = jest.fn()

jest.mock("@guestpost/database", () => ({
  createPrismaClient: () => mockDb,
}))
jest.mock("../../google-metrics-gate", () => ({
  assertGoogleMetricsEnabled: jest.fn(),
}))
jest.mock("../../providers", () => ({
  getProvider: () => ({
    discoveryProvider: { discoverResources: mockDiscoverResources },
  }),
}))

import { IntegrationOwnerType } from "../../types"
import { IntegrationService } from "../integration.service"

describe("WebsiteIntegration provenance lifecycle", () => {
  const owner = {
    ownerType: IntegrationOwnerType.PUBLISHER,
    ownerId: "publisher-1",
  }
  const tombstone = {
    id: "link-1",
    integrationId: "integration-1",
    websiteId: "website-1",
    externalResourceId: "https://publisher.example",
    externalResourceName: "publisher.example",
    status: "REMOVED",
    website: { id: "website-1", url: "https://publisher.example" },
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb.publisherIntegration.findFirst.mockResolvedValue({
      id: "integration-1",
      provider: "BING_WEBMASTER",
      connectionId: "account-1",
      connection: { id: "account-1" },
    })
    mockDb.website.findFirst.mockResolvedValue({
      id: "website-1",
      url: "https://publisher.example",
    })
    mockDb.websiteIntegration.findUnique.mockResolvedValue(tombstone)
    mockDb.websiteIntegration.findFirst.mockResolvedValue(null)
    mockDiscoverResources.mockResolvedValue([
      {
        externalResourceId: "https://publisher.example",
        externalResourceName: "Publisher Example",
        metadata: { permissionLevel: "owner" },
      },
    ])
  })

  it("reactivates only the exact tombstoned source identity with a CAS", async () => {
    mockDb.websiteIntegration.updateMany.mockResolvedValue({ count: 1 })
    const service = new IntegrationService()
    jest
      .spyOn(service as any, "getActiveAccessToken")
      .mockResolvedValue("access-token")

    await expect(
      service.linkProperty(
        owner,
        "integration-1",
        "website-1",
        "https://publisher.example",
      ),
    ).resolves.toEqual({
      externalResourceId: "https://publisher.example",
      externalResourceName: "Publisher Example",
      alreadyLinked: false,
      linkedWebsiteId: "website-1",
      linkedWebsiteUrl: "https://publisher.example",
    })

    expect(mockDb.websiteIntegration.updateMany).toHaveBeenCalledWith({
      where: {
        id: "link-1",
        integrationId: "integration-1",
        websiteId: "website-1",
        externalResourceId: "https://publisher.example",
        status: "REMOVED",
      },
      data: {
        externalResourceName: "Publisher Example",
        metadata: { permissionLevel: "owner" },
        status: "CONNECTED",
        syncedAt: null,
      },
    })
    expect(mockDb.websiteIntegration.create).not.toHaveBeenCalled()
  })

  it("treats a concurrent exact reactivation as already linked", async () => {
    mockDb.websiteIntegration.findUnique
      .mockResolvedValueOnce(tombstone)
      .mockResolvedValueOnce({ ...tombstone, status: "CONNECTED" })
    mockDb.websiteIntegration.updateMany.mockResolvedValue({ count: 0 })
    const service = new IntegrationService()
    jest
      .spyOn(service as any, "getActiveAccessToken")
      .mockResolvedValue("access-token")

    await expect(
      service.linkProperty(
        owner,
        "integration-1",
        "website-1",
        "https://publisher.example",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        externalResourceId: "https://publisher.example",
        alreadyLinked: true,
        linkedWebsiteId: "website-1",
      }),
    )
    expect(mockDb.websiteIntegration.create).not.toHaveBeenCalled()
  })
})
