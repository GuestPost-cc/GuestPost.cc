import { loadSettlementCustomerHistory } from "../workflow/settlement-risk"

function setup(chargebackCount = 0, disputeCount = 0) {
  const tx = {
    paymentDispute: {
      count: jest.fn().mockResolvedValue(chargebackCount),
    },
    orderDispute: {
      count: jest.fn().mockResolvedValue(disputeCount),
    },
  }
  return tx
}

describe("loadSettlementCustomerHistory", () => {
  it("combines organization evidence with legacy direct-customer evidence", async () => {
    const tx = setup(2, 3)

    await expect(
      loadSettlementCustomerHistory(tx, {
        organizationId: "org-1",
        customerId: "customer-1",
      }),
    ).resolves.toEqual({ chargebackCount: 2, disputeCount: 3 })

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
    expect(tx.orderDispute.count).toHaveBeenCalledWith({
      where: {
        order: {
          OR: [{ organizationId: "org-1" }, { customerId: "customer-1" }],
        },
      },
    })
  })

  it("does not broaden a tenant-scoped lookup when only one identity exists", async () => {
    const tx = setup()

    await loadSettlementCustomerHistory(tx, {
      organizationId: "org-1",
      customerId: null,
    })

    expect(tx.paymentDispute.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { depositAttempt: { organizationId: "org-1" } },
          { wallet: { organizationId: "org-1" } },
        ],
      },
    })
  })

  it("fails closed before querying when customer scope is unavailable", async () => {
    const tx = setup()

    await expect(
      loadSettlementCustomerHistory(tx, {
        organizationId: "  ",
        customerId: null,
      }),
    ).rejects.toThrow("Settlement customer risk scope is unavailable")
    expect(tx.paymentDispute.count).not.toHaveBeenCalled()
    expect(tx.orderDispute.count).not.toHaveBeenCalled()
  })

  it.each([
    ["negative chargeback count", -1, 0],
    ["fractional dispute count", 0, 0.5],
    ["unsafe chargeback count", Number.MAX_SAFE_INTEGER + 1, 0],
  ])("fails closed for %s", async (_label, chargebacks, disputes) => {
    await expect(
      loadSettlementCustomerHistory(setup(chargebacks, disputes), {
        organizationId: "org-1",
        customerId: "customer-1",
      }),
    ).rejects.toThrow(/history count is invalid/)
  })

  it("propagates database failures instead of treating history as clean", async () => {
    const tx = setup()
    const databaseFailure = new Error("database unavailable")
    tx.paymentDispute.count.mockRejectedValue(databaseFailure)

    await expect(
      loadSettlementCustomerHistory(tx, {
        organizationId: "org-1",
        customerId: "customer-1",
      }),
    ).rejects.toBe(databaseFailure)
  })
})
