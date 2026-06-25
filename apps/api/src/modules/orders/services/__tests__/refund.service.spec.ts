import { BadRequestException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { RefundService } from "../refund.service"

describe("RefundService", () => {
  let service: RefundService
  let prismaMock: any
  let auditMock: any

  const baseOrder = {
    id: "order-1",
    organizationId: "org-1",
    status: "DELIVERED",
    paymentStatus: "PAID",
    amount: new Decimal(100),
    version: 3,
    website: { ownershipType: "PUBLISHER" },
  }

  const wallet = { id: "wallet-1", organizationId: "org-1", version: 1 }

  beforeEach(() => {
    auditMock = { log: jest.fn().mockResolvedValue(undefined) }
    prismaMock = {
      order: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ ...baseOrder, status: "REFUNDED" }),
      },
      transaction: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      settlement: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      platformRevenue: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn(),
      },
      publisherBalance: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
      wallet: {
        findFirst: jest.fn().mockResolvedValue(wallet),
        findUnique: jest.fn().mockResolvedValue(wallet),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest
        .fn()
        .mockImplementation(async (cb: any) => cb(prismaMock)),
    }
    const queueMock = {
      enqueueTrustRecompute: jest.fn().mockResolvedValue(undefined),
    }
    service = new RefundService(
      prismaMock as any,
      auditMock as any,
      queueMock as any,
    )
  })

  it("rejects duplicate refunds", async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)
    prismaMock.transaction.findFirst.mockResolvedValue({ id: "tx-existing" })

    await expect(
      service.refundOrder("order-1", "dup", "admin-1"),
    ).rejects.toThrow(BadRequestException)
    expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
  })

  it("reverses PlatformRevenue for platform orders instead of deleting", async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      ...baseOrder,
      website: { ownershipType: "PLATFORM" },
    })

    await service.refundOrder("order-1", "bad content", "admin-1")

    expect(prismaMock.platformRevenue.updateMany).toHaveBeenCalledWith({
      where: { orderId: "order-1", reversedAt: null },
      data: { reversedAt: expect.any(Date) },
    })
    expect(prismaMock.platformRevenue.delete).not.toHaveBeenCalled()
    expect(prismaMock.wallet.updateMany).toHaveBeenCalled()
  })

  it("cancels a pending settlement and credits the wallet", async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)
    prismaMock.settlement.findFirst.mockResolvedValue({
      id: "set-1",
      status: "PENDING",
      version: 0,
      publisherId: "pub-1",
      publisherAmount: new Decimal(80),
    })

    await service.refundOrder("order-1", "cancelled", "admin-1")

    expect(prismaMock.settlement.updateMany).toHaveBeenCalledWith({
      where: { id: "set-1", version: 0 },
      data: { status: "CANCELLED", version: { increment: 1 } },
    })
    expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          availableBalance: { increment: new Decimal(100) },
        }),
      }),
    )
  })

  it("claws back the full amount when withdrawable covers it", async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)
    prismaMock.settlement.findFirst.mockResolvedValue({
      id: "set-1",
      status: "RELEASED",
      version: 2,
      publisherId: "pub-1",
      publisherAmount: new Decimal(80),
    })
    prismaMock.publisherBalance.findUnique.mockResolvedValue({
      publisherId: "pub-1",
      withdrawableBalance: new Decimal(200),
      version: 5,
    })

    await service.refundOrder("order-1", "dispute", "admin-1")

    const balanceCall = prismaMock.publisherBalance.updateMany.mock.calls[0][0]
    expect(
      balanceCall.data.withdrawableBalance.decrement.equals(new Decimal(80)),
    ).toBe(true)
    expect(balanceCall.data.debtBalance.increment.equals(new Decimal(0))).toBe(
      true,
    )

    const clawbackTx = prismaMock.transaction.create.mock.calls.find(
      (c: any) => c[0].data.type === "SETTLEMENT_CLAWBACK",
    )
    expect(clawbackTx).toBeDefined()
    expect(clawbackTx[0].data.amount.equals(new Decimal(-80))).toBe(true)
    expect(clawbackTx[0].data.reference).toBe("clawback-order-1")
  })

  it("records remainder as debt when publisher already withdrew", async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)
    prismaMock.settlement.findFirst.mockResolvedValue({
      id: "set-1",
      status: "RELEASED",
      version: 2,
      publisherId: "pub-1",
      publisherAmount: new Decimal(80),
    })
    // Only 30 left withdrawable — 50 must become debt, not a failed decrement
    prismaMock.publisherBalance.findUnique.mockResolvedValue({
      publisherId: "pub-1",
      withdrawableBalance: new Decimal(30),
      version: 5,
    })

    await service.refundOrder("order-1", "dispute", "admin-1")

    const balanceCall = prismaMock.publisherBalance.updateMany.mock.calls[0][0]
    expect(
      balanceCall.data.withdrawableBalance.decrement.equals(new Decimal(30)),
    ).toBe(true)
    expect(balanceCall.data.debtBalance.increment.equals(new Decimal(50))).toBe(
      true,
    )

    // Customer still gets the FULL refund regardless of publisher debt
    expect(prismaMock.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          availableBalance: { increment: new Decimal(100) },
        }),
      }),
    )
  })

  it("refuses unpaid orders", async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      ...baseOrder,
      paymentStatus: "PENDING",
    })
    await expect(
      service.refundOrder("order-1", "x", "admin-1"),
    ).rejects.toThrow(BadRequestException)
  })
})
