import { PublisherPayoutsService } from "../services/publisher-payouts"

describe("PublisherPayoutsService payout-method lifecycle", () => {
  it("keeps the active-only list request free of optional query parameters", async () => {
    const client = { get: jest.fn().mockResolvedValue([]) }
    const service = new PublisherPayoutsService(client as any)

    await service.listPayoutMethods()

    expect(client.get).toHaveBeenCalledWith(
      "/publisher-payouts/payout-methods",
      undefined,
    )
  })

  it("requests inactive lifecycle rows only when explicitly included", async () => {
    const client = { get: jest.fn().mockResolvedValue([]) }
    const service = new PublisherPayoutsService(client as any)

    await service.listPayoutMethods(true)

    expect(client.get).toHaveBeenCalledWith(
      "/publisher-payouts/payout-methods",
      { params: { includeInactive: "true" } },
    )
  })

  it.each([
    ["deactivatePayoutMethod", "deactivate"],
    ["reactivatePayoutMethod", "reactivate"],
  ] as const)("%s calls the explicit lifecycle endpoint", async (methodName, action) => {
    const client = {
      post: jest.fn().mockResolvedValue({
        id: "pm-1",
        isActive: action === "reactivate",
        replayed: false,
      }),
    }
    const service = new PublisherPayoutsService(client as any)

    await service[methodName]("pm-1")

    expect(client.post).toHaveBeenCalledWith(
      `/publisher-payouts/payout-methods/pm-1/${action}`,
    )
  })
})
