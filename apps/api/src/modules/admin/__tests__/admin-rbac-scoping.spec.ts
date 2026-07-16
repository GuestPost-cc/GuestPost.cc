import { ForbiddenException } from "@nestjs/common"
import { AdminService } from "../admin.service"

describe("AdminService RBAC scoping", () => {
  let prisma: any
  let audit: any
  let service: AdminService

  beforeEach(() => {
    prisma = {
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
      marketplaceListing: { create: jest.fn() },
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

  it("always assigns an Operations-enlisted site to its creator", async () => {
    await service.createPlatformWebsite(
      {
        url: "https://ops-example.com",
        managedByUserId: "ops-2",
      },
      { id: "ops-1", staffRole: "OPERATIONS" },
    )

    expect(prisma.staffMembership.findUnique).not.toHaveBeenCalled()
    expect(prisma.website.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ managedByUserId: "ops-1" }),
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ managedByUserId: "ops-1" }),
      }),
    )
  })

  it("blocks Operations from mutating another operator's site", async () => {
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
})
