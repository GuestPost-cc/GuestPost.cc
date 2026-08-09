import { assertCanonicalPlatformRevenueFundingCore } from "../platform-revenue-evidence"

const order = {
  id: "order-1",
  amount: "100.00",
  currency: "USD",
  paymentStatus: "PAID",
  fulfillmentChannel: "PLATFORM",
  organizationId: "org-1",
}

function purchase(overrides: Record<string, unknown> = {}) {
  return {
    amount: "-100.00",
    currency: "USD",
    walletId: "wallet-1",
    publisherId: null,
    settlementId: null,
    provider: null,
    providerRef: null,
    wallet: { currency: "USD", organizationId: "org-1" },
    ...overrides,
  }
}

describe("canonical PlatformRevenue funding evidence", () => {
  it("accepts one exact internal PURCHASE from the order organization wallet", async () => {
    const findMany = jest.fn().mockResolvedValue([purchase()])

    await expect(
      assertCanonicalPlatformRevenueFundingCore(
        { transaction: { findMany } },
        order,
      ),
    ).resolves.toBeUndefined()

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: "order-1", type: "PURCHASE" },
        take: 2,
      }),
    )
  })

  it.each([
    ["missing purchase", []],
    ["duplicate purchases", [purchase(), purchase()]],
    ["wrong amount", [purchase({ amount: "-99.99" })]],
    ["positive amount", [purchase({ amount: "100.00" })]],
    ["provider identity", [purchase({ provider: "stripe" })]],
    [
      "another organization wallet",
      [purchase({ wallet: { currency: "USD", organizationId: "org-2" } })],
    ],
  ])("rejects %s", async (_label, rows) => {
    await expect(
      assertCanonicalPlatformRevenueFundingCore(
        {
          transaction: {
            findMany: jest.fn().mockResolvedValue(rows),
          },
        },
        order,
      ),
    ).rejects.toThrow(/one exact canonical PURCHASE/)
  })

  it.each([
    ["non-USD", { currency: "EUR" }],
    ["unpaid", { paymentStatus: "PENDING" }],
    ["publisher channel", { fulfillmentChannel: "PUBLISHER" }],
    ["sub-cent amount", { amount: "100.001" }],
  ])("rejects a %s order before reading ledger evidence", async (_label, patch) => {
    const findMany = jest.fn()
    await expect(
      assertCanonicalPlatformRevenueFundingCore(
        { transaction: { findMany } },
        { ...order, ...patch },
      ),
    ).rejects.toThrow(/paid exact-USD PLATFORM order/)
    expect(findMany).not.toHaveBeenCalled()
  })
})
