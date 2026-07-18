import {
  CommandCenterService,
  sortCommandCenterActions,
} from "../command-center.service"

function createPrisma() {
  return {
    order: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
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
    settlement: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    withdrawal: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    payoutExecution: { count: jest.fn().mockResolvedValue(0) },
    ticket: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    website: { count: jest.fn().mockResolvedValue(0) },
    marketplaceListing: { count: jest.fn().mockResolvedValue(0) },
    platformRevenue: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: { amount: null, netRevenue: null },
      }),
    },
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
  }
}

describe("CommandCenterService", () => {
  it("sorts by severity, then deadline, then oldest creation time", () => {
    const base = {
      type: "SUPPORT" as const,
      title: "Case",
      description: "Needs review",
      owner: "Support" as const,
      href: "/dashboard/support",
      amount: null,
      currency: null,
    }
    const actions = [
      {
        ...base,
        id: "medium",
        priority: "MEDIUM" as const,
        createdAt: "2026-07-01T00:00:00.000Z",
        deadlineAt: null,
      },
      {
        ...base,
        id: "critical-later",
        priority: "CRITICAL" as const,
        createdAt: "2026-07-02T00:00:00.000Z",
        deadlineAt: "2026-07-04T00:00:00.000Z",
      },
      {
        ...base,
        id: "critical-sooner",
        priority: "CRITICAL" as const,
        createdAt: "2026-07-03T00:00:00.000Z",
        deadlineAt: "2026-07-03T00:00:00.000Z",
      },
      {
        ...base,
        id: "high",
        priority: "HIGH" as const,
        createdAt: "2026-07-01T00:00:00.000Z",
        deadlineAt: null,
      },
    ]

    expect(
      actions.sort(sortCommandCenterActions).map((item) => item.id),
    ).toEqual(["critical-sooner", "critical-later", "high", "medium"])
  })

  it("uses exact aggregate counts instead of deriving totals from result pages", async () => {
    const prisma = createPrisma()
    prisma.order.groupBy.mockResolvedValue([
      { status: "PENDING_PAYMENT", _count: { _all: 12 } },
      { status: "CONTENT_CREATION", _count: { _all: 8 } },
      { status: "CUSTOMER_REVIEW", _count: { _all: 4 } },
      { status: "PUBLISHED", _count: { _all: 3 } },
      { status: "COMPLETED", _count: { _all: 20 } },
      { status: "DISPUTED", _count: { _all: 2 } },
    ])
    prisma.order.count
      .mockResolvedValueOnce(120)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(6)
    prisma.orderCancellationRequest.count.mockResolvedValue(2)
    prisma.orderDispute.count.mockResolvedValue(3)
    prisma.settlement.count.mockResolvedValue(7)
    prisma.withdrawal.count.mockResolvedValueOnce(8).mockResolvedValueOnce(9)
    prisma.payoutExecution.count.mockResolvedValue(10)
    prisma.ticket.count.mockResolvedValue(11)
    prisma.website.count.mockResolvedValue(13)
    prisma.marketplaceListing.count.mockResolvedValue(14)
    prisma.platformRevenue.aggregate.mockResolvedValue({
      _sum: { amount: "1234.50", netRevenue: "234.50" },
    })
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: "audit-1",
        action: "STAFF_ROLE_UPDATED",
        entityType: "StaffMembership",
        entityId: "staff-1",
        createdAt: new Date("2026-07-18T10:00:00.000Z"),
        user: { name: "Admin", email: "admin@example.com" },
      },
    ])
    const reconciliation = {
      run: jest.fn().mockResolvedValue({
        ok: false,
        ranAt: "2026-07-18T10:00:00.000Z",
        summary: { critical: 1, warning: 1, info: 0, totalIssues: 2 },
      }),
    }
    const service = new CommandCenterService(
      prisma as any,
      reconciliation as any,
    )

    const result = await service.getCommandCenter()

    expect(result.overview).toEqual({
      needsAction: 67,
      activeOrders: 120,
      financeExceptions: 21,
      verificationIssues: 4,
    })
    expect(result.lifecycle.map((stage) => stage.count)).toEqual([
      12, 8, 4, 3, 20, 2,
    ])
    expect(result.health).toEqual({
      unassignedFulfillment: 5,
      overdueFulfillment: 6,
      activeDisputes: 3,
      activeCancellations: 2,
      unassignedSupport: 11,
      domainVerificationIssues: 13,
      marketplacePendingReview: 14,
    })
    expect(result.finance).toMatchObject({
      gmv: "1234.50",
      netRevenue: "234.50",
      reconciliation: { available: true, critical: 1, totalIssues: 2 },
    })
    expect(result.recentActivity).toEqual([
      expect.objectContaining({
        id: "audit-1",
        actorName: "Admin",
        entity: "StaffMembership",
      }),
    ])
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
    })
  })

  it("isolates a failed reconciliation scan from the operational dashboard", async () => {
    const prisma = createPrisma()
    const service = new CommandCenterService(
      prisma as any,
      {
        run: jest.fn().mockRejectedValue(new Error("scan unavailable")),
      } as any,
    )

    const result = await service.getCommandCenter()

    expect(result.finance.reconciliation).toEqual({
      available: false,
      ok: false,
      critical: 0,
      warning: 0,
      totalIssues: 0,
      ranAt: null,
    })
    expect(result.overview.needsAction).toBe(0)
  })
})
