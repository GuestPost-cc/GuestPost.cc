import { MarketplaceService } from "../services/marketplace"

function listing(traffic?: number | null) {
  return {
    id: "listing-1",
    websiteId: "website-1",
    slug: "example",
    title: "Example",
    websiteUrl: null,
    fulfillmentType: "PUBLISHER",
    currency: "USD",
    price: 100,
    traffic,
  }
}

describe("MarketplaceService public metric compatibility helpers", () => {
  it.each([
    undefined,
    null,
  ])("does not turn unavailable authoritative traffic (%s) into zero", async (traffic) => {
    const client = {
      get: jest.fn().mockResolvedValue({ listings: [listing(traffic)] }),
    }
    const service = new MarketplaceService(client as any)

    const [placement] = await service.searchPlacements()

    expect(placement).not.toHaveProperty("traffic")
  })

  it("retains an authoritative zero when the API explicitly returns it", async () => {
    const client = {
      get: jest.fn().mockResolvedValue({ listings: [listing(0)] }),
    }
    const service = new MarketplaceService(client as any)

    const [placement] = await service.searchPlacements()

    expect(placement.traffic).toBe(0)
  })
})
