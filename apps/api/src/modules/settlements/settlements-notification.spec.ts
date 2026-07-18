import { SettlementsService } from "./settlements.service"

describe("SettlementsService release notifications", () => {
  const settlement = {
    id: "settlement-1",
    orderId: "order-1",
    publisherId: "publisher-1",
    publisherAmount: "100.00",
    order: { organizationId: "customer-org", customerId: "customer-1" },
  }

  function setup() {
    const prisma = {
      publisherMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "publisher-user" }]),
      },
      publisher: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ organizationId: "publisher-org" }),
      },
    }
    const queue = { pushNotification: jest.fn().mockResolvedValue({}) }
    const service = new SettlementsService(
      prisma as any,
      {} as any,
      queue as any,
    )
    return { prisma, queue, service }
  }

  it("explains how a debt-netted settlement affected withdrawable balance", async () => {
    const { queue, service } = setup()

    await (service as any).notifySettlementReleased(settlement, {
      publisherAmount: "100.00",
      debtApplied: "80.00",
      credited: "20.00",
      currency: "USD",
    })

    expect(queue.pushNotification).toHaveBeenCalledWith(
      "push-in-app",
      expect.objectContaining({
        userId: "publisher-user",
        organizationId: "publisher-org",
        type: "SETTLEMENT_RELEASED",
        message: expect.stringMatching(
          /80\.00 USD repaid outstanding debt.*20\.00 USD was credited/,
        ),
      }),
      "settlement-released:settlement-1:publisher-user",
    )
  })

  it("still notifies the customer when publisher recipient lookup fails", async () => {
    const { prisma, queue, service } = setup()
    prisma.publisherMembership.findMany.mockRejectedValue(
      new Error("database temporarily unavailable"),
    )

    await expect(
      (service as any).notifySettlementReleased(settlement, {
        publisherAmount: "100.00",
        debtApplied: "0.00",
        credited: "100.00",
        currency: "USD",
      }),
    ).resolves.toBeUndefined()
    expect(queue.pushNotification).toHaveBeenCalledTimes(1)
    expect(queue.pushNotification).toHaveBeenCalledWith(
      "push-in-app",
      expect.objectContaining({ userId: "customer-1" }),
      "settlement-released:settlement-1:customer-1",
    )
  })
})
