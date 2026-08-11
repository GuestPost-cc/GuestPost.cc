import { ConflictException } from "@nestjs/common"
import { OrderReviewService } from "../order-review.service"

describe("OrderReviewService delivery confirmation fraud controls", () => {
  it("does not let normal confirmation bypass an unresolved reused-URL hold", async () => {
    const order = {
      id: "order-1",
      organizationId: "organization-1",
      customerId: "customer-1",
      status: "VERIFIED",
      version: 7,
      activeDeliveryVersionId: "delivery-1",
    }
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
      },
      membership: {
        findFirst: jest.fn().mockResolvedValue({ role: "OWNER" }),
      },
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue({
          id: "delivery-1",
          orderId: order.id,
          normalizedUrl: "https://publisher.example/reused",
          supersededByVersion: null,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      deliveryFraudFlag: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: "fresh-flag" }),
      },
      deliveryFraudHold: {
        findMany: jest.fn().mockResolvedValue([
          {
            fraudFlagId: "flag-1",
            deliveryVersionId: "delivery-1",
            type: "URL_REUSED",
          },
        ]),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
    }
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const cancellation = {
      assertNoActiveCancellation: jest.fn().mockResolvedValue(undefined),
    }
    const service = new OrderReviewService(
      prisma,
      audit as any,
      {} as any,
      cancellation as any,
    )
    const settlement = jest
      .spyOn(service, "createSettlementForOrder")
      .mockResolvedValue(undefined as never)

    const error = await service
      .confirmDelivery(order.id, order.organizationId, order.customerId)
      .catch((value) => value)

    expect(error).toBeInstanceOf(ConflictException)
    expect(error.getResponse()).toEqual(
      expect.objectContaining({ code: "DELIVERY_FRAUD_REVIEW_REQUIRED" }),
    )
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(settlement).not.toHaveBeenCalled()
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORDER_DELIVERY_CUSTOMER_CONFIRM_BLOCKED_FRAUD",
      }),
      prisma,
    )
  })

  it("dispatches only the confirmation keys from the committed retry", async () => {
    const order = {
      id: "order-1",
      organizationId: "organization-1",
      customerId: "customer-1",
      status: "VERIFIED",
      version: 7,
      activeDeliveryVersionId: "delivery-1",
    }
    const fresh = {
      ...order,
      status: "DELIVERED",
      version: 8,
      websiteId: null,
    }
    let transactionAttempt = 0
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: order.id }]),
      $transaction: jest.fn().mockImplementation(async (callback: any) => {
        transactionAttempt++
        const value = await callback(prisma)
        if (transactionAttempt === 1) throw { code: "P2034" }
        return value
      }),
      order: {
        findFirst: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(fresh),
      },
      membership: {
        findFirst: jest.fn().mockResolvedValue({ role: "OWNER" }),
      },
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue({
          id: "delivery-1",
          orderId: order.id,
          normalizedUrl: "https://publisher.example/article",
          supersededByVersion: null,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      deliveryFraudFlag: { findMany: jest.fn().mockResolvedValue([]) },
      deliveryFraudHold: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
    }
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const cancellation = {
      assertNoActiveCancellation: jest.fn().mockResolvedValue(undefined),
    }
    const communications = {
      customerOrderRecipients: jest.fn().mockResolvedValue(["customer-1"]),
      publisherRecipients: jest.fn().mockResolvedValue([]),
      record: jest.fn().mockResolvedValue({ eventId: "event" }),
      dispatchManyByDedupKeyBestEffort: jest.fn(),
    }
    const service = new OrderReviewService(
      prisma,
      audit as any,
      {} as any,
      cancellation as any,
      communications as any,
    )
    jest
      .spyOn(service, "createSettlementForOrder")
      .mockImplementation(async () => [
        `settlement-attempt-${transactionAttempt}`,
      ])

    await service.confirmDelivery(
      order.id,
      order.organizationId,
      order.customerId,
    )

    expect(transactionAttempt).toBe(2)
    expect(
      communications.dispatchManyByDedupKeyBestEffort,
    ).toHaveBeenCalledWith([
      "settlement-attempt-2",
      `order:${order.id}:delivered`,
    ])
  })
})
