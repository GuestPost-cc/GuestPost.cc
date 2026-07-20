import { PublisherPayoutsService } from "./publisher-payouts.service"

describe("PublisherPayoutsService withdrawal list filtering", () => {
  it("uses the same controlled status filter for the page and exact total", async () => {
    const prisma = {
      withdrawal: {
        findMany: jest.fn().mockResolvedValue([{ id: "withdrawal-1" }]),
        count: jest.fn().mockResolvedValue(25),
      },
      $transaction: jest.fn((queries: Array<Promise<unknown>>) =>
        Promise.all(queries),
      ),
    }
    const service = new PublisherPayoutsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )

    const result = await service.listWithdrawals(undefined, 20, 20, [
      "APPROVED",
      "PROCESSING",
      "FAILED",
    ])

    const where = {
      status: { in: ["APPROVED", "PROCESSING", "FAILED"] },
    }
    expect(prisma.withdrawal.findMany).toHaveBeenCalledWith({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        publisherId: true,
        amount: true,
        currency: true,
        publicReference: true,
        payoutFee: true,
        netAmount: true,
        feePolicyVersion: true,
        status: true,
        availableAt: true,
        createdAt: true,
        publisher: true,
        payoutMethod: { select: { id: true, type: true, label: true } },
        allocations: {
          where: { releasedAt: null },
          orderBy: { sequence: "asc" },
          select: {
            amount: true,
            currency: true,
            sourceType: true,
            serviceType: true,
            orderId: true,
          },
        },
      },
      take: 20,
      skip: 20,
    })
    expect(prisma.withdrawal.count).toHaveBeenCalledWith({ where })
    expect(result).toEqual({
      items: [{ id: "withdrawal-1" }],
      total: 25,
      take: 20,
      skip: 20,
    })
  })
})
