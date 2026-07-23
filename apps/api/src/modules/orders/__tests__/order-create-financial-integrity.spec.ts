import { Prisma } from "@guestpost/database"
import { OrdersService } from "../orders.service"

describe("OrdersService create financial integrity", () => {
  it("derives one priced item and returns the post-total order snapshot", async () => {
    const tx = {
      order: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({
          id: "order-1",
          status: "DRAFT",
          amount: new Prisma.Decimal(0),
        }),
        update: jest.fn().mockResolvedValue({ id: "order-1" }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: "order-1",
          status: "DRAFT",
          amount: new Prisma.Decimal(125),
          currency: "USD",
          items: [{ id: "item-1", price: new Prisma.Decimal(125) }],
          articleVersions: [],
        }),
      },
      listingService: {
        findUnique: jest.fn().mockResolvedValue({
          id: "service-1",
          listingId: "listing-1",
          serviceType: "GUEST_POST",
          availability: "AVAILABLE",
          version: 3,
          price: new Prisma.Decimal(125),
          currency: "USD",
          turnaroundDays: 7,
          warrantyDays: 30,
          listing: {
            id: "listing-1",
            status: "APPROVED",
            ownerType: "PUBLISHER",
            website: {
              id: "website-1",
              ownershipType: "PUBLISHER",
              verificationStatus: "VERIFIED",
              managedByUserId: null,
            },
          },
        }),
      },
      website: {
        findUnique: jest.fn().mockResolvedValue({
          ownershipType: "PUBLISHER",
          verificationStatus: "VERIFIED",
        }),
      },
      orderItem: { create: jest.fn().mockResolvedValue({ id: "item-1" }) },
      orderArticleVersion: { create: jest.fn() },
      orderEvent: { create: jest.fn().mockResolvedValue({ id: "event-1" }) },
      fulfillmentAssignment: { create: jest.fn() },
    }
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    }
    const service = new OrdersService(prisma as any)

    const result = await service.createOrder(
      {
        type: "GUEST_POST",
        title: "Financial integrity",
        customerId: "customer-1",
        organizationId: "organization-1",
        listingServiceId: "service-1",
        briefData: {
          kind: "GUEST_POST",
          title: "Financial integrity",
          topic: "Canonical pricing",
          targetUrl: "https://example.com/target",
          anchorText: "canonical price",
          targetKeywords: ["pricing"],
          wordCount: 700,
          niche: "Technology",
        },
      },
      "customer-1",
    )

    expect(tx.orderItem.create).toHaveBeenCalledWith({
      data: {
        orderId: "order-1",
        websiteId: "website-1",
        targetUrl: "https://example.com/target",
        anchorText: "canonical price",
        price: 125,
        status: "PENDING_PAYMENT",
      },
    })
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { amount: 125 },
    })
    expect(tx.order.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: "order-1" },
      include: { items: true, articleVersions: true },
    })
    expect(result.amount.toString()).toBe("125")
  })
})
