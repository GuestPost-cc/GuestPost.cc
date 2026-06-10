import { Injectable, BadRequestException, NotFoundException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { BillingService } from "../../billing/billing.service"
import { Decimal } from "@prisma/client/runtime/library"

@Injectable()
export class OrderPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
  ) {}

  async submitPayment(orderId: string, userId: string, userOrgId: string) {
    return this.prisma.$transaction(async (tx: any) => {
      const order = await tx.order.findFirst({ where: { id: orderId, organizationId: userOrgId } })
      if (!order) throw new NotFoundException("Order not found")
      if (order.status !== "DRAFT") throw new BadRequestException("Order must be DRAFT to submit payment")

      const wallet = await tx.wallet.findFirst({ where: { organizationId: userOrgId } })
      if (!wallet) throw new BadRequestException("No wallet found for organization")

      const amount = order.amount ? Number(order.amount) : 0
      if (amount <= 0) throw new BadRequestException("Order has zero amount — add items first")

      if (Number(wallet.availableBalance) < amount) {
        throw new BadRequestException("Insufficient available balance")
      }

      // Verify listing still available and price matches. The customer is
      // NEVER silently charged a drifted price — they approved the cart at
      // the old price, so any drift fails with 409 and the items are updated
      // for an explicit re-confirmation on the next attempt.
      const items = await tx.orderItem.findMany({ where: { orderId } })
      const driftedItems: Array<{ itemId: string; oldPrice: number; newPrice: number }> = []
      for (const item of items) {
        let serverPrice: any
        if (item.websiteId) {
          const listing = await tx.marketplaceListing.findFirst({
            where: { websiteId: item.websiteId, status: "APPROVED" },
            select: { price: true },
          })
          if (!listing) throw new BadRequestException(`Listing no longer available for website ${item.websiteId}`)
          serverPrice = listing.price
        } else {
          const service = await tx.service.findFirst({
            where: { type: order.type as any, isActive: true },
            select: { price: true },
          })
          if (!service) throw new BadRequestException(`No active service for type ${order.type}`)
          serverPrice = service.price
        }
        if (!new Decimal(item.price ?? 0).equals(serverPrice)) {
          // Sync via the NON-transactional client: the 409 below aborts this
          // transaction, and the corrected prices must survive the rollback
          // so the customer's retry sees the new total.
          await this.prisma.orderItem.update({ where: { id: item.id }, data: { price: serverPrice } })
          driftedItems.push({ itemId: item.id, oldPrice: Number(item.price), newPrice: Number(serverPrice) })
        }
      }

      if (driftedItems.length > 0) {
        const newTotal = await this.prisma.orderItem.aggregate({ where: { orderId }, _sum: { price: true } })
        await this.prisma.order.update({ where: { id: orderId }, data: { amount: newTotal._sum.price ?? 0 } })
        throw new ConflictException({
          message: "Prices changed since the order was created. Review the updated total and submit payment again.",
          driftedItems,
        })
      }

      await this.billing.reserve(wallet.id, amount, orderId, { id: userId, organizationId: userOrgId })

      // Capture immediately — no external payment gateway, internal wallet only
      await this.billing.payFromReserved(wallet.id, amount, orderId, {
        id: userId,
        organizationId: userOrgId,
      })

      const captured = await tx.order.updateMany({
        where: { id: orderId, version: order.version },
        data: { paymentStatus: "PAID", status: "PAID", version: { increment: 1 } },
      })
      if (captured.count === 0) {
        throw new ConflictException("Order was modified by another request. Retry.")
      }

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "PAYMENT_CAPTURED",
          actorId: userId,
          message: `Payment captured — order submitted`,
          metadata: { capturedAmount: amount },
        },
      })

      // Auto-submit
      await tx.order.update({ where: { id: orderId }, data: { status: "SUBMITTED" } })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ORDER_SUBMITTED",
          actorId: userId,
          message: `Order submitted after payment capture`,
        },
      })

      await this.audit.log({
        action: "PAYMENT_CAPTURED",
        entityType: "Order",
        entityId: orderId,
        metadata: { amount, from: "DRAFT", to: "SUBMITTED" },
        userId,
        organizationId: userOrgId,
      })

      return tx.order.findUnique({ where: { id: orderId } })
    })
  }

}
