import { ActiveContextService } from "../active-context.service"

describe("ActiveContextService", () => {
  function createPrismaMock() {
    return {
      activeContext: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      user: { findUnique: jest.fn() },
      membership: { findFirst: jest.fn() },
      publisherMembership: { findFirst: jest.fn() },
    }
  }

  it("atomically creates a customer's initial context without overwriting a concurrent winner", async () => {
    const prisma = createPrismaMock()
    prisma.activeContext.findUnique.mockResolvedValue(null)
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      userType: "CUSTOMER",
    })
    prisma.membership.findFirst.mockResolvedValue({
      organizationId: "organization-1",
    })
    prisma.activeContext.upsert.mockResolvedValue({
      id: "context-1",
      userId: "user-1",
      activeOrganizationId: "organization-2",
      activePublisherId: null,
    })

    const service = new ActiveContextService(prisma as any)

    await expect(service.getOrCreate("user-1")).resolves.toMatchObject({
      activeOrganizationId: "organization-2",
    })
    expect(prisma.activeContext.upsert).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      create: {
        userId: "user-1",
        activeOrganizationId: "organization-1",
        activePublisherId: null,
      },
      update: {},
    })
  })

  it("atomically creates a publisher's initial context", async () => {
    const prisma = createPrismaMock()
    prisma.activeContext.findUnique.mockResolvedValue(null)
    prisma.user.findUnique.mockResolvedValue({
      id: "user-2",
      userType: "PUBLISHER",
    })
    prisma.publisherMembership.findFirst.mockResolvedValue({
      publisherId: "publisher-1",
    })
    prisma.activeContext.upsert.mockResolvedValue({
      id: "context-2",
      userId: "user-2",
      activeOrganizationId: null,
      activePublisherId: "publisher-1",
    })

    const service = new ActiveContextService(prisma as any)

    await expect(service.getOrCreate("user-2")).resolves.toMatchObject({
      activePublisherId: "publisher-1",
    })
    expect(prisma.activeContext.upsert).toHaveBeenCalledWith({
      where: { userId: "user-2" },
      create: {
        userId: "user-2",
        activeOrganizationId: null,
        activePublisherId: "publisher-1",
      },
      update: {},
    })
  })

  it("returns an existing context without deriving or writing a fallback", async () => {
    const prisma = createPrismaMock()
    const existing = {
      id: "context-3",
      userId: "user-3",
      activeOrganizationId: "organization-3",
      activePublisherId: null,
    }
    prisma.activeContext.findUnique.mockResolvedValue(existing)

    const service = new ActiveContextService(prisma as any)

    await expect(service.getOrCreate("user-3")).resolves.toBe(existing)
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
    expect(prisma.activeContext.upsert).not.toHaveBeenCalled()
  })
})
