import {
  OrderRefundConflictError,
  refundUnacceptedPaidOrderInTransaction,
} from "../order-refund-core"

describe("unaccepted order refund core", () => {
  const order = {
    id: "order-1",
    organizationId: "org-1",
    status: "SUBMITTED",
    paymentStatus: "PAID",
    currency: "USD",
    amount: 100,
    version: 2,
  }

  function setup() {
    const tx = {
      wallet: {
        findUnique: jest.fn().mockResolvedValue({
          id: "wallet-1",
          version: 4,
          currency: "USD",
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ ...order, status: "REFUNDED" }),
      },
      fulfillmentAssignment: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      transaction: {
        create: jest.fn().mockResolvedValue({ id: "refund-1" }),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
    }
    return tx
  }

  it("credits the wallet, closes assignments, records responsibility and audits", async () => {
    const tx = setup()
    const writeAudit = jest.fn().mockResolvedValue({})

    const result = await refundUnacceptedPaidOrderInTransaction(
      tx,
      order,
      {
        reference: "acceptance-timeout:order-1",
        reason: "Acceptance deadline missed",
        responsibility: "PUBLISHER",
        actorUserId: null,
        auditAction: "ORDER_ACCEPTANCE_TIMEOUT_REFUND",
      },
      writeAudit,
    )

    expect(result.refundTransactionId).toBe("refund-1")
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: "wallet-1", version: 4 },
      data: {
        availableBalance: { increment: 100 },
        version: { increment: 1 },
      },
    })
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "REFUNDED",
          paymentStatus: "REFUNDED",
          refundResponsibility: "PUBLISHER",
        }),
      }),
    )
    expect(tx.fulfillmentAssignment.updateMany).toHaveBeenCalled()
    expect(tx.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        description: "Refund for order order-1",
      }),
    })
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORDER_ACCEPTANCE_TIMEOUT_REFUND",
        metadata: expect.objectContaining({
          reason: "Acceptance deadline missed",
        }),
      }),
      tx,
    )
  })

  it("fails closed on a concurrent wallet update", async () => {
    const tx = setup()
    tx.wallet.updateMany.mockResolvedValue({ count: 0 })

    await expect(
      refundUnacceptedPaidOrderInTransaction(
        tx,
        order,
        {
          reference: "acceptance-timeout:order-1",
          reason: "Acceptance deadline missed",
          responsibility: "PUBLISHER",
          actorUserId: null,
          auditAction: "ORDER_ACCEPTANCE_TIMEOUT_REFUND",
        },
        jest.fn(),
      ),
    ).rejects.toBeInstanceOf(OrderRefundConflictError)
  })

  it.each([
    ["order", { ...order, currency: "EUR" }, "USD"],
    ["wallet", order, "GBP"],
  ])("fails closed on a non-USD %s", async (_label, candidateOrder, walletCurrency) => {
    const tx = setup()
    tx.wallet.findUnique.mockResolvedValue({
      id: "wallet-1",
      version: 4,
      currency: walletCurrency,
    })

    await expect(
      refundUnacceptedPaidOrderInTransaction(
        tx,
        candidateOrder,
        {
          reference: "acceptance-timeout:order-1",
          reason: "Acceptance deadline missed",
          responsibility: "PUBLISHER",
          actorUserId: null,
          auditAction: "ORDER_ACCEPTANCE_TIMEOUT_REFUND",
        },
        jest.fn(),
      ),
    ).rejects.toBeInstanceOf(OrderRefundConflictError)
    expect(tx.wallet.updateMany).not.toHaveBeenCalled()
    expect(tx.transaction.create).not.toHaveBeenCalled()
  })
})
