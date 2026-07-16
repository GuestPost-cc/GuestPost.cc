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
    amount: 100,
    version: 2,
  }

  function setup() {
    const tx = {
      wallet: {
        findUnique: jest.fn().mockResolvedValue({ id: "wallet-1", version: 4 }),
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
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ORDER_ACCEPTANCE_TIMEOUT_REFUND" }),
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
})
