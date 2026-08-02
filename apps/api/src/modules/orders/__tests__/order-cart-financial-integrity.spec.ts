import { Prisma } from "@guestpost/database"
import { OrdersService } from "../orders.service"

describe("OrdersService cart financial integrity", () => {
  it("locks Order first and atomically adds an exact Decimal-priced item", async () => {
    const calls: string[] = []
    const tx = {
      $queryRaw: jest.fn().mockImplementation(async () => {
        calls.push("lock-order")
        return [{ id: "order-1" }]
      }),
      order: {
        findFirst: jest.fn().mockImplementation(async () => {
          calls.push("read-order")
          return {
            id: "order-1",
            organizationId: "org-1",
            customerId: "user-1",
            status: "DRAFT",
            paymentStatus: "PENDING",
            currency: "USD",
            websiteId: "website-1",
            listingServiceId: "service-1",
            version: 3,
            targetUrl: null,
            anchorText: null,
          }
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      orderItem: {
        findMany: jest.fn().mockResolvedValue([{ websiteId: "website-1" }]),
        create: jest.fn().mockResolvedValue({ id: "item-2" }),
        aggregate: jest.fn().mockResolvedValue({
          _sum: { price: new Prisma.Decimal("250.00") },
        }),
      },
      listingService: {
        findUnique: jest.fn().mockResolvedValue({
          price: new Prisma.Decimal("125.00"),
          availability: "AVAILABLE",
          currency: "USD",
        }),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({ id: "event-1" }) },
    }
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) =>
        work(tx),
      ),
    }

    await new OrdersService(prisma as any).addOrderItem(
      "order-1",
      "org-1",
      { websiteId: "website-1" },
      "user-1",
      "OWNER",
    )

    expect(calls.slice(0, 2)).toEqual(["lock-order", "read-order"])
    expect(tx.orderItem.create.mock.calls[0][0].data.price.toString()).toBe(
      "125",
    )
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "order-1",
          version: 3,
          status: "DRAFT",
          paymentStatus: "PENDING",
        }),
        data: expect.objectContaining({ version: { increment: 1 } }),
      }),
    )
    expect(tx.order.updateMany.mock.calls[0][0].data.amount.toString()).toBe(
      "250",
    )
  })

  it("refuses to remove the last priced placement", async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "order-1" }]),
      order: {
        findFirst: jest.fn().mockResolvedValue({
          id: "order-1",
          organizationId: "org-1",
          customerId: "user-1",
          status: "DRAFT",
          paymentStatus: "PENDING",
          currency: "USD",
          websiteId: "website-1",
          version: 1,
        }),
      },
      orderItem: {
        findMany: jest.fn().mockResolvedValue([{ id: "item-1" }]),
        delete: jest.fn(),
      },
    }
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) =>
        work(tx),
      ),
    }

    await expect(
      new OrdersService(prisma as any).removeOrderItem(
        "order-1",
        "item-1",
        "org-1",
        "user-1",
        "OWNER",
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "ORDER_REQUIRES_ITEM" }),
    })
    expect(tx.orderItem.delete).not.toHaveBeenCalled()
  })

  it("returns a stable conflict after serializable cart retries are exhausted", async () => {
    const prisma = {
      $transaction: jest.fn().mockRejectedValue({ code: "P2034" }),
    }

    await expect(
      new OrdersService(prisma as any).addOrderItem(
        "order-1",
        "org-1",
        { websiteId: "website-1" },
        "user-1",
        "OWNER",
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "ORDER_CART_CONCURRENCY_CONFLICT",
      }),
    })
    expect(prisma.$transaction).toHaveBeenCalledTimes(3)
  })

  it.each([
    "add",
    "remove",
  ] as const)("blocks a sibling MEMBER from an %s-item cart mutation before writes", async (operation) => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "order-1" }]),
      order: {
        findFirst: jest.fn().mockResolvedValue({
          id: "order-1",
          organizationId: "org-1",
          customerId: "creator-1",
          status: "DRAFT",
          paymentStatus: "PENDING",
          currency: "USD",
          websiteId: "website-1",
          listingServiceId: "service-1",
          version: 1,
        }),
        updateMany: jest.fn(),
      },
      orderItem: {
        findMany: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
    }
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) =>
        work(tx),
      ),
    }
    const orders = new OrdersService(prisma as any)

    const request =
      operation === "add"
        ? orders.addOrderItem(
            "order-1",
            "org-1",
            { websiteId: "website-1" },
            "sibling-1",
            "MEMBER",
          )
        : orders.removeOrderItem(
            "order-1",
            "item-1",
            "org-1",
            "sibling-1",
            "MEMBER",
          )

    await expect(request).rejects.toMatchObject({ status: 403 })
    expect(tx.orderItem.findMany).not.toHaveBeenCalled()
    expect(tx.orderItem.create).not.toHaveBeenCalled()
    expect(tx.orderItem.delete).not.toHaveBeenCalled()
    expect(tx.order.updateMany).not.toHaveBeenCalled()
  })
})
