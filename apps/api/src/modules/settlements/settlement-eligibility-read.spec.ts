import { NotFoundException } from "@nestjs/common"
import { SettlementsService } from "./settlements.service"

function createPrisma(settlement: any) {
  const tx = {
    settlement: { findUnique: jest.fn().mockResolvedValue(settlement) },
    order: {
      findUnique: jest.fn().mockResolvedValue({
        id: "order-1",
        status: "DELIVERED",
        version: 7,
        currency: "USD",
        paymentStatus: "PAID",
        activeDeliveryVersionId: "delivery-1",
      }),
    },
    orderDeliveryVersion: {
      findUnique: jest.fn().mockResolvedValue({
        id: "delivery-1",
        orderId: "order-1",
        supersededByVersion: null,
        verificationStatus: "VERIFIED",
        interventionStatus: "NONE",
      }),
    },
    orderDispute: { findFirst: jest.fn().mockResolvedValue(null) },
    revision: { findFirst: jest.fn().mockResolvedValue(null) },
    orderCancellationRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    deliveryFraudFlag: { count: jest.fn().mockResolvedValue(0) },
  }
  return {
    tx,
    prisma: {
      $transaction: jest.fn((callback: any) => callback(tx)),
    },
  }
}

describe("SettlementsService.getSettlementEligibility", () => {
  it("returns a typed read-only snapshot from the canonical evaluator", async () => {
    const { prisma } = createPrisma({
      id: "settlement-1",
      orderId: "order-1",
      status: "CUSTOMER_APPROVED",
      version: 3,
    })
    const service = new SettlementsService(prisma as any, {} as any, {} as any)

    await expect(
      service.getSettlementEligibility("settlement-1"),
    ).resolves.toMatchObject({
      settlement: {
        id: "settlement-1",
        orderId: "order-1",
        status: "CUSTOMER_APPROVED",
        version: 3,
      },
      order: { id: "order-1", status: "DELIVERED", version: 7 },
      eligible: true,
      blockers: [],
      mutationRechecksUnderLock: true,
    })
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
    })
  })

  it("fails closed for a missing settlement", async () => {
    const { prisma } = createPrisma(null)
    const service = new SettlementsService(prisma as any, {} as any, {} as any)

    await expect(service.getSettlementEligibility("missing")).rejects.toThrow(
      NotFoundException,
    )
  })
})
