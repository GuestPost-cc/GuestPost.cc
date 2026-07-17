import { ForbiddenException } from "@nestjs/common"
import { MarketplaceService } from "../../marketplace/marketplace.service"
import { AdminService } from "../admin.service"

describe("AdminService RBAC scoping", () => {
  let prisma: any
  let audit: any
  let service: AdminService

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(async (callback: (tx: any) => unknown) =>
        callback(prisma),
      ),
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      website: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: "site-1" }),
        update: jest.fn(),
      },
      marketplaceListing: {
        create: jest.fn().mockResolvedValue({ id: "listing-1" }),
        findUnique: jest.fn(),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      staffMembership: { findUnique: jest.fn() },
    }
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    service = new AdminService(prisma, audit, {} as any)
  })

  it("limits an Operations platform-order list to self-assigned or claimable work", async () => {
    await service.listPlatformOrders("SUBMITTED", 20, 10, {
      id: "ops-1",
      staffRole: "OPERATIONS",
    })

    const where = prisma.order.findMany.mock.calls[0][0].where
    expect(where.status).toBe("SUBMITTED")
    expect(where.AND).toEqual([
      {
        OR: [
          {
            fulfillmentAssignments: {
              some: {
                status: { in: ["ASSIGNED", "IN_PROGRESS"] },
                assignedToUserId: "ops-1",
              },
            },
          },
          {
            AND: [
              {
                status: {
                  in: [
                    "SUBMITTED",
                    "ACCEPTED",
                    "CONTENT_REQUESTED",
                    "CONTENT_CREATION",
                    "CONTENT_READY",
                    "CUSTOMER_REVIEW",
                    "APPROVED",
                  ],
                },
              },
              {
                fulfillmentAssignments: {
                  none: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
                },
              },
            ],
          },
        ],
      },
    ])
    expect(prisma.order.count).toHaveBeenCalledWith({ where })
  })

  it("auto-assigns an Operations-created website and listing to its creator", async () => {
    prisma.website.create.mockResolvedValue({
      id: "site-1",
      url: "https://ops-example.com",
    })

    await service.createPlatformWebsite(
      {
        url: "https://ops-example.com",
        managedByUserId: "ops-2",
      },
      { id: "ops-1", staffRole: "OPERATIONS" },
    )

    expect(prisma.staffMembership.findUnique).not.toHaveBeenCalled()
    expect(prisma.website.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownershipType: "PLATFORM",
        managedByUserId: "ops-1",
      }),
    })
    expect(prisma.marketplaceListing.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        websiteId: "site-1",
        ownerType: "PLATFORM",
      }),
    })
  })

  it("creates the platform website and its only listing atomically", async () => {
    prisma.website.create.mockResolvedValue({
      id: "site-1",
      url: "https://platform-example.com",
    })

    await service.createPlatformWebsite(
      { url: "https://platform-example.com" },
      { id: "admin-1", staffRole: "SUPER_ADMIN" },
    )

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.website.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        domain: "platform-example.com",
        canonicalDomain: "platform-example.com",
        ownershipType: "PLATFORM",
        verificationStatus: "VERIFIED",
      }),
    })
    expect(prisma.marketplaceListing.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        websiteId: "site-1",
        ownerType: "PLATFORM",
        status: "DRAFT",
      }),
    })
  })

  it("blocks Operations from editing platform website inventory", async () => {
    prisma.website.findUnique.mockResolvedValue({
      id: "site-2",
      ownershipType: "PLATFORM",
      managedByUserId: "ops-2",
    })

    await expect(
      service.updatePlatformWebsite(
        "site-2",
        { name: "Not mine" },
        { id: "ops-1", staffRole: "OPERATIONS" },
      ),
    ).rejects.toThrow(ForbiddenException)
    expect(prisma.website.update).not.toHaveBeenCalled()
  })

  it("limits Operations listing writes to moderation transitions", async () => {
    await expect(
      service.updateListingStatus("listing-1", "ARCHIVED", {
        id: "ops-1",
        staffRole: "OPERATIONS",
      }),
    ).rejects.toThrow(ForbiddenException)
  })

  it("allows Operations to edit services on an assigned platform website", async () => {
    prisma.marketplaceListing.findUnique.mockResolvedValue({
      id: "listing-1",
      publisherId: null,
      organizationId: null,
      ownerType: "PLATFORM",
      websiteId: "site-1",
    })
    prisma.listingService = {
      create: jest.fn().mockResolvedValue({
        id: "service-1",
        serviceType: "GUEST_POST",
        price: { toString: () => "100" },
      }),
    }
    prisma.website.findFirst.mockResolvedValue({ id: "site-1" })
    const marketplace = new MarketplaceService(prisma, {} as any)

    await marketplace.addServiceToListing(
      {
        userId: "ops-1",
        isStaff: true,
        staffRole: "OPERATIONS",
      },
      "listing-1",
      {
        serviceType: "GUEST_POST",
        price: 100,
        turnaroundDays: 7,
      },
    )

    expect(prisma.website.findFirst).toHaveBeenCalledWith({
      where: {
        id: "site-1",
        ownershipType: "PLATFORM",
        managedByUserId: "ops-1",
      },
      select: { id: true },
    })
    expect(prisma.listingService.create).toHaveBeenCalled()
  })

  it("blocks Operations from publisher and unassigned platform services", async () => {
    prisma.listingService = { create: jest.fn() }
    const marketplace = new MarketplaceService(prisma, {} as any)

    prisma.marketplaceListing.findUnique.mockResolvedValueOnce({
      id: "publisher-listing",
      publisherId: "publisher-1",
      organizationId: "org-1",
      ownerType: "PUBLISHER",
      websiteId: "publisher-site",
    })
    await expect(
      marketplace.addServiceToListing(
        {
          userId: "ops-1",
          isStaff: true,
          staffRole: "OPERATIONS",
        },
        "publisher-listing",
        {
          serviceType: "GUEST_POST",
          price: 100,
          turnaroundDays: 7,
        },
      ),
    ).rejects.toThrow(ForbiddenException)

    prisma.marketplaceListing.findUnique.mockResolvedValueOnce({
      id: "platform-listing",
      publisherId: null,
      organizationId: null,
      ownerType: "PLATFORM",
      websiteId: "site-2",
    })
    prisma.website.findFirst.mockResolvedValue(null)
    await expect(
      marketplace.addServiceToListing(
        {
          userId: "ops-1",
          isStaff: true,
          staffRole: "OPERATIONS",
        },
        "platform-listing",
        {
          serviceType: "GUEST_POST",
          price: 100,
          turnaroundDays: 7,
        },
      ),
    ).rejects.toThrow(ForbiddenException)

    expect(prisma.listingService.create).not.toHaveBeenCalled()
  })
})
