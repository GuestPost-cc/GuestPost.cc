import {
  isOperationsPlatformSupportTicket,
  operationsPlatformSupportWhere,
} from "../support-routing"

describe("Operations support routing policy", () => {
  it.each([
    [
      "explicit clean Platform routing",
      {
        orderId: "order-1",
        fulfillmentChannel: "PLATFORM" as const,
        assignedPublisherId: null,
      },
      true,
    ],
    [
      "legacy general routing",
      {
        orderId: null,
        fulfillmentChannel: null,
        assignedPublisherId: null,
      },
      true,
    ],
    [
      "a contradictory Platform publisher owner",
      {
        orderId: "order-1",
        fulfillmentChannel: "PLATFORM" as const,
        assignedPublisherId: "publisher-1",
      },
      false,
    ],
    [
      "an ambiguous null-channel order link",
      {
        orderId: "order-1",
        fulfillmentChannel: null,
        assignedPublisherId: null,
      },
      false,
    ],
  ])("classifies %s without widening authority", (_label, row, expected) => {
    expect(isOperationsPlatformSupportTicket(row)).toBe(expected)
  })

  it("builds the same fail-closed predicate for Prisma reads", () => {
    expect(operationsPlatformSupportWhere()).toEqual({
      assignedPublisherId: null,
      OR: [
        { fulfillmentChannel: "PLATFORM" },
        { fulfillmentChannel: null, orderId: null },
      ],
    })
  })
})
