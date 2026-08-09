import { BillingService } from "../services/billing"

describe("BillingService deposit capability", () => {
  it("reads the authenticated fail-closed capability projection", async () => {
    const capability = {
      available: false,
      provider: "stripe",
      currency: "USD",
      code: "CARD_DEPOSITS_DISABLED",
      message: "Card deposits are temporarily unavailable.",
    }
    const http = { get: jest.fn().mockResolvedValue(capability) }
    const billing = new BillingService(http as any)

    await expect(billing.getDepositCapability()).resolves.toBe(capability)
    expect(http.get).toHaveBeenCalledWith("/billing/deposit-capability")
  })
})

describe("BillingService customer cash-out containment", () => {
  it("does not advertise or dispatch the unsupported buyer withdrawal command", () => {
    const http = { post: jest.fn() }
    const billing = new BillingService(http as any)

    expect((billing as any).withdraw).toBeUndefined()
    expect(http.post).not.toHaveBeenCalled()
  })
})
