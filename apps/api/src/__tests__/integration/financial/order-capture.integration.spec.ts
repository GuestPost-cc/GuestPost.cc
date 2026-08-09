import crypto from "node:crypto"
import {
  makeOrder,
  makeOrderItem,
  makeOrganization,
  makePublisher,
  makeTransaction,
  makeUser,
  makeWallet,
  makeWebsite,
} from "../factories"
import { createTestApp } from "../helpers/create-test-app"

describe("[INTEGRATION] Financial — canonical order wallet capture", () => {
  it("captures once under concurrent submissions and writes exact USD evidence", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const organization = await makeOrganization(prisma)
      const customer = await makeUser(prisma, { userType: "CUSTOMER" })
      const publisher = await makePublisher(prisma, {
        organizationId: organization.id,
      })
      const website = await makeWebsite(prisma, {
        publisherId: publisher.id,
        ownershipType: "PUBLISHER",
      })
      const suffix = `${process.pid}-${crypto.randomUUID()}`
      const listing = await prisma.marketplaceListing.create({
        data: {
          title: `Capture listing ${suffix}`,
          slug: `capture-listing-${suffix}`,
          description: "Order capture integration fixture",
          status: "APPROVED",
          fulfillmentType: "PUBLISHER",
          ownerType: "PUBLISHER",
          currency: "USD",
          publisherId: publisher.id,
          websiteId: website.id,
          organizationId: organization.id,
        },
      })
      const listingService = await prisma.listingService.create({
        data: {
          listingId: listing.id,
          serviceType: "GUEST_POST",
          price: 100,
          currency: "USD",
          turnaroundDays: 3,
          availability: "AVAILABLE",
        },
      })
      const order = await makeOrder(prisma, {
        organizationId: organization.id,
        customerId: customer.id,
        websiteId: website.id,
        status: "DRAFT",
        amount: 100,
        currency: "USD",
        paymentStatus: "PENDING",
        fulfillmentChannel: "PUBLISHER",
        listingId: listing.id,
        listingServiceId: listingService.id,
        revisionRoundsSnapshot: listingService.revisionRounds,
        turnaroundDays: 3,
      })
      await makeOrderItem(prisma, {
        orderId: order.id,
        websiteId: website.id,
        price: 100,
        status: "PENDING_PAYMENT",
      })
      const wallet = await makeWallet(prisma, {
        organizationId: organization.id,
        availableBalance: 100,
      })
      await makeTransaction(prisma, {
        walletId: wallet.id,
        amount: 100,
        type: "DEPOSIT",
        reference: `capture-deposit-${suffix}`,
        description: "Canonical order capture test funding",
      })

      const { OrderPaymentService } =
        require("../../../modules/orders/services/order-payment.service") as any
      const payments: any = app.get(OrderPaymentService)
      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          payments.submitPayment(
            order.id,
            customer.id,
            organization.id,
            "OWNER",
            {
              expectedVersion: order.version,
              expectedAmount: "100.00",
              expectedCurrency: "USD",
            },
          ),
        ),
      )

      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(1)
      expect(
        attempts.filter((attempt) => attempt.status === "rejected"),
      ).toHaveLength(4)

      const [storedOrder, storedWallet, purchaseRows, reservationRows] =
        await Promise.all([
          prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
          prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
          prisma.transaction.findMany({
            where: { orderId: order.id, type: "PURCHASE" },
          }),
          prisma.transaction.findMany({
            where: { orderId: order.id, type: "RESERVATION" },
          }),
        ])

      expect(storedOrder.status).toBe("SUBMITTED")
      expect(storedOrder.paymentStatus).toBe("PAID")
      expect(Number(storedWallet.availableBalance)).toBe(0)
      expect(Number(storedWallet.reservedBalance)).toBe(0)
      expect(purchaseRows).toHaveLength(1)
      expect(Number(purchaseRows[0].amount)).toBe(-100)
      expect(purchaseRows[0]).toMatchObject({
        walletId: wallet.id,
        orderId: order.id,
        currency: "USD",
        provider: null,
        providerRef: null,
      })
      expect(reservationRows).toHaveLength(1)
      expect(Number(reservationRows[0].amount)).toBe(-100)
    } finally {
      await cleanup()
    }
  }, 30_000)

  it("never lets a stale concurrent submission adopt a server-side reprice", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const organization = await makeOrganization(prisma)
      const customer = await makeUser(prisma, { userType: "CUSTOMER" })
      const publisher = await makePublisher(prisma, {
        organizationId: organization.id,
      })
      const website = await makeWebsite(prisma, {
        publisherId: publisher.id,
        ownershipType: "PUBLISHER",
      })
      const suffix = `${process.pid}-${crypto.randomUUID()}`
      const listing = await prisma.marketplaceListing.create({
        data: {
          title: `Stale capture ${suffix}`,
          slug: `stale-capture-${suffix}`,
          description: "Stale checkout evidence integration fixture",
          status: "APPROVED",
          fulfillmentType: "PUBLISHER",
          ownerType: "PUBLISHER",
          currency: "USD",
          publisherId: publisher.id,
          websiteId: website.id,
          organizationId: organization.id,
        },
      })
      const listingService = await prisma.listingService.create({
        data: {
          listingId: listing.id,
          serviceType: "GUEST_POST",
          price: 100,
          currency: "USD",
          turnaroundDays: 3,
          availability: "AVAILABLE",
        },
      })
      const order = await makeOrder(prisma, {
        organizationId: organization.id,
        customerId: customer.id,
        websiteId: website.id,
        status: "DRAFT",
        amount: 100,
        currency: "USD",
        paymentStatus: "PENDING",
        fulfillmentChannel: "PUBLISHER",
        listingId: listing.id,
        listingServiceId: listingService.id,
        revisionRoundsSnapshot: listingService.revisionRounds,
        turnaroundDays: listingService.turnaroundDays,
      })
      await makeOrderItem(prisma, {
        orderId: order.id,
        websiteId: website.id,
        price: 100,
        status: "PENDING_PAYMENT",
      })
      const wallet = await makeWallet(prisma, {
        organizationId: organization.id,
        availableBalance: 100,
      })
      await makeTransaction(prisma, {
        walletId: wallet.id,
        amount: 100,
        type: "DEPOSIT",
        reference: `stale-capture-deposit-${suffix}`,
      })
      await prisma.listingService.update({
        where: { id: listingService.id },
        data: { price: 125, version: { increment: 1 } },
      })

      const { OrderPaymentService } =
        require("../../../modules/orders/services/order-payment.service") as any
      const payments: any = app.get(OrderPaymentService)
      const command = {
        expectedVersion: order.version,
        expectedAmount: "100.00",
        expectedCurrency: "USD",
      }
      const attempts = await Promise.allSettled([
        payments.submitPayment(
          order.id,
          customer.id,
          organization.id,
          "OWNER",
          command,
        ),
        payments.submitPayment(
          order.id,
          customer.id,
          organization.id,
          "OWNER",
          command,
        ),
      ])

      expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(
        true,
      )
      const [storedOrder, storedItems, storedWallet, moneyRows] =
        await Promise.all([
          prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
          prisma.orderItem.findMany({ where: { orderId: order.id } }),
          prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
          prisma.transaction.findMany({
            where: {
              orderId: order.id,
              type: { in: ["RESERVATION", "PURCHASE"] },
            },
          }),
        ])
      expect(storedOrder).toMatchObject({
        status: "DRAFT",
        paymentStatus: "PENDING",
        version: order.version + 1,
      })
      expect(storedOrder.amount.toString()).toBe("125")
      expect(storedItems).toHaveLength(1)
      expect(storedItems[0].price?.toString()).toBe("125")
      expect(Number(storedWallet.availableBalance)).toBe(100)
      expect(Number(storedWallet.reservedBalance)).toBe(0)
      expect(moneyRows).toHaveLength(0)
    } finally {
      await cleanup()
    }
  }, 30_000)

  it.each([
    { mutation: "add" as const, initialItems: 1 },
    { mutation: "remove" as const, initialItems: 2 },
  ])("serializes $mutation-item against capture without total or ledger drift", async ({
    mutation,
    initialItems,
  }) => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const organization = await makeOrganization(prisma)
      const customer = await makeUser(prisma, { userType: "CUSTOMER" })
      const publisher = await makePublisher(prisma, {
        organizationId: organization.id,
      })
      const website = await makeWebsite(prisma, {
        publisherId: publisher.id,
        ownershipType: "PUBLISHER",
      })
      const suffix = `${process.pid}-${crypto.randomUUID()}`
      const listing = await prisma.marketplaceListing.create({
        data: {
          title: `Capture race ${suffix}`,
          slug: `capture-race-${suffix}`,
          description: "Order capture race fixture",
          status: "APPROVED",
          fulfillmentType: "PUBLISHER",
          ownerType: "PUBLISHER",
          currency: "USD",
          publisherId: publisher.id,
          websiteId: website.id,
          organizationId: organization.id,
        },
      })
      const listingService = await prisma.listingService.create({
        data: {
          listingId: listing.id,
          serviceType: "GUEST_POST",
          price: 100,
          currency: "USD",
          turnaroundDays: 3,
          availability: "AVAILABLE",
        },
      })
      const initialAmount = initialItems * 100
      const order = await makeOrder(prisma, {
        organizationId: organization.id,
        customerId: customer.id,
        websiteId: website.id,
        status: "DRAFT",
        amount: initialAmount,
        currency: "USD",
        paymentStatus: "PENDING",
        fulfillmentChannel: "PUBLISHER",
        listingId: listing.id,
        listingServiceId: listingService.id,
        revisionRoundsSnapshot: listingService.revisionRounds,
        turnaroundDays: 3,
      })
      const itemIds: string[] = []
      for (let index = 0; index < initialItems; index += 1) {
        const item = await makeOrderItem(prisma, {
          orderId: order.id,
          websiteId: website.id,
          price: 100,
          status: "PENDING_PAYMENT",
        })
        itemIds.push(item.id)
      }
      const wallet = await makeWallet(prisma, {
        organizationId: organization.id,
        availableBalance: initialAmount + 100,
      })
      await makeTransaction(prisma, {
        walletId: wallet.id,
        amount: initialAmount + 100,
        type: "DEPOSIT",
        reference: `capture-race-deposit-${suffix}`,
        description: "Order capture race funding",
      })

      const { OrderPaymentService } =
        require("../../../modules/orders/services/order-payment.service") as any
      const { OrdersService } =
        require("../../../modules/orders/orders.service") as any
      const payments: any = app.get(OrderPaymentService)
      const orders: any = app.get(OrdersService)
      const mutationPromise =
        mutation === "add"
          ? orders.addOrderItem(
              order.id,
              organization.id,
              { websiteId: website.id },
              customer.id,
              "OWNER",
            )
          : orders.removeOrderItem(
              order.id,
              itemIds[itemIds.length - 1],
              organization.id,
              customer.id,
              "OWNER",
            )
      const [mutationResult, paymentResult] = await Promise.allSettled([
        mutationPromise,
        payments.submitPayment(
          order.id,
          customer.id,
          organization.id,
          "OWNER",
          {
            expectedVersion: order.version,
            expectedAmount: `${initialAmount}.00`,
            expectedCurrency: "USD",
          },
        ),
      ])

      expect(
        [mutationResult, paymentResult].filter(
          (result) => result.status === "fulfilled",
        ),
      ).toHaveLength(1)
      const [storedOrder, storedItems, storedWallet, purchases] =
        await Promise.all([
          prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
          prisma.orderItem.findMany({ where: { orderId: order.id } }),
          prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
          prisma.transaction.findMany({
            where: { orderId: order.id, type: "PURCHASE" },
          }),
        ])

      const captureWon = paymentResult.status === "fulfilled"
      const expectedItems = captureWon
        ? initialItems
        : mutation === "add"
          ? initialItems + 1
          : initialItems - 1
      expect(storedItems).toHaveLength(expectedItems)
      expect(storedOrder.amount.toString()).toBe(`${expectedItems * 100}`)
      expect(
        storedItems.reduce(
          (sum: number, item: any) => sum + Number(item.price),
          0,
        ),
      ).toBe(Number(storedOrder.amount))
      expect(
        storedItems.every((item: any) => item.status === "PENDING_PAYMENT"),
      ).toBe(true)
      expect(storedOrder.paymentStatus).toBe(captureWon ? "PAID" : "PENDING")
      expect(storedOrder.status).toBe(captureWon ? "SUBMITTED" : "DRAFT")
      expect(purchases).toHaveLength(captureWon ? 1 : 0)
      if (captureWon) {
        expect(purchases[0].amount.toString()).toBe(`${-initialAmount}`)
      }
      expect(Number(storedWallet.availableBalance)).toBe(
        captureWon ? 100 : initialAmount + 100,
      )
      expect(Number(storedWallet.reservedBalance)).toBe(0)
    } finally {
      await cleanup()
    }
  }, 30_000)

  it("enforces positive whole-cent prices and freezes paid item identity in PostgreSQL", async () => {
    const { prisma, cleanup } = await createTestApp()
    try {
      const organization = await makeOrganization(prisma)
      const customer = await makeUser(prisma, { userType: "CUSTOMER" })
      const publisher = await makePublisher(prisma, {
        organizationId: organization.id,
      })
      const website = await makeWebsite(prisma, {
        publisherId: publisher.id,
        ownershipType: "PUBLISHER",
      })
      const suffix = `${process.pid}-${crypto.randomUUID()}`
      const listing = await prisma.marketplaceListing.create({
        data: {
          title: `Invalid price ${suffix}`,
          slug: `invalid-price-${suffix}`,
          description: "Invalid price database fixture",
          status: "APPROVED",
          fulfillmentType: "PUBLISHER",
          ownerType: "PUBLISHER",
          currency: "USD",
          publisherId: publisher.id,
          websiteId: website.id,
          organizationId: organization.id,
        },
      })

      for (const price of [0, 10.001]) {
        await expect(
          prisma.listingService.create({
            data: {
              listingId: listing.id,
              serviceType: price === 0 ? "NICHE_EDIT" : "EDITORIAL_LINK",
              price,
              currency: "USD",
              turnaroundDays: 3,
            },
          }),
        ).rejects.toBeDefined()
      }

      const listingService = await prisma.listingService.create({
        data: {
          listingId: listing.id,
          serviceType: "GUEST_POST",
          price: 100,
          currency: "USD",
          turnaroundDays: 3,
          availability: "AVAILABLE",
        },
      })

      for (const amount of [0, 10.001]) {
        await expect(
          makeOrder(prisma, {
            organizationId: organization.id,
            customerId: customer.id,
            websiteId: website.id,
            status: "DRAFT",
            paymentStatus: "PENDING",
            amount,
            fulfillmentChannel: "PUBLISHER",
          }),
        ).rejects.toBeDefined()
      }

      const order = await makeOrder(prisma, {
        organizationId: organization.id,
        customerId: customer.id,
        websiteId: website.id,
        status: "DRAFT",
        paymentStatus: "PENDING",
        amount: 100,
        fulfillmentChannel: "PUBLISHER",
        listingId: listing.id,
        listingServiceId: listingService.id,
        revisionRoundsSnapshot: listingService.revisionRounds,
        turnaroundDays: listingService.turnaroundDays,
      })

      const crossWebsite = await makeWebsite(prisma, {
        publisherId: publisher.id,
        ownershipType: "PUBLISHER",
      })
      await expect(
        makeOrder(prisma, {
          organizationId: organization.id,
          customerId: customer.id,
          websiteId: crossWebsite.id,
          status: "DRAFT",
          paymentStatus: "PENDING",
          amount: 100,
          fulfillmentChannel: "PUBLISHER",
          listingId: listing.id,
          listingServiceId: listingService.id,
          revisionRoundsSnapshot: listingService.revisionRounds,
          turnaroundDays: listingService.turnaroundDays,
        }),
      ).rejects.toBeDefined()

      const unattributedOrder = await makeOrder(prisma, {
        organizationId: organization.id,
        customerId: customer.id,
        status: "DRAFT",
        paymentStatus: "PENDING",
        amount: 100,
        fulfillmentChannel: "PUBLISHER",
      })
      await makeOrderItem(prisma, {
        orderId: unattributedOrder.id,
        websiteId: null,
        price: 100,
        status: "PENDING_PAYMENT",
      })
      await expect(
        prisma.order.update({
          where: { id: unattributedOrder.id },
          data: { status: "PAID", paymentStatus: "PAID" },
        }),
      ).rejects.toBeDefined()
      for (const price of [0, 10.001]) {
        await expect(
          makeOrderItem(prisma, {
            orderId: order.id,
            websiteId: website.id,
            price,
            status: "PENDING_PAYMENT",
          }),
        ).rejects.toBeDefined()
      }

      const item = await makeOrderItem(prisma, {
        orderId: order.id,
        websiteId: website.id,
        price: 99,
        status: "PENDING_PAYMENT",
      })
      await expect(
        prisma.order.update({
          where: { id: order.id },
          data: { status: "PAID", paymentStatus: "PAID" },
        }),
      ).rejects.toBeDefined()
      await prisma.orderItem.update({
        where: { id: item.id },
        data: { price: 100, status: "DRAFT" },
      })
      await expect(
        prisma.order.update({
          where: { id: order.id },
          data: { status: "PAID", paymentStatus: "PAID" },
        }),
      ).rejects.toBeDefined()
      await prisma.orderItem.update({
        where: { id: item.id },
        data: { status: "PENDING_PAYMENT", websiteId: null },
      })
      await expect(
        prisma.order.update({
          where: { id: order.id },
          data: { status: "PAID", paymentStatus: "PAID" },
        }),
      ).rejects.toBeDefined()
      await prisma.orderItem.update({
        where: { id: item.id },
        data: { websiteId: website.id },
      })

      await prisma.marketplaceListing.update({
        where: { id: listing.id },
        data: { status: "PAUSED" },
      })
      await expect(
        prisma.order.update({
          where: { id: order.id },
          data: { status: "PAID", paymentStatus: "PAID" },
        }),
      ).rejects.toBeDefined()
      await prisma.marketplaceListing.update({
        where: { id: listing.id },
        data: { status: "APPROVED" },
      })

      // Exact item/catalog facts alone are insufficient: the deferred commit
      // guard requires one exact organization-wallet PURCHASE in the same tx.
      await expect(
        prisma.order.update({
          where: { id: order.id },
          data: { status: "PAID", paymentStatus: "PAID" },
        }),
      ).rejects.toBeDefined()

      const wallet = await makeWallet(prisma, {
        organizationId: organization.id,
        availableBalance: 100,
      })
      await prisma.$transaction(async (tx: any) => {
        await tx.order.update({
          where: { id: order.id },
          data: { status: "PAID", paymentStatus: "PAID" },
        })
        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            availableBalance: { decrement: 100 },
            version: { increment: 1 },
          },
        })
        await makeTransaction(tx, {
          walletId: wallet.id,
          amount: -100,
          type: "PURCHASE",
          reference: `direct-capture-${suffix}`,
          orderId: order.id,
        })
      })

      await expect(
        prisma.orderItem.update({
          where: { id: item.id },
          data: { price: 101 },
        }),
      ).rejects.toBeDefined()
      await expect(
        prisma.orderItem.delete({ where: { id: item.id } }),
      ).rejects.toBeDefined()
      await expect(
        makeOrderItem(prisma, {
          orderId: order.id,
          websiteId: website.id,
          price: 100,
          status: "PENDING_PAYMENT",
        }),
      ).rejects.toBeDefined()
      await expect(
        prisma.order.update({
          where: { id: order.id },
          data: { paymentStatus: "PENDING" },
        }),
      ).rejects.toBeDefined()
    } finally {
      await cleanup()
    }
  }, 30_000)
})
