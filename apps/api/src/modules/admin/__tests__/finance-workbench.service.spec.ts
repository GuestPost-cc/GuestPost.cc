import { ForbiddenException } from "@nestjs/common"
import {
  FinanceWorkbenchService,
  sortFinanceWorkbenchActions,
} from "../finance-workbench.service"

function createPrisma() {
  return {
    settlement: {
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({
        _sum: { publisherAmount: null },
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    withdrawal: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    payoutExecution: {
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
    ticket: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    publisherBalance: {
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: 0 },
        _sum: { debtBalance: null },
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
  }
}

function createService(overrides?: {
  reconciliation?: unknown
  revenue?: unknown
}) {
  const prisma = createPrisma()
  const reconciliation =
    overrides?.reconciliation ??
    ({
      run: jest.fn().mockResolvedValue({
        ok: true,
        ranAt: "2026-07-18T10:00:00.000Z",
        summary: { critical: 0, warning: 0, info: 0, totalIssues: 0 },
      }),
    } as const)
  const revenue =
    overrides?.revenue ??
    ({
      getRevenue: jest.fn().mockResolvedValue({
        totals: {
          current: {
            grossAmount: "0.00",
            platformFee: "0.00",
            netRevenue: "0.00",
            rowCount: 0,
            reversedCount: 0,
            currency: "USD",
          },
          previous: null,
          deltaPct: null,
        },
        meta: { currencyMismatch: null },
      }),
    } as const)

  return {
    prisma,
    service: new FinanceWorkbenchService(
      prisma as any,
      reconciliation as any,
      revenue as any,
    ),
  }
}

describe("FinanceWorkbenchService", () => {
  it("sorts by severity and keeps Support first inside the same band", () => {
    const base = {
      title: "Review",
      description: "Needs review",
      href: "/dashboard/finance",
      deadlineAt: null,
      amount: null,
      currency: null,
    }
    const actions = [
      {
        ...base,
        id: "settlement",
        type: "SETTLEMENT" as const,
        priority: "HIGH" as const,
        createdAt: "2026-07-01T00:00:00.000Z",
        deadlineAt: "2026-07-01T12:00:00.000Z",
      },
      {
        ...base,
        id: "support",
        type: "SUPPORT" as const,
        priority: "HIGH" as const,
        createdAt: "2026-07-02T00:00:00.000Z",
      },
      {
        ...base,
        id: "payout",
        type: "PAYOUT" as const,
        priority: "CRITICAL" as const,
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    ]

    expect(
      actions.sort(sortFinanceWorkbenchActions).map((item) => item.id),
    ).toEqual(["payout", "support", "settlement"])
  })

  it("fails closed for Operations before reading any financial data", async () => {
    const { prisma, service } = createService()

    await expect(service.getWorkbench("OPERATIONS")).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(prisma.settlement.groupBy).not.toHaveBeenCalled()
    expect(prisma.ticket.findMany).not.toHaveBeenCalled()
  })

  it("uses exact aggregates, prioritizes Support, and returns only sanitized activity", async () => {
    const { prisma, service } = createService({
      reconciliation: {
        run: jest.fn().mockResolvedValue({
          ok: false,
          ranAt: "2026-07-18T10:00:00.000Z",
          summary: { critical: 1, warning: 1, info: 0, totalIssues: 2 },
        }),
      },
      revenue: {
        getRevenue: jest.fn().mockResolvedValue({
          totals: {
            current: {
              grossAmount: "1234.56",
              platformFee: "123.45",
              netRevenue: "321.45",
              rowCount: 8,
              reversedCount: 1,
              currency: "USD",
            },
            previous: null,
            deltaPct: null,
          },
          meta: { currencyMismatch: null },
        }),
      },
    })
    prisma.settlement.groupBy.mockResolvedValue([
      {
        status: "CUSTOMER_APPROVED",
        _count: { _all: 3 },
        _sum: { publisherAmount: "600.00" },
      },
      {
        status: "PENDING",
        _count: { _all: 2 },
        _sum: { publisherAmount: "400.00" },
      },
    ])
    prisma.withdrawal.groupBy.mockResolvedValue([
      {
        status: "PENDING",
        _count: { _all: 5 },
        _sum: { amount: "150.00" },
      },
      {
        status: "APPROVED",
        _count: { _all: 2 },
        _sum: { amount: "100.00" },
      },
    ])
    prisma.payoutExecution.groupBy.mockResolvedValue([
      {
        status: "FAILED",
        _count: { _all: 1 },
        _sum: { amount: "50.00" },
      },
    ])
    prisma.withdrawal.count.mockResolvedValueOnce(4).mockResolvedValueOnce(2)
    prisma.orderCancellationRequest.count.mockResolvedValue(2)
    prisma.orderDispute.count.mockResolvedValue(6)
    prisma.ticket.count.mockResolvedValueOnce(9).mockResolvedValueOnce(4)
    prisma.payoutExecution.count.mockResolvedValue(1)
    prisma.settlement.aggregate.mockResolvedValue({
      _sum: { publisherAmount: "1000.00" },
    })
    prisma.withdrawal.aggregate.mockResolvedValue({
      _sum: { amount: "250.00" },
    })
    prisma.ticket.findMany.mockResolvedValue([
      {
        id: "ticket-1",
        subject: "Withdrawal has not arrived",
        status: "OPEN",
        fulfillmentChannel: "PUBLISHER",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-01T01:00:00.000Z"),
        user: { name: "Customer" },
        assignedPublisher: { name: "Publisher" },
        order: null,
      },
    ])
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: "audit-1",
        action: "WITHDRAWAL_APPROVED",
        entityType: "Withdrawal",
        entityId: "withdrawal-1",
        createdAt: new Date("2026-07-18T09:00:00.000Z"),
        user: { name: "Finance", email: "finance@example.com" },
      },
    ])

    const result = await service.getWorkbench("FINANCE")

    expect(result.overview).toEqual({
      readyForDecision: 9,
      activeSupport: 9,
      fundsInFlight: "1250.00",
      financialExceptions: 5,
      netRevenue30d: "321.45",
    })
    expect(result.support).toMatchObject({ active: 9, overdue: 4 })
    expect(result.actionQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "RECONCILIATION" }),
        expect.objectContaining({ type: "SUPPORT", id: "ticket-1" }),
      ]),
    )
    expect(result.recentActivity).toEqual([
      expect.objectContaining({
        id: "audit-1",
        action: "WITHDRAWAL_APPROVED",
        href: "/dashboard/finance?tab=payouts",
      }),
    ])
    expect(JSON.stringify(result.recentActivity)).not.toContain(
      "finance@example.com",
    )
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { action: { in: expect.any(Array) } },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        createdAt: true,
        user: { select: { name: true } },
      },
    })
  })

  it("keeps the workbench available when revenue and reconciliation scans fail", async () => {
    const { service } = createService({
      reconciliation: { run: jest.fn().mockRejectedValue(new Error("down")) },
      revenue: {
        getRevenue: jest.fn().mockRejectedValue(new Error("down")),
      },
    })

    const result = await service.getWorkbench("FINANCE")

    expect(result.reconciliation.available).toBe(false)
    expect(result.revenue.available).toBe(false)
    expect(result.overview.netRevenue30d).toBe("0.00")
  })
})
