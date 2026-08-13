import { isPostPublicationPublisherOrder } from "../publisher-compensation-policy"

describe("isPostPublicationPublisherOrder", () => {
  it.each([
    "PUBLISHED",
    "VERIFIED",
    "DELIVERED",
    "COMPLETED",
  ])("requires an explicit disposition for publisher status %s", (effectiveOrderStatus) => {
    expect(
      isPostPublicationPublisherOrder({
        fulfillmentChannel: "PUBLISHER",
        effectiveOrderStatus,
      }),
    ).toBe(true)
  })

  it("uses settlement existence when a dispute hides the milestone", () => {
    expect(
      isPostPublicationPublisherOrder({
        fulfillmentChannel: "PUBLISHER",
        effectiveOrderStatus: "DISPUTED",
        hasSettlement: true,
      }),
    ).toBe(true)
  })

  it("does not require publisher disposition before publication", () => {
    expect(
      isPostPublicationPublisherOrder({
        fulfillmentChannel: "PUBLISHER",
        effectiveOrderStatus: "ACCEPTED",
      }),
    ).toBe(false)
  })

  it("never applies publisher compensation to platform fulfillment", () => {
    expect(
      isPostPublicationPublisherOrder({
        fulfillmentChannel: "PLATFORM",
        effectiveOrderStatus: "COMPLETED",
        hasSettlement: true,
      }),
    ).toBe(false)
  })

  it("uses the immutable channel before the mutable website owner", () => {
    expect(
      isPostPublicationPublisherOrder({
        fulfillmentChannel: "PUBLISHER",
        websiteOwnershipType: "PLATFORM",
        effectiveOrderStatus: "DELIVERED",
      }),
    ).toBe(true)
    expect(
      isPostPublicationPublisherOrder({
        fulfillmentChannel: "PLATFORM",
        websiteOwnershipType: "PUBLISHER",
        effectiveOrderStatus: "DELIVERED",
      }),
    ).toBe(false)
  })
})
