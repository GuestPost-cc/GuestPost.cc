import { ForbiddenException } from "@nestjs/common"
import {
  type OperationsWorkbenchAction,
  OperationsWorkbenchService,
  sortOperationsWorkbenchActions,
} from "../operations-workbench.service"

function createPrisma() {
  return {
    ticket: {
      count: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    orderCancellationRequest: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    orderDispute: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    order: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    website: {
      count: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    marketplaceListing: {
      count: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
  }
}

function inbox(summary: any = null) {
  return { items: [], total: 0, take: 8, skip: 0, summary }
}

describe("OperationsWorkbenchService", () => {
  it("keeps critical failures above high work and Support first inside a band", () => {
    const base = {
      title: "Work",
      description: "Needs attention",
      href: "/dashboard",
      createdAt: "2026-07-19T00:00:00.000Z",
      deadlineAt: null,
      claimable: false,
    }
    const actions: OperationsWorkbenchAction[] = [
      { ...base, id: "support", type: "SUPPORT", priority: "HIGH" },
      {
        ...base,
        id: "fulfillment",
        type: "FULFILLMENT",
        priority: "HIGH",
      },
      {
        ...base,
        id: "verification",
        type: "DELIVERY_VERIFICATION",
        priority: "CRITICAL",
      },
    ]

    expect(
      actions.sort(sortOperationsWorkbenchActions).map((item) => item.id),
    ).toEqual(["verification", "support", "fulfillment"])
  })

  it("fails closed for Finance before reading operational data", async () => {
    const prisma = createPrisma()
    const fulfillment = { operationsInbox: jest.fn() }
    const service = new OperationsWorkbenchService(
      prisma as any,
      fulfillment as any,
    )

    await expect(
      service.getWorkbench({ id: "finance-1", staffRole: "FINANCE" }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(fulfillment.operationsInbox).not.toHaveBeenCalled()
    expect(prisma.ticket.count).not.toHaveBeenCalled()
  })

  it("uses exact assigned Support scope and returns cross-workflow counts", async () => {
    const prisma = createPrisma()
    prisma.ticket.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1)
    prisma.ticket.findMany.mockResolvedValue([
      {
        id: "ticket-1",
        subject: "Listing update question",
        status: "OPEN",
        createdAt: new Date("2026-07-17T00:00:00.000Z"),
        updatedAt: new Date("2026-07-17T01:00:00.000Z"),
        order: {
          id: "order-1",
          title: "Guest post",
          status: "CONTENT_CREATION",
          website: { domain: "example.com", name: null },
        },
      },
    ])
    prisma.orderCancellationRequest.count.mockResolvedValue(2)
    prisma.orderDispute.count.mockResolvedValue(1)
    prisma.order.count.mockResolvedValue(4)
    prisma.website.count.mockResolvedValueOnce(5).mockResolvedValueOnce(1)
    prisma.marketplaceListing.count
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(2)

    const fulfillmentSummary = {
      myActive: 7,
      available: 8,
      waitingCustomer: 2,
      readyToPublish: 3,
      overdue: 1,
      verificationTotal: 4,
      verificationIssues: 4,
      totalAssigned: 20,
      claimed: 9,
      completed: 10,
      salesByCurrency: { USD: 500 },
    }
    const fulfillment = {
      operationsInbox: jest
        .fn()
        .mockResolvedValueOnce(inbox(fulfillmentSummary))
        .mockResolvedValueOnce(inbox(null)),
    }
    const service = new OperationsWorkbenchService(
      prisma as any,
      fulfillment as any,
    )

    const result = await service.getWorkbench({
      id: "ops-1",
      staffRole: "OPERATIONS",
    })

    expect(result.overview).toEqual({
      needsAttention: 25,
      myActive: 7,
      available: 8,
      readyToPublish: 3,
      verificationIssues: 4,
      assignedSupport: 3,
    })
    expect(result.support).toMatchObject({ assigned: 3, overdue: 1 })
    expect(result.actionQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "SUPPORT", id: "ticket-1" }),
      ]),
    )
    expect(prisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["OPEN", "IN_PROGRESS"] },
          fulfillmentChannel: "PLATFORM",
          assignedToUserId: "ops-1",
        },
        select: expect.not.objectContaining({ user: expect.anything() }),
      }),
    )
    expect(JSON.stringify(result)).not.toContain("email")
    expect(result.fulfillment).not.toHaveProperty("salesByCurrency")
  })
})
