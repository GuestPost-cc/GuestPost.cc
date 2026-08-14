import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common"
import { OrderFulfillmentAssignmentService } from "../order-fulfillment-assignment.service"

describe("OrderFulfillmentAssignmentService", () => {
  let service: OrderFulfillmentAssignmentService
  let prisma: any
  let audit: any
  let cancellation: any
  let communications: any

  const platformOrder = {
    id: "order-1",
    organizationId: "org-1",
    status: "SUBMITTED",
    version: 1,
    fulfillmentChannel: "PLATFORM",
    website: { ownershipType: "PLATFORM" },
  }

  beforeEach(() => {
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    cancellation = {
      assertNoActiveCancellation: jest.fn().mockResolvedValue(undefined),
    }
    communications = {
      record: jest.fn().mockResolvedValue({ eventId: "communication-1" }),
      dispatchManyBestEffort: jest.fn(),
    }
    prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(platformOrder),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      staffMembership: { findUnique: jest.fn() },
      fulfillmentAssignment: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      auditLog: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(),
    }
    service = new OrderFulfillmentAssignmentService(
      prisma,
      audit,
      cancellation,
      communications,
    )
  })

  it("scopes the Operations queue to self-assigned and unassigned orders", async () => {
    await service.operationsQueue({ id: "ops-1", staffRole: "OPERATIONS" })

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
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
                  fulfillmentAssignments: {
                    none: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
                  },
                },
              ],
            },
          ],
        }),
      }),
    )
  })

  it("does not scope the Super Admin fulfillment queue", async () => {
    await service.operationsQueue({
      id: "admin-1",
      staffRole: "SUPER_ADMIN",
    })

    const query = prisma.order.findMany.mock.calls[0][0]
    expect(query.where.AND).toBeUndefined()
  })

  it("rejects assignment to Finance or banned Operations staff", async () => {
    prisma.staffMembership.findUnique
      .mockResolvedValueOnce({ role: "FINANCE", user: { banned: false } })
      .mockResolvedValueOnce({ role: "OPERATIONS", user: { banned: true } })

    await expect(
      service.assign("order-1", "finance-1", "admin-1"),
    ).rejects.toThrow(BadRequestException)
    await expect(
      service.assign("order-1", "banned-ops", "admin-1"),
    ).rejects.toThrow(BadRequestException)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("creates a claim without cancelling another active assignment", async () => {
    prisma.staffMembership.findUnique.mockResolvedValue({
      role: "OPERATIONS",
      user: { banned: false },
    })
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "order-1" }]),
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      staffMembership: {
        findUnique: jest.fn().mockResolvedValue({
          role: "OPERATIONS",
          user: { banned: false },
        }),
      },
      ticket: { findMany: jest.fn().mockResolvedValue([]) },
      fulfillmentAssignment: {
        create: jest.fn().mockResolvedValue({ id: "assignment-1" }),
        updateMany: jest.fn(),
      },
    }
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    )

    await service.claim("order-1", "ops-1", "OPERATIONS")

    expect(tx.fulfillmentAssignment.updateMany).not.toHaveBeenCalled()
    expect(tx.fulfillmentAssignment.create).toHaveBeenCalledWith({
      data: {
        orderId: "order-1",
        assignedToUserId: "ops-1",
        assignedByUserId: "ops-1",
        status: "ASSIGNED",
      },
    })
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", version: 1, status: "SUBMITTED" },
      data: { assigneeId: "ops-1", version: { increment: 1 } },
    })
  })

  it("rejects Super Admin self-claim before reading or mutating an order", async () => {
    await expect(
      service.claim("order-1", "admin-1", "SUPER_ADMIN"),
    ).rejects.toThrow(ForbiddenException)
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("rolls a claim back when the order changed concurrently", async () => {
    prisma.staffMembership.findUnique.mockResolvedValue({
      role: "OPERATIONS",
      user: { banned: false },
    })
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "order-1" }]),
      order: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      staffMembership: {
        findUnique: jest.fn().mockResolvedValue({
          role: "OPERATIONS",
          user: { banned: false },
        }),
      },
      fulfillmentAssignment: {
        create: jest.fn().mockResolvedValue({ id: "assignment-1" }),
      },
    }
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    )

    await expect(
      service.claim("order-1", "ops-1", "OPERATIONS"),
    ).rejects.toThrow(ConflictException)
  })

  it("synchronizes an unassigned linked ticket with audit, system event, and outbox", async () => {
    prisma.staffMembership.findUnique.mockResolvedValue({
      role: "OPERATIONS",
      user: { banned: false },
    })
    communications = {
      record: jest.fn().mockResolvedValue({ eventId: "communication-1" }),
      dispatchManyBestEffort: jest.fn(),
    }
    service = new OrderFulfillmentAssignmentService(
      prisma,
      audit,
      cancellation,
      communications as any,
    )
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "order-1" }]),
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      staffMembership: {
        findUnique: jest.fn().mockResolvedValue({
          role: "OPERATIONS",
          user: { banned: false },
        }),
      },
      fulfillmentAssignment: {
        create: jest.fn().mockResolvedValue({ id: "assignment-1" }),
      },
      ticket: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "ticket-1",
            subject: "Order help",
            organizationId: "org-1",
            assignedToUserId: null,
          },
        ]),
        update: jest.fn().mockResolvedValue({ id: "ticket-1" }),
      },
      ticketMessage: {
        create: jest.fn().mockResolvedValue({ id: "system-event-1" }),
      },
    }
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    )

    await service.claim("order-1", "ops-1", "OPERATIONS")

    expect(tx.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { assignedToUserId: null },
            { assignedToUserId: { not: "ops-1" } },
          ],
        }),
      }),
    )
    expect(tx.ticket.update).toHaveBeenCalledWith({
      where: { id: "ticket-1" },
      data: { assignedToUserId: "ops-1" },
    })
    expect(tx.ticketMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          messageType: "SYSTEM_EVENT",
          visibility: "INTERNAL",
        }),
      }),
    )
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "TICKET_ORDER_ASSIGNMENT_SYNCED" }),
      tx,
    )
    expect(communications.record).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: "system-event-1",
        recipientUserIds: ["ops-1"],
      }),
      tx,
    )
    expect(communications.dispatchManyBestEffort).toHaveBeenCalledWith([
      "communication-1",
    ])
  })

  it("maps a concurrent claim collision to a clear conflict", async () => {
    prisma.staffMembership.findUnique.mockResolvedValue({
      role: "OPERATIONS",
      user: { banned: false },
    })
    prisma.$transaction.mockRejectedValue({ code: "P2002" })

    await expect(
      service.claim("order-1", "ops-1", "OPERATIONS"),
    ).rejects.toThrow(ConflictException)
  })

  it("keeps newly arrived unassigned orders independently claimable", async () => {
    prisma.order.findMany.mockResolvedValue([
      {
        ...platformOrder,
        id: "order-1",
        fulfillmentAssignments: [],
        cancellationRequests: [],
      },
      {
        ...platformOrder,
        id: "order-2",
        fulfillmentAssignments: [],
        cancellationRequests: [],
      },
    ])
    prisma.order.count.mockResolvedValue(2)

    const result = await service.operationsInbox(
      { id: "ops-1", staffRole: "OPERATIONS" },
      { view: "available" },
    )

    expect(
      result.items.map((order: any) => [
        order.id,
        order.claimable,
        order.canSelfClaim,
        order.canAssign,
        order.nextAction,
      ]),
    ).toEqual([
      ["order-1", true, true, false, "CLAIM"],
      ["order-2", true, true, false, "CLAIM"],
    ])
  })

  it("projects assignment eligibility separately for Super Admin", async () => {
    prisma.order.findMany.mockResolvedValue([
      {
        ...platformOrder,
        fulfillmentAssignments: [],
        cancellationRequests: [],
      },
    ])
    prisma.order.count.mockResolvedValue(1)

    const result = await service.operationsInbox(
      { id: "admin-1", staffRole: "SUPER_ADMIN" },
      { view: "available", includeSummary: false },
    )

    expect(result.items[0]).toMatchObject({
      claimable: true,
      canSelfClaim: false,
      canAssign: true,
      nextAction: "ASSIGN",
    })
  })

  it("omits financial fields from Operations inbox items and summaries", async () => {
    prisma.order.findMany.mockResolvedValue([
      {
        ...platformOrder,
        amount: "125.00",
        currency: "USD",
        events: [],
        fulfillmentAssignments: [],
        cancellationRequests: [],
      },
    ])
    prisma.order.count.mockResolvedValue(1)
    prisma.fulfillmentAssignment.findMany.mockResolvedValue([
      {
        orderId: "order-1",
        assignedToUserId: "ops-1",
        status: "DELIVERED",
        order: {
          status: "COMPLETED",
          amount: "125.00",
          currency: "USD",
        },
      },
    ])

    const result = await service.operationsInbox({
      id: "ops-1",
      staffRole: "OPERATIONS",
    })

    expect(result.items[0]).not.toHaveProperty("amount")
    expect(result.items[0]).not.toHaveProperty("currency")
    expect(result.summary).not.toHaveProperty("salesByCurrency")
  })

  it("keeps financial summaries available to Super Admin", async () => {
    prisma.fulfillmentAssignment.findMany.mockResolvedValue([
      {
        orderId: "order-1",
        assignedToUserId: "ops-1",
        status: "DELIVERED",
        order: {
          status: "COMPLETED",
          amount: "125.00",
          currency: "USD",
        },
      },
    ])

    const result = await service.operationsInbox({
      id: "admin-1",
      staffRole: "SUPER_ADMIN",
    })

    expect(result.summary).toMatchObject({
      completed: 1,
      salesByCurrency: { USD: 125 },
    })
  })

  it("does not advertise cancellation-held orders as claimable", async () => {
    await service.operationsInbox(
      { id: "ops-1", staffRole: "OPERATIONS" },
      { view: "available", includeSummary: false },
    )

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            expect.objectContaining({
              cancellationRequests: {
                none: {
                  status: {
                    in: expect.arrayContaining(["REQUESTED", "UNDER_REVIEW"]),
                  },
                },
              },
            }),
          ]),
        },
      }),
    )
  })

  it("hides another operator's assigned order from direct access", async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...platformOrder,
      items: [],
      revisions: [],
      events: [],
      cancellationRequests: [],
      fulfillmentAssignments: [
        {
          id: "assignment-2",
          assignedToUserId: "ops-2",
          status: "ASSIGNED",
          createdAt: new Date(),
        },
      ],
    })

    await expect(
      service.getOperationsOrder("order-1", {
        id: "ops-1",
        staffRole: "OPERATIONS",
      }),
    ).rejects.toThrow(NotFoundException)
  })

  it("projects actor-specific claim and assignment capabilities on order detail", async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...platformOrder,
      items: [],
      revisions: [],
      events: [],
      cancellationRequests: [],
      fulfillmentAssignments: [],
    })

    await expect(
      service.getOperationsOrder("order-1", {
        id: "ops-1",
        staffRole: "OPERATIONS",
      }),
    ).resolves.toMatchObject({
      access: {
        claimable: true,
        canSelfClaim: true,
        canAssign: false,
      },
      nextAction: "CLAIM",
    })
    await expect(
      service.getOperationsOrder("order-1", {
        id: "admin-1",
        staffRole: "SUPER_ADMIN",
      }),
    ).resolves.toMatchObject({
      access: {
        claimable: true,
        canSelfClaim: false,
        canAssign: true,
      },
      nextAction: "ASSIGN",
    })
  })
})
