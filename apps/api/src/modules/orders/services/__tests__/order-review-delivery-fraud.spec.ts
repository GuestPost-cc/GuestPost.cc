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
      deliveryFraudHold: {
        findMany: jest.fn().mockResolvedValue([
          {
            fraudFlagId: "flag-1",
            deliveryVersionId: "delivery-1",
            type: "URL_REUSED",
          },
        ]),
      },
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
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
})
