import { BadRequestException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { RefundService } from "../refund.service"

describe("RefundService", () => {
  let service: RefundService
  let prismaMock: any
  let auditMock: any
  let queueMock: any

  const baseOrder = {
    id: "order-1",
    organizationId: "org-1",
    status: "DELIVERED",
    paymentStatus: "PAID",
    amount: new Decimal(100),
    version: 3,
    website: { ownershipType: "PUBLISHER", publisherId: "pub-1" },
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
        create: jest.fn().mockResolvedValue({ id: "refund-tx-1" }),
      },
      settlement: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      platformRevenue: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn(),
      },
      fulfillmentAssignment: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publisherBalance: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
      publisher: {
        findUnique: jest.fn().mockResolvedValue({
          organizationId: "publisher-org-1",
          publisherMemberships: [{ userId: "publisher-user-1" }],
        }),
      },
      notification: { upsert: jest.fn().mockResolvedValue({}) },
      wallet: {
        findFirst: jest.fn().mockResolvedValue(wallet),
        findUnique: jest.fn().mockResolvedValue(wallet),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest
        .fn()
        .mockImplementation(async (cb: any) => cb(prismaMock)),
    }
    queueMock = {
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
      service.refundOrder("order-1", "dup", "admin-1", undefined, {
        responsibility: "SYSTEM",
      }),
    ).rejects.toThrow(BadRequestException)
    expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
  })

  it("reverses PlatformRevenue for platform orders instead of deleting", async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      ...baseOrder,
      website: { ownershipType: "PLATFORM" },
    })

    await service.refundOrder("order-1", "bad content", "admin-1", undefined, {
      responsibility: "PLATFORM",
    })

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

    await service.refundOrder("order-1", "cancelled", "admin-1", undefined, {
      responsibility: "PUBLISHER",
    })

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
    prismaMock.$queryRaw.mockResolvedValue([
      {
        publisherId: "pub-1",
        withdrawableBalance: new Decimal(200),
        version: 5,
      },
    ])

    await service.refundOrder("order-1", "dispute", "admin-1", undefined, {
      responsibility: "PUBLISHER",
    })

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
    expect(prismaMock.settlement.updateMany).toHaveBeenCalledWith({
      where: { id: "set-1", status: "RELEASED", version: 2 },
      data: { status: "CANCELLED", version: { increment: 1 } },
    })
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
    prismaMock.$queryRaw.mockResolvedValue([
      {
        publisherId: "pub-1",
        withdrawableBalance: new Decimal(30),
        version: 5,
      },
    ])

    await service.refundOrder("order-1", "dispute", "admin-1", undefined, {
      responsibility: "PUBLISHER",
    })

    const balanceCall = prismaMock.publisherBalance.updateMany.mock.calls[0][0]
    expect(
      balanceCall.data.withdrawableBalance.decrement.equals(new Decimal(30)),
    ).toBe(true)
    expect(balanceCall.data.debtBalance.increment.equals(new Decimal(50))).toBe(
      true,
    )
    expect(prismaMock.notification.upsert).toHaveBeenCalledWith({
      where: {
        userId_dedupKey: {
          userId: "publisher-user-1",
          dedupKey: "publisher-debt:order-1:publisher-user-1",
        },
      },
      create: expect.objectContaining({
        userId: "publisher-user-1",
        organizationId: "publisher-org-1",
        type: "PUBLISHER_DEBT_CREATED",
        message: expect.stringContaining("50.00 USD"),
        dedupKey: "publisher-debt:order-1:publisher-user-1",
      }),
      update: {},
    })

    // Customer still gets the FULL refund regardless of publisher debt
    expect(prismaMock.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          availableBalance: { increment: new Decimal(100) },
        }),
      }),
    )
  })

  it("records and explains full debt when the publisher has no balance row", async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)
    prismaMock.settlement.findFirst.mockResolvedValue({
      id: "set-1",
      status: "RELEASED",
      version: 2,
      publisherId: "pub-1",
      publisherAmount: new Decimal(80),
    })
    prismaMock.$queryRaw.mockResolvedValue([])

    await service.refundOrder("order-1", "dispute", "admin-1", undefined, {
      responsibility: "PUBLISHER",
    })

    expect(prismaMock.publisherBalance.create).toHaveBeenCalledWith({
      data: { publisherId: "pub-1", debtBalance: new Decimal(80) },
    })
    expect(prismaMock.notification.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          message: expect.stringContaining("80.00 USD"),
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
      service.refundOrder("order-1", "x", "admin-1", undefined, {
        responsibility: "SYSTEM",
      }),
    ).rejects.toThrow(BadRequestException)
  })

  it("requires explicit final responsibility", async () => {
    await expect(
      (service.refundOrder as any)("order-1", "x", "admin-1"),
    ).rejects.toThrow("final refund responsibility")
  })

  it("cancels active assignments and only penalizes publisher-attributed refunds", async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)

    await service.refundOrder(
      "order-1",
      "publisher missed deadline",
      "admin-1",
      undefined,
      { responsibility: "PUBLISHER" },
    )

    expect(prismaMock.fulfillmentAssignment.updateMany).toHaveBeenCalledWith({
      where: {
        orderId: "order-1",
        status: { in: ["ASSIGNED", "IN_PROGRESS"] },
      },
      data: { status: "CANCELLED", version: { increment: 1 } },
    })
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refundResponsibility: "PUBLISHER",
        }),
      }),
    )
    expect(queueMock.enqueueTrustRecompute).toHaveBeenCalledWith(
      "pub-1",
      "REFUND_ISSUED",
      expect.stringContaining("publisher-attributed"),
    )
  })
})
