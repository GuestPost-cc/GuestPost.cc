import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common"
import { OrderReviewService } from "../order-review.service"
import { closeActiveRevisionForResubmission } from "../revision-lifecycle"

describe("OrderReviewService revision lifecycle", () => {
  const baseOrder = {
    id: "order-1",
    organizationId: "org-1",
    customerId: "user-1",
    status: "CUSTOMER_REVIEW",
    version: 7,
    revisionCount: 1,
    revisionRoundsSnapshot: 2,
    listingId: "listing-1",
    listingServiceId: "listing-service-1",
    fulfillmentChannel: "PUBLISHER",
    items: [],
  }

  function setup(order: any = baseOrder) {
    const updatedOrder = {
      ...order,
      status: "CONTENT_REQUESTED",
      version: order.version + 1,
      revisionCount: order.revisionCount + 1,
    }
    const prisma: any = {
      order: {
        findFirst: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(updatedOrder),
      },
      listingService: {
        findUnique: jest.fn().mockResolvedValue({ revisionRounds: 2 }),
      },
      membership: {
        findFirst: jest.fn().mockResolvedValue({ role: "OWNER" }),
      },
      revision: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: "revision-1" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "order-1" }]),
    }
    prisma.$transaction = jest
      .fn()
      .mockImplementation(async (operation: (tx: any) => Promise<any>) =>
        operation(prisma),
      )
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const cancellation = {
      assertNoActiveCancellation: jest.fn().mockResolvedValue(undefined),
    }
    const service = new OrderReviewService(
      prisma,
      audit as any,
      {} as any,
      cancellation as any,
    )
    return { service, prisma, audit, cancellation, updatedOrder }
  }

  it("revalidates policy only after locking the canonical Order row", async () => {
    const { service, prisma, cancellation, updatedOrder } = setup()

    await expect(
      service.requestRevision(
        "order-1",
        "org-1",
        "user-1",
        "Please update this content.",
      ),
    ).resolves.toEqual(updatedOrder)

    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.order.findFirst.mock.invocationCallOrder[0],
    )
    expect(cancellation.assertNoActiveCancellation).toHaveBeenCalledWith(
      "order-1",
      prisma,
    )
    expect(prisma.listingService.findUnique).not.toHaveBeenCalled()
    expect(prisma.membership.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        userId: "user-1",
        status: "ACTIVE",
      },
      select: { role: true },
    })
    expect(prisma.revision.create).toHaveBeenCalledWith({
      data: {
        orderId: "order-1",
        notes: "Please update this content.",
        status: "REQUESTED",
      },
    })
  })

  it.each([
    "DELIVERED",
    "COMPLETED",
    "CANCELLED",
    "REFUNDED",
  ])("rejects a revision once the order is %s", async (status) => {
    const { service, prisma, cancellation } = setup({
      ...baseOrder,
      status,
    })

    await expect(
      service.requestRevision(
        "order-1",
        "org-1",
        "user-1",
        "Please update this content.",
      ),
    ).rejects.toBeInstanceOf(BadRequestException)

    expect(prisma.revision.create).not.toHaveBeenCalled()
    expect(cancellation.assertNoActiveCancellation).not.toHaveBeenCalled()
  })

  it("fails closed when a cancellation hold is active", async () => {
    const { service, prisma, cancellation } = setup()
    cancellation.assertNoActiveCancellation.mockRejectedValue(
      new ConflictException("Cancellation hold"),
    )

    await expect(
      service.requestRevision(
        "order-1",
        "org-1",
        "user-1",
        "Please update this content.",
      ),
    ).rejects.toBeInstanceOf(ConflictException)

    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.revision.create).not.toHaveBeenCalled()
  })

  it("enforces the snapshotted revision limit under the Order lock", async () => {
    const { service, prisma } = setup({
      ...baseOrder,
      revisionCount: 2,
    })

    await expect(
      service.requestRevision(
        "order-1",
        "org-1",
        "user-1",
        "Please update this content.",
      ),
    ).rejects.toThrow(/Maximum revisions \(2\) reached/i)

    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.revision.create).not.toHaveBeenCalled()
  })

  it("fails closed when immutable revision-policy evidence is missing", async () => {
    const { service, prisma } = setup({
      ...baseOrder,
      revisionRoundsSnapshot: null,
    })

    await expect(
      service.requestRevision(
        "order-1",
        "org-1",
        "user-1",
        "Please update this content.",
      ),
    ).rejects.toBeInstanceOf(ConflictException)

    expect(prisma.listingService.findUnique).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it("rejects an active non-owner member who did not create the order", async () => {
    const { service, prisma } = setup({
      ...baseOrder,
      customerId: "another-user",
    })
    prisma.membership.findFirst.mockResolvedValue({ role: "MEMBER" })

    await expect(
      service.requestRevision(
        "order-1",
        "org-1",
        "user-1",
        "Please update this content.",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)

    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.revision.create).not.toHaveBeenCalled()
  })

  it("rejects an order creator whose organization membership is no longer active", async () => {
    const { service, prisma } = setup()
    prisma.membership.findFirst.mockResolvedValue(null)

    await expect(
      service.requestRevision(
        "order-1",
        "org-1",
        "user-1",
        "Please update this content.",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)

    expect(prisma.membership.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        userId: "user-1",
        status: "ACTIVE",
      },
      select: { role: true },
    })
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.revision.create).not.toHaveBeenCalled()
  })

  it("requires replacement content to close the active request before another round", async () => {
    const { service, prisma } = setup()
    prisma.revision.findMany.mockResolvedValueOnce([{ id: "revision-open" }])

    await expect(
      service.requestRevision(
        "order-1",
        "org-1",
        "user-1",
        "Please update this content.",
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "REVISION_ALREADY_ACTIVE" }),
    })
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it("terminalizes round one on resubmission so round two can be requested", async () => {
    const active = [{ id: "revision-round-1" }]
    const tx = {
      revision: {
        findMany: jest.fn().mockImplementation(async () => active),
        updateMany: jest.fn().mockImplementation(async () => {
          active.splice(0, active.length)
          return { count: 1 }
        }),
      },
    }

    await expect(
      closeActiveRevisionForResubmission(tx, "order-1"),
    ).resolves.toBe("revision-round-1")
    expect(tx.revision.updateMany).toHaveBeenCalledWith({
      where: {
        id: "revision-round-1",
        orderId: "order-1",
        status: { notIn: ["APPROVED", "REJECTED"] },
      },
      data: { status: "APPROVED" },
    })
    await expect(
      closeActiveRevisionForResubmission(tx, "order-1"),
    ).resolves.toBeNull()
  })
})
