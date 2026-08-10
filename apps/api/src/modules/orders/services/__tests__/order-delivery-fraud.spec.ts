import { ConflictException } from "@nestjs/common"
import { OrderDeliveryService } from "../order-delivery.service"

describe("OrderDeliveryService customer fraud controls", () => {
  const order = {
    id: "order-1",
    organizationId: "organization-1",
    customerId: "customer-1",
    status: "PUBLISHED",
    version: 4,
    activeDeliveryVersionId: "delivery-1",
    website: { publisherId: "publisher-1" },
  }
  const delivery = {
    id: "delivery-1",
    orderId: "order-1",
    publishedUrl: "https://publisher.example/reused",
    verificationStatus: "MANUAL_REVIEW",
    verificationVersion: 2,
    supersededByVersion: null,
  }

  function setup(holds: any[]) {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: order.id }]),
      $transaction: jest
        .fn()
        .mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
          callback(prisma),
        ),
      order: {
        findFirst: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ status: "DELIVERED" }),
      },
      membership: {
        findFirst: jest.fn().mockResolvedValue({ role: "MEMBER" }),
      },
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue(delivery),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      deliveryFraudHold: {
        findMany: jest.fn().mockResolvedValue(holds),
      },
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
    }
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const review = {
      createSettlementForOrder: jest.fn().mockResolvedValue(undefined),
    }
    const cancellation = {
      assertNoActiveCancellation: jest.fn().mockResolvedValue(undefined),
    }
    const service = new OrderDeliveryService(
      prisma,
      audit as any,
      {} as any,
      review as any,
      cancellation as any,
    )
    return { audit, cancellation, prisma, review, service }
  }

  it("blocks a customer from accepting a reused URL before any lifecycle or money write", async () => {
    const { audit, prisma, review, service } = setup([
      {
        fraudFlagId: "flag-1",
        deliveryVersionId: delivery.id,
        type: "URL_REUSED",
      },
    ])

    const error = await service
      .customerAcceptDelivery(
        order.id,
        order.organizationId,
        order.customerId,
        "MEMBER",
      )
      .catch((value) => value)

    expect(error).toBeInstanceOf(ConflictException)
    expect(error.getResponse()).toEqual({
      code: "DELIVERY_FRAUD_REVIEW_REQUIRED",
      message:
        "This delivery is under security review and cannot be accepted yet. Support will notify you when review is complete.",
    })
    expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(review.createSettlementForOrder).not.toHaveBeenCalled()
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORDER_DELIVERY_CUSTOMER_MANUAL_ACCEPT_BLOCKED_FRAUD",
        metadata: expect.objectContaining({
          fraudTypes: ["URL_REUSED"],
          decision: "BLOCKED_PENDING_STAFF_REVIEW",
        }),
      }),
      prisma,
    )
  })

  it("still permits the customer fallback for a technical review with no fraud hold", async () => {
    const { prisma, review, service } = setup([])

    await expect(
      service.customerAcceptDelivery(
        order.id,
        order.organizationId,
        order.customerId,
        "MEMBER",
      ),
    ).resolves.toEqual({ status: "DELIVERED", acceptedBy: "customer" })

    expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ interventionStatus: "APPROVED" }),
      }),
    )
    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DELIVERED",
          verifyMethod: "CUSTOMER_MANUAL",
        }),
      }),
    )
    expect(review.createSettlementForOrder).toHaveBeenCalledWith(
      prisma,
      order.id,
    )
  })
})
