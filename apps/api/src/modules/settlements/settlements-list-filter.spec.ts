import { SettlementsService } from "./settlements.service"

describe("SettlementsService list filtering", () => {
  it("applies the controlled status filter to both rows and the exact count", async () => {
    const prisma = {
      settlement: {
        findMany: jest.fn().mockResolvedValue([{ id: "settlement-1" }]),
        count: jest.fn().mockResolvedValue(37),
      },
      $transaction: jest.fn((queries: Array<Promise<unknown>>) =>
        Promise.all(queries),
      ),
    }
    const service = new SettlementsService(prisma as any, {} as any, {} as any)

    const result = await service.listSettlements(undefined, 20, 20, [
      "PENDING",
      "UNDER_REVIEW",
      "CUSTOMER_APPROVED",
      "ADMIN_APPROVED",
    ])

    const where = {
      status: {
        in: ["PENDING", "UNDER_REVIEW", "CUSTOMER_APPROVED", "ADMIN_APPROVED"],
      },
    }
    expect(prisma.settlement.findMany).toHaveBeenCalledWith({
      where,
      include: { order: true, publisher: true, approvals: true },
      orderBy: { createdAt: "desc" },
      take: 20,
      skip: 20,
    })
    expect(prisma.settlement.count).toHaveBeenCalledWith({ where })
    expect(result).toEqual({
      items: [{ id: "settlement-1" }],
      total: 37,
      take: 20,
      skip: 20,
    })
  })
})
