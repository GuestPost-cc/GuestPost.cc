import { Decimal } from "@prisma/client/runtime/client"
import { OrderReviewService } from "../order-review.service"

function setup(chargebackCount: number) {
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
    fulfillmentChannel: "PUBLISHER",
    listingServiceId: null,
    type: "GUEST_POST",
    warrantyDays: 30,
    deliveredAt: new Date("2026-08-01T00:00:00.000Z"),
    websiteId: "website-1",
    verifyMethod: "AUTO",
    website: { ownershipType: "PUBLISHER" },
  }
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: order.id }]),
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    orderDeliveryVersion: {
      findUnique: jest.fn().mockResolvedValue({
        id: "delivery-1",
        orderId: order.id,
        normalizedUrl: "https://publisher.example/article",
        supersededByVersion: null,
        verificationStatus: "VERIFIED",
        interventionStatus: "NONE",
      }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    orderDispute: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    revision: { findFirst: jest.fn().mockResolvedValue(null) },
    orderCancellationRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    deliveryFraudFlag: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    deliveryFraudHold: { count: jest.fn().mockResolvedValue(0) },
    settlement: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => ({
        id: "settlement-1",
        ...data,
      })),
    },
    website: {
      findUnique: jest.fn().mockResolvedValue({ publisherId: "publisher-1" }),
    },
    publisher: {
      findUnique: jest.fn().mockResolvedValue({
        id: "publisher-1",
        tier: "VERIFIED",
      }),
    },
    paymentDispute: {
      count: jest.fn().mockResolvedValue(chargebackCount),
    },
    listingService: { findUnique: jest.fn().mockResolvedValue(null) },
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
    { log: jest.fn().mockResolvedValue(undefined) } as any,
    {} as any,
    { assertNoActiveCancellation: jest.fn() } as any,
  )
  return { service, tx }
}

describe("OrderReviewService settlement risk classification", () => {
  it("uses tenant-scoped chargeback history instead of treating missing history as clean", async () => {
    const { service, tx } = setup(1)

    await service.createSettlementForOrder(tx, "order-1")

    expect(tx.paymentDispute.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { depositAttempt: { organizationId: "org-1" } },
          { wallet: { organizationId: "org-1" } },
          { depositAttempt: { createdByUserId: "customer-1" } },
          { wallet: { userId: "customer-1" } },
        ],
      },
    })
    expect(tx.settlement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ releasePolicy: "MANUAL" }),
    })
  })

  it("permits AUTO only for a complete clean classification", async () => {
    const { service, tx } = setup(0)

    await service.createSettlementForOrder(tx, "order-1")

    expect(tx.settlement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ releasePolicy: "AUTO" }),
    })
  })

  it("propagates history-read failures and creates no liability", async () => {
    const { service, tx } = setup(0)
    const databaseFailure = new Error("database unavailable")
    tx.paymentDispute.count.mockRejectedValue(databaseFailure)

    await expect(service.createSettlementForOrder(tx, "order-1")).rejects.toBe(
      databaseFailure,
    )
    expect(tx.settlement.create).not.toHaveBeenCalled()
  })
})
