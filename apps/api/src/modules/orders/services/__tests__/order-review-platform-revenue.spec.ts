import { ConflictException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { OrderReviewService } from "../order-review.service"

const order = {
  id: "order-1",
  status: "DELIVERED",
  version: 4,
  paymentStatus: "PAID",
  amount: new Decimal("100.00"),
  currency: "USD",
  organizationId: "org-1",
  customerId: "customer-1",
  activeDeliveryVersionId: "delivery-1",
  fulfillmentChannel: "PLATFORM",
  listingServiceId: null,
  type: "GUEST_POST",
  warrantyDays: 30,
  deliveredAt: new Date("2026-08-01T00:00:00.000Z"),
  website: { ownershipType: "PLATFORM" },
}

function canonicalPurchase() {
  return {
    amount: new Decimal("-100.00"),
    currency: "USD",
    walletId: "wallet-1",
    publisherId: null,
    settlementId: null,
    provider: null,
    providerRef: null,
    wallet: { currency: "USD", organizationId: "org-1" },
  }
}

function setup() {
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: "order-1" }]),
    order: {
      findUnique: jest.fn().mockResolvedValue(order),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    orderDeliveryVersion: {
      findUnique: jest.fn().mockResolvedValue({
        id: "delivery-1",
        orderId: "order-1",
        verificationStatus: "VERIFIED",
        interventionStatus: "NONE",
      }),
    },
    orderDispute: { findFirst: jest.fn().mockResolvedValue(null) },
    revision: { findFirst: jest.fn().mockResolvedValue(null) },
    orderCancellationRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    deliveryFraudFlag: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    settlement: { findFirst: jest.fn().mockResolvedValue(null) },
    listingService: { findUnique: jest.fn().mockResolvedValue(null) },
    transaction: {
      findMany: jest.fn().mockResolvedValue([canonicalPurchase()]),
    },
    platformRevenue: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "revenue-1" }),
    },
    platformSettings: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "platform-settings-default",
          platformFeePct: "20",
          version: 1,
        },
      ]),
    },
  }
  const service = new OrderReviewService(
    tx,
    { log: jest.fn() } as any,
    {} as any,
    { assertNoActiveCancellation: jest.fn() } as any,
  )
  return { service, tx }
}

describe("OrderReviewService PlatformRevenue evidence", () => {
  it("recognizes exact USD revenue with canonical purchase and policy snapshots", async () => {
    const { service, tx } = setup()

    await expect(
      service.createSettlementForOrder(tx, "order-1"),
    ).resolves.toBeUndefined()

    const data = tx.platformRevenue.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      orderId: "order-1",
      currency: "USD",
      platformFeeBps: 2000,
      feePolicyVersion: "platform-settings:platform-settings-default:v1",
      fulfillmentChannel: "PLATFORM",
    })
    expect(data.amount.toFixed(2)).toBe("100.00")
    expect(data.platformFee.toFixed(2)).toBe("20.00")
    expect(data.netRevenue.toFixed(2)).toBe("80.00")
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-1", status: "DELIVERED" },
      }),
    )
  })

  it("fails closed without the singleton policy", async () => {
    const { service, tx } = setup()
    tx.platformSettings.findMany.mockResolvedValue([])

    await expect(
      service.createSettlementForOrder(tx, "order-1"),
    ).rejects.toThrow(/Versioned PlatformSettings policy is unavailable/)
    expect(tx.platformRevenue.create).not.toHaveBeenCalled()
    expect(tx.order.updateMany).not.toHaveBeenCalled()
  })

  it("maps missing purchase evidence to a stable conflict", async () => {
    const { service, tx } = setup()
    tx.transaction.findMany.mockResolvedValue([])

    await expect(
      service.createSettlementForOrder(tx, "order-1"),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "PLATFORM_REVENUE_PURCHASE_EVIDENCE_INVALID",
      }),
    })
    expect(tx.platformSettings.findMany).not.toHaveBeenCalled()
    expect(tx.platformRevenue.create).not.toHaveBeenCalled()
  })

  it("does not misclassify a database failure as invalid purchase evidence", async () => {
    const { service, tx } = setup()
    const databaseFailure = new Error("database unavailable")
    tx.transaction.findMany.mockRejectedValue(databaseFailure)

    await expect(service.createSettlementForOrder(tx, "order-1")).rejects.toBe(
      databaseFailure,
    )
    expect(tx.platformRevenue.create).not.toHaveBeenCalled()
  })

  it("rejects conflicting pre-existing recognition evidence", async () => {
    const { service, tx } = setup()
    tx.platformRevenue.findUnique.mockResolvedValue({
      amount: new Decimal("100.00"),
      currency: "USD",
      platformFee: new Decimal("19.00"),
      netRevenue: new Decimal("81.00"),
      platformFeeBps: 2000,
      feePolicyVersion: "platform-settings:platform-settings-default:v1",
      fulfillmentChannel: "PLATFORM",
      reversedAt: null,
    })

    await expect(
      service.createSettlementForOrder(tx, "order-1"),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(tx.platformRevenue.create).not.toHaveBeenCalled()
    expect(tx.order.updateMany).not.toHaveBeenCalled()
  })

  it("does not commit recognition if the completion compare-and-set loses", async () => {
    const { service, tx } = setup()
    tx.order.updateMany.mockResolvedValue({ count: 0 })

    await expect(
      service.createSettlementForOrder(tx, "order-1"),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "PLATFORM_REVENUE_COMPLETION_CONFLICT",
      }),
    })
  })
})
