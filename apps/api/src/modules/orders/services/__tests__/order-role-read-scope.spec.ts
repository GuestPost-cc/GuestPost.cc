import { NotFoundException } from "@nestjs/common"
import { OrderDeliveryService } from "../order-delivery.service"
import { OrderReviewService } from "../order-review.service"

describe("order role read scoping", () => {
  const prisma = {
    order: { findFirst: jest.fn() },
    orderDeliveryVersion: { findUnique: jest.fn() },
    orderReview: { findUnique: jest.fn() },
  }
  const delivery = new OrderDeliveryService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  )
  const review = new OrderReviewService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
  )

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("scopes publisher delivery proof through website ownership", async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: "order-1",
      status: "PUBLISHED",
      activeDeliveryVersionId: null,
      fulfillmentChannel: "PUBLISHER",
      website: { ownershipType: "PUBLISHER" },
      fraudHolds: [],
    })

    await expect(
      delivery.deliveryProof("order-1", { publisherId: "publisher-1" }),
    ).resolves.toEqual({
      hasDelivery: false,
      securityReview: null,
      capabilities: {
        canConfirm: false,
        canManualAccept: false,
        blockedReason: null,
      },
    })
    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: {
        id: "order-1",
        website: { publisherId: "publisher-1" },
      },
      include: {
        website: { select: { ownershipType: true } },
        fraudHolds: {
          select: {
            fraudFlag: { select: { finding: { select: { id: true } } } },
          },
        },
      },
    })
  })

  it("scopes publisher review reads through website ownership", async () => {
    prisma.order.findFirst.mockResolvedValue({ id: "order-1" })
    prisma.orderReview.findUnique.mockResolvedValue({
      orderId: "order-1",
      rating: 5,
    })

    await expect(
      review.getReview("order-1", { publisherId: "publisher-1" }),
    ).resolves.toEqual({ orderId: "order-1", rating: 5 })
    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: {
        id: "order-1",
        website: { publisherId: "publisher-1" },
      },
      select: { id: true },
    })
  })

  it("fails closed when neither customer nor publisher scope is present", async () => {
    await expect(delivery.deliveryProof("order-1", {})).rejects.toBeInstanceOf(
      NotFoundException,
    )
    await expect(review.getReview("order-1", {})).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(prisma.order.findFirst).not.toHaveBeenCalled()
  })
})
