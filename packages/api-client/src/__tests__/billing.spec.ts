import { BillingService } from "../services/billing"

describe("BillingService customer cash-out containment", () => {
  it("does not advertise or dispatch the unsupported buyer withdrawal command", () => {
    const http = { post: jest.fn() }
    const billing = new BillingService(http as any)

    expect((billing as any).withdraw).toBeUndefined()
    expect(http.post).not.toHaveBeenCalled()
  })
})
