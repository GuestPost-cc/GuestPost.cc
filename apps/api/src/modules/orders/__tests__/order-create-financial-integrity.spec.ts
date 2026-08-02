import { createHash } from "node:crypto"
import { Prisma } from "@guestpost/database"
import { OrdersService } from "../orders.service"

describe("OrdersService create financial integrity", () => {
  const idempotentRequest = {
    type: "GUEST_POST",
    customerId: "customer-1",
    organizationId: "organization-1",
    idempotencyKey: "create-order-1",
    listingServiceId: "service-1",
    briefData: {},
  }

  const idempotentFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        actorUserId: "customer-1",
        briefData: {},
        customerId: "customer-1",
        items: [],
        listingServiceId: "service-1",
        organizationId: "organization-1",
        type: "GUEST_POST",
      }),
    )
    .digest("hex")

  it("replays an idempotent create only when the canonical payload matches", async () => {
    const existing = {
      id: "order-existing",
      currency: "USD",
      requestFingerprint: idempotentFingerprint,
      items: [],
      articleVersions: [],
    }
    const tx = {
      order: { findUnique: jest.fn().mockResolvedValue(existing) },
    }
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    }

    const result = await new OrdersService(prisma as any).createOrder(
      idempotentRequest,
      "customer-1",
    )

    expect(result).toEqual({
      id: "order-existing",
      currency: "USD",
      items: [],
      articleVersions: [],
      website: undefined,
      events: [],
      settlements: [],
    })
    expect(result).not.toHaveProperty("requestFingerprint")
    expect(result).not.toHaveProperty("idempotencyKey")
  })

  it("rejects reuse of an idempotency key for a different payload", async () => {
    const tx = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: "order-existing",
          currency: "USD",
          requestFingerprint: idempotentFingerprint,
          items: [],
          articleVersions: [],
        }),
      },
    }
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    }

    await expect(
      new OrdersService(prisma as any).createOrder(
        { ...idempotentRequest, title: "A different order" },
        "customer-1",
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
    })
  })

  it("re-reads the database winner after a concurrent unique-key race", async () => {
    const winner = {
      id: "order-winner",
      currency: "USD",
      requestFingerprint: idempotentFingerprint,
      items: [],
      articleVersions: [],
    }
    const prisma = {
      $transaction: jest.fn().mockRejectedValue({ code: "P2002" }),
      order: { findUnique: jest.fn().mockResolvedValue(winner) },
    }

    const result = await new OrdersService(prisma as any).createOrder(
      idempotentRequest,
      "customer-1",
    )

    expect(result).toEqual({
      id: "order-winner",
      currency: "USD",
      items: [],
      articleVersions: [],
      website: undefined,
      events: [],
      settlements: [],
    })
    expect(result).not.toHaveProperty("requestFingerprint")
    expect(result).not.toHaveProperty("idempotencyKey")
    expect(prisma.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_idempotencyKey: {
            organizationId: "organization-1",
            idempotencyKey: "create-order-1",
          },
        },
      }),
    )
  })

  it("rejects a non-USD listing snapshot before creating an order", async () => {
    const tx = {
      listingService: {
        findUnique: jest.fn().mockResolvedValue({
          id: "service-eur",
          listingId: "listing-1",
          serviceType: "GUEST_POST",
          availability: "AVAILABLE",
          version: 1,
          price: new Prisma.Decimal(125),
          currency: "EUR",
          turnaroundDays: 7,
          warrantyDays: 30,
          revisionRounds: 2,
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
      order: { create: jest.fn() },
    }
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    }
    const service = new OrdersService(prisma as any)

    await expect(
      service.createOrder(
        {
          type: "GUEST_POST",
          customerId: "customer-1",
          organizationId: "organization-1",
          listingServiceId: "service-eur",
          briefData: {},
        },
        "customer-1",
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "ORDER_CURRENCY_UNSUPPORTED",
      }),
    })
    expect(tx.order.create).not.toHaveBeenCalled()
  })

  it("derives one priced item and returns the post-total order snapshot", async () => {
    const tx = {
      order: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({
          id: "order-1",
          status: "DRAFT",
          amount: new Prisma.Decimal(125),
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
          revisionRounds: 2,
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

    expect(tx.orderItem.create).toHaveBeenCalledTimes(1)
    const itemCreate = tx.orderItem.create.mock.calls[0][0]
    expect(itemCreate.data).toMatchObject({
      orderId: "order-1",
      websiteId: "website-1",
      targetUrl: "https://example.com/target",
      anchorText: "canonical price",
      status: "PENDING_PAYMENT",
    })
    expect(itemCreate.data.price.toString()).toBe("125")
    const orderCreate = tx.order.create.mock.calls[0][0]
    expect(orderCreate.data.amount.toString()).toBe("125")
    expect(orderCreate.data.revisionRoundsSnapshot).toBe(2)
    expect(tx.order.update).not.toHaveBeenCalled()
    expect(tx.order.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: "order-1" },
      include: { items: true, articleVersions: true },
    })
    expect(result.amount.toString()).toBe("125")
  })

  it.each([
    0, 10.001,
  ])("rejects invalid listing-service price %s before writing an order", async (price) => {
    const tx = {
      listingService: {
        findUnique: jest.fn().mockResolvedValue({
          id: "service-invalid",
          listingId: "listing-1",
          serviceType: "GUEST_POST",
          availability: "AVAILABLE",
          version: 1,
          price: new Prisma.Decimal(price),
          currency: "USD",
          turnaroundDays: 7,
          warrantyDays: 30,
          revisionRounds: 2,
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
      order: { create: jest.fn() },
    }
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    }

    await expect(
      new OrdersService(prisma as any).createOrder(
        {
          type: "GUEST_POST",
          customerId: "customer-1",
          organizationId: "organization-1",
          listingServiceId: "service-invalid",
          briefData: {},
        },
        "customer-1",
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "ORDER_PRICE_INVALID" }),
    })
    expect(tx.order.create).not.toHaveBeenCalled()
  })
})
