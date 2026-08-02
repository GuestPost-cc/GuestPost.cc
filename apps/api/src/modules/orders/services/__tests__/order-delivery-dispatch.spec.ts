import { Logger } from "@nestjs/common"
import { OrderDeliveryService } from "../order-delivery.service"

describe("OrderDeliveryService verification dispatch", () => {
  it("commits the delivery and clearly surfaces a recoverable enqueue failure", async () => {
    const version = {
      id: "delivery-1",
      orderId: "order-1",
      version: 1,
      verificationVersion: 0,
    }
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "order-1" }]),
      $transaction: jest
        .fn()
        .mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
          callback(prisma),
        ),
      orderDeliveryVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(version),
      },
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
    }
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const queue = {
      addJob: jest.fn().mockRejectedValue(new Error("redis unavailable")),
    }
    const cancellation = {
      assertNoActiveCancellation: jest.fn().mockResolvedValue(undefined),
    }
    const logger = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined)
    const service = new OrderDeliveryService(
      prisma,
      audit as any,
      queue as any,
      {} as any,
      cancellation as any,
    )

    const error = await service
      .submitDelivery(
        {
          id: "order-1",
          version: 4,
          status: "APPROVED",
          organizationId: "organization-1",
          websiteId: "website-1",
        },
        "publisher-user-1",
        { publishedUrl: "https://example.com/published-article" },
      )
      .catch((value) => value)

    expect(error.getStatus()).toBe(503)
    expect(error.getResponse()).toEqual(
      expect.objectContaining({
        code: "DELIVERY_VERIFICATION_ENQUEUE_FAILED",
        deliveryVersionId: "delivery-1",
      }),
    )
    expect(prisma.orderDeliveryVersion.create).toHaveBeenCalledTimes(1)
    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activeDeliveryVersionId: "delivery-1",
          status: "PUBLISHED",
        }),
      }),
    )
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ORDER_DELIVERY_SUBMITTED" }),
      prisma,
    )
    expect(queue.addJob).toHaveBeenCalledWith(
      "delivery-verification",
      "delivery-verify",
      expect.objectContaining({
        deliveryVersionId: "delivery-1",
        verificationVersion: 0,
      }),
      expect.objectContaining({ jobId: "delivery-verify-delivery-1-v0" }),
    )
    logger.mockRestore()
  })
})
