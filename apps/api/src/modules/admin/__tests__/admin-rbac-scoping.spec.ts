import { ForbiddenException, NotFoundException } from "@nestjs/common"
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
        findFirst: jest.fn().mockResolvedValue(null),
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
      websiteMetric: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "metric-1" }),
      },
      websiteMetricRevision: { create: jest.fn() },
      marketplaceCategory: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: "category-1", name: "Technology", slug: "technology" },
          ]),
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

  it("scopes the shared Operations order monitor to assigned or contextual work", async () => {
    await service.listOrders({
      take: 20,
      skip: 0,
      user: { id: "ops-1", staffRole: "OPERATIONS" },
    })

    const where = prisma.order.findMany.mock.calls[0][0].where
    const select = prisma.order.findMany.mock.calls[0][0].select
    const scope = where.AND[0]
    expect(JSON.stringify(where)).toContain("ops-1")
    expect(scope.OR).toEqual(
      expect.arrayContaining([
        { tickets: { some: { assignedToUserId: "ops-1" } } },
        {
          activeDeliveryVersion: {
            is: {
              verificationStatus: { in: ["FAILED", "MANUAL_REVIEW"] },
            },
          },
        },
      ]),
    )
    expect(select.customer.select).toEqual({ id: true, name: true })
    expect(select.organization.select).toEqual({ id: true, name: true })
  })

  it("redacts customer contact and settlement context from Operations order rows", async () => {
    prisma.order.findMany.mockResolvedValue([
      {
        id: "order-1",
        version: 2,
        type: "GUEST_POST",
        title: "Protected order",
        status: "SUBMITTED",
        paymentStatus: "PAID",
        amount: 250,
        currency: "USD",
        fulfillmentChannel: "PLATFORM",
        fulfillmentDueAt: null,
        autoAcceptAt: null,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-02T00:00:00.000Z"),
        organization: { id: "org-1", name: "Client org" },
        customer: {
          id: "customer-1",
          name: "Customer",
          email: "protected@example.com",
        },
        website: null,
        activeDeliveryVersion: null,
        fulfillmentAssignments: [],
        dispute: null,
        cancellationRequests: [],
        settlements: [
          { id: "settlement-1", status: "PENDING", reviewEndsAt: null },
        ],
      },
    ])

    const result = await service.listOrders({
      user: { id: "ops-1", staffRole: "OPERATIONS" },
    })

    expect(result.items[0].customer).toEqual({
      id: "customer-1",
      name: "Customer",
    })
    expect(result.items[0].settlement).toBeNull()
    expect(
      prisma.order.findMany.mock.calls[0][0].select.customer.select,
    ).toEqual({ id: true, name: true })
  })

  it("keeps customer email available only in the Super Admin order monitor", async () => {
    await service.listOrders({
      user: { id: "admin-1", staffRole: "SUPER_ADMIN" },
    })

    expect(
      prisma.order.findMany.mock.calls[0][0].select.customer.select,
    ).toEqual({ id: true, name: true, email: true })
  })

  it("returns not found when Operations guesses an unrelated order id", async () => {
    await expect(
      service.getOrder("unrelated-order", {
        id: "ops-1",
        staffRole: "OPERATIONS",
      }),
    ).rejects.toBeInstanceOf(NotFoundException)

    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "unrelated-order",
          AND: expect.any(Array),
        }),
      }),
    )
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
        listingTitle: "Operations example listing",
        description: "A complete platform listing description.",
        categoryIds: ["category-1"],
        language: "English",
        sportsGamingAllowed: false,
        pharmacyAllowed: false,
        cryptoAllowed: false,
        backlinkCount: 1,
        linkType: "DOFOLLOW",
        linkValidity: "PERMANENT",
        googleNews: false,
        markedSponsored: false,
        foreignLanguageAllowed: false,
        manualMetrics: {
          ahrefsOrganicTraffic: 1200,
          ahrefsTrafficAsOf: new Date().toISOString().slice(0, 10),
          mozDomainAuthority: 45,
          mozDomainAuthorityAsOf: new Date().toISOString().slice(0, 10),
        },
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
      {
        url: "https://platform-example.com",
        listingTitle: "Platform example listing",
        description: "A complete platform listing description.",
        categoryIds: ["category-1"],
        language: "English",
        sportsGamingAllowed: false,
        pharmacyAllowed: false,
        cryptoAllowed: false,
        backlinkCount: 1,
        linkType: "DOFOLLOW",
        linkValidity: "PERMANENT",
        googleNews: false,
        markedSponsored: false,
        foreignLanguageAllowed: false,
        manualMetrics: {
          ahrefsOrganicTraffic: 1200,
          ahrefsTrafficAsOf: new Date().toISOString().slice(0, 10),
          mozDomainAuthority: 45,
          mozDomainAuthorityAsOf: new Date().toISOString().slice(0, 10),
        },
      },
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
