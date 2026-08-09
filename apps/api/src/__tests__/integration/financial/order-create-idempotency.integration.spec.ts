import crypto from "node:crypto"
import {
  makeOrganization,
  makePublisher,
  makeUser,
  makeWebsite,
} from "../factories"
import { createTestApp } from "../helpers/create-test-app"

type TestPrisma = any

async function createAvailableGuestPostService(prisma: TestPrisma) {
  const publisherOrganization = await makeOrganization(prisma)
  const publisher = await makePublisher(prisma, {
    organizationId: publisherOrganization.id,
  })
  const website = await makeWebsite(prisma, {
    publisherId: publisher.id,
    ownershipType: "PUBLISHER",
    verificationStatus: "VERIFIED",
  })
  const suffix = `${process.pid}-${crypto.randomUUID()}`
  const listing = await prisma.marketplaceListing.create({
    data: {
      title: `Idempotent order listing ${suffix}`,
      slug: `idempotent-order-listing-${suffix}`,
      description: "Canonical order-create idempotency integration fixture",
      status: "APPROVED",
      fulfillmentType: "PUBLISHER",
      ownerType: "PUBLISHER",
      currency: "USD",
      publisherId: publisher.id,
      websiteId: website.id,
      organizationId: publisherOrganization.id,
    },
  })
  const listingService = await prisma.listingService.create({
    data: {
      listingId: listing.id,
      serviceType: "GUEST_POST",
      price: 100,
      currency: "USD",
      turnaroundDays: 3,
      warrantyDays: 30,
      revisionRounds: 2,
      availability: "AVAILABLE",
    },
  })

  return { listingService }
}

async function createBuyer(prisma: TestPrisma) {
  const organization = await makeOrganization(prisma)
  const customer = await makeUser(prisma, { userType: "CUSTOMER" })
  return { organization, customer }
}

function makeCreateCommand(input: {
  organizationId: string
  customerId: string
  listingService: {
    id: string
    version: number
    price: { toString(): string }
  }
  idempotencyKey: string
  title?: string
}) {
  return {
    type: "GUEST_POST",
    title: input.title ?? "Canonical idempotent order",
    customerId: input.customerId,
    organizationId: input.organizationId,
    idempotencyKey: input.idempotencyKey,
    listingServiceId: input.listingService.id,
    expectedListingServiceVersion: input.listingService.version,
    expectedPrice: input.listingService.price.toString(),
    expectedCurrency: "USD",
    briefData: {
      kind: "GUEST_POST",
      title: "Canonical idempotent order",
      topic: "Idempotent financial operations",
      targetUrl: "https://buyer.example.test/idempotency",
      anchorText: "idempotent order processing",
      targetKeywords: ["idempotency", "financial integrity"],
      wordCount: 900,
      niche: "Technology",
    },
  }
}

function expectIdempotencyConflict(reason: unknown) {
  const error = reason as {
    getResponse?: () => unknown
    getStatus?: () => number
  }
  expect(error.getStatus?.()).toBe(409)
  expect(error.getResponse?.()).toMatchObject({
    code: "IDEMPOTENCY_KEY_REUSED",
  })
}

describe("[INTEGRATION] Financial — canonical order-create idempotency", () => {
  it("concurrently replays the same organization, key, actor, and payload as one order", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const { OrdersService } =
        require("../../../modules/orders/orders.service") as any
      const orders: any = app.get(OrdersService)
      const { listingService } = await createAvailableGuestPostService(prisma)
      const buyer = await createBuyer(prisma)
      const idempotencyKey = `same-payload-${crypto.randomUUID()}`
      const command = makeCreateCommand({
        organizationId: buyer.organization.id,
        customerId: buyer.customer.id,
        listingService,
        idempotencyKey,
      })

      const [first, replay] = await Promise.all([
        orders.createOrder(command, buyer.customer.id),
        orders.createOrder(command, buyer.customer.id),
      ])

      expect(first.id).toBe(replay.id)
      expect(first).not.toHaveProperty("idempotencyKey")
      expect(first).not.toHaveProperty("requestFingerprint")
      const persisted = await prisma.order.findMany({
        where: {
          organizationId: buyer.organization.id,
          idempotencyKey,
        },
        select: {
          id: true,
          requestFingerprint: true,
        },
      })
      expect(persisted).toEqual([
        {
          id: first.id,
          requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ])
    } finally {
      await cleanup()
    }
  })

  it("allows only one concurrent payload to bind an organization-scoped key", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const { OrdersService } =
        require("../../../modules/orders/orders.service") as any
      const orders: any = app.get(OrdersService)
      const { listingService } = await createAvailableGuestPostService(prisma)
      const buyer = await createBuyer(prisma)
      const idempotencyKey = `different-payload-${crypto.randomUUID()}`
      const common = {
        organizationId: buyer.organization.id,
        customerId: buyer.customer.id,
        listingService,
        idempotencyKey,
      }

      const attempts = await Promise.allSettled([
        orders.createOrder(
          makeCreateCommand({ ...common, title: "Competing payload A" }),
          buyer.customer.id,
        ),
        orders.createOrder(
          makeCreateCommand({ ...common, title: "Competing payload B" }),
          buyer.customer.id,
        ),
      ])

      const fulfilled = attempts.filter(
        (attempt): attempt is PromiseFulfilledResult<any> =>
          attempt.status === "fulfilled",
      )
      const rejected = attempts.filter(
        (attempt): attempt is PromiseRejectedResult =>
          attempt.status === "rejected",
      )
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expectIdempotencyConflict(rejected[0].reason)

      const persisted = await prisma.order.findMany({
        where: {
          organizationId: buyer.organization.id,
          idempotencyKey,
        },
        select: { id: true, title: true },
      })
      expect(persisted).toHaveLength(1)
      expect(persisted[0].id).toBe(fulfilled[0].value.id)
      expect(["Competing payload A", "Competing payload B"]).toContain(
        persisted[0].title,
      )
    } finally {
      await cleanup()
    }
  })

  it("keeps the same idempotency key independent across organizations", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const { OrdersService } =
        require("../../../modules/orders/orders.service") as any
      const orders: any = app.get(OrdersService)
      const { listingService } = await createAvailableGuestPostService(prisma)
      const [buyerA, buyerB] = await Promise.all([
        createBuyer(prisma),
        createBuyer(prisma),
      ])
      const idempotencyKey = `cross-organization-${crypto.randomUUID()}`

      const [orderA, orderB] = await Promise.all([
        orders.createOrder(
          makeCreateCommand({
            organizationId: buyerA.organization.id,
            customerId: buyerA.customer.id,
            listingService,
            idempotencyKey,
          }),
          buyerA.customer.id,
        ),
        orders.createOrder(
          makeCreateCommand({
            organizationId: buyerB.organization.id,
            customerId: buyerB.customer.id,
            listingService,
            idempotencyKey,
          }),
          buyerB.customer.id,
        ),
      ])

      expect(orderA.id).not.toBe(orderB.id)
      const persisted = await prisma.order.findMany({
        where: { idempotencyKey },
        orderBy: { organizationId: "asc" },
        select: {
          id: true,
          organizationId: true,
          customerId: true,
          requestFingerprint: true,
        },
      })
      expect(persisted).toHaveLength(2)
      expect(
        new Set(persisted.map((order: any) => order.organizationId)),
      ).toEqual(new Set([buyerA.organization.id, buyerB.organization.id]))
      expect(new Set(persisted.map((order: any) => order.customerId))).toEqual(
        new Set([buyerA.customer.id, buyerB.customer.id]),
      )
      expect(persisted[0].requestFingerprint).not.toBe(
        persisted[1].requestFingerprint,
      )
    } finally {
      await cleanup()
    }
  })

  it("rejects direct mutation of persisted idempotency evidence", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const { OrdersService } =
        require("../../../modules/orders/orders.service") as any
      const orders: any = app.get(OrdersService)
      const { listingService } = await createAvailableGuestPostService(prisma)
      const buyer = await createBuyer(prisma)
      const idempotencyKey = `immutable-evidence-${crypto.randomUUID()}`
      const created = await orders.createOrder(
        makeCreateCommand({
          organizationId: buyer.organization.id,
          customerId: buyer.customer.id,
          listingService,
          idempotencyKey,
        }),
        buyer.customer.id,
      )
      const before = await prisma.order.findUniqueOrThrow({
        where: { id: created.id },
        select: { idempotencyKey: true, requestFingerprint: true },
      })
      const replacementFingerprint =
        before.requestFingerprint === "f".repeat(64)
          ? "e".repeat(64)
          : "f".repeat(64)

      await expect(
        prisma.order.update({
          where: { id: created.id },
          data: { requestFingerprint: replacementFingerprint },
        }),
      ).rejects.toThrow()
      await expect(
        prisma.order.update({
          where: { id: created.id },
          data: { idempotencyKey: `replacement-${crypto.randomUUID()}` },
        }),
      ).rejects.toThrow()

      await expect(
        prisma.order.findUniqueOrThrow({
          where: { id: created.id },
          select: { idempotencyKey: true, requestFingerprint: true },
        }),
      ).resolves.toEqual(before)
    } finally {
      await cleanup()
    }
  })
})
