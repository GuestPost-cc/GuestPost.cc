import crypto from "node:crypto"
import {
  makeOrder,
  makeOrganization,
  makeTransaction,
  makeUser,
  makeWallet,
} from "../factories"
import { createTestApp } from "../helpers/create-test-app"

describe("[INTEGRATION] Financial — reservation release persistence", () => {
  it("commits one exact cancellation chain and rejects every later evidence rewrite", async () => {
    const { prisma, cleanup } = await createTestApp()
    try {
      const organization = await makeOrganization(prisma)
      const customer = await makeUser(prisma, { userType: "CUSTOMER" })
      const order = await makeOrder(prisma, {
        organizationId: organization.id,
        customerId: customer.id,
        status: "PENDING_PAYMENT",
        paymentStatus: "PENDING",
        amount: 100,
        currency: "USD",
      })
      const wallet = await makeWallet(prisma, {
        organizationId: organization.id,
      })
      const reservation = await makeTransaction(prisma, {
        walletId: wallet.id,
        orderId: order.id,
        amount: -100,
        type: "RESERVATION",
        reference: `reservation-${crypto.randomUUID()}`,
      })

      const release = await prisma.$transaction(async (tx: any) => {
        const releaseRow = await tx.transaction.create({
          data: {
            walletId: wallet.id,
            orderId: order.id,
            amount: 100,
            type: "RELEASE",
            currency: "USD",
            reference: `reservation-release:${order.id}`,
          },
        })
        await tx.order.update({
          where: { id: order.id },
          data: { status: "CANCELLED", version: { increment: 1 } },
        })
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType: "ORDER_CANCELLED",
            actorId: customer.id,
            metadata: {
              reservationReleaseTransactionId: releaseRow.id,
            },
          },
        })
        return releaseRow
      })

      await expect(
        prisma.transaction.update({
          where: { id: reservation.id },
          data: { description: "rewritten source evidence" },
        }),
      ).rejects.toThrow(/released reservation evidence is immutable/i)

      await expect(
        prisma.$transaction(async (tx: any) => {
          await tx.orderEvent.deleteMany({
            where: {
              orderId: order.id,
              eventType: "ORDER_CANCELLED",
            },
          })
        }),
      ).rejects.toThrow(/reservation release requires exact terminal order/i)

      await expect(
        prisma.$transaction(async (tx: any) => {
          await tx.order.update({
            where: { id: order.id },
            data: { paymentStatus: "FAILED" },
          })
        }),
      ).rejects.toThrow(/reservation release requires exact terminal order/i)

      const [storedOrder, storedReservation, storedRelease, events] =
        await Promise.all([
          prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
          prisma.transaction.findUniqueOrThrow({
            where: { id: reservation.id },
          }),
          prisma.transaction.findUniqueOrThrow({ where: { id: release.id } }),
          prisma.orderEvent.findMany({
            where: { orderId: order.id, eventType: "ORDER_CANCELLED" },
          }),
        ])

      expect(storedOrder).toMatchObject({
        status: "CANCELLED",
        paymentStatus: "PENDING",
      })
      expect(storedReservation.description).not.toBe(
        "rewritten source evidence",
      )
      expect(storedRelease).toMatchObject({
        type: "RELEASE",
        orderId: order.id,
        walletId: wallet.id,
      })
      expect(events).toHaveLength(1)
      expect(events[0].metadata).toMatchObject({
        reservationReleaseTransactionId: release.id,
      })
    } finally {
      await cleanup()
    }
  }, 30_000)
})
