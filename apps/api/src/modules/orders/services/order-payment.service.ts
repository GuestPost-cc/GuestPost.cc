import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { BillingService } from "../../billing/billing.service"
import { QueueService } from "../../queues/queue.service"
import { QUEUES } from "@guestpost/shared"
import { Decimal } from "@prisma/client/runtime/library"

@Injectable()
export class OrderPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
    private readonly queue: QueueService,
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

      // Verify listing still available and price matches
      const items = await tx.orderItem.findMany({ where: { orderId } })
      let verifiedTotal = 0
      for (const item of items) {
        if (item.websiteId) {
          const listing = await tx.marketplaceListing.findFirst({
            where: { websiteId: item.websiteId, status: "APPROVED" },
            select: { price: true },
          })
          if (!listing) throw new BadRequestException(`Listing no longer available for website ${item.websiteId}`)
          const serverPrice = Number(listing.price)
          if (Number(item.price) !== serverPrice) {
            // Price drift — update to current price
            await tx.orderItem.update({ where: { id: item.id }, data: { price: serverPrice } })
            verifiedTotal += serverPrice
          } else {
            verifiedTotal += Number(item.price)
          }
        } else {
          const service = await tx.service.findFirst({
            where: { type: order.type as any, isActive: true },
            select: { price: true },
          })
          if (!service) throw new BadRequestException(`No active service for type ${order.type}`)
          const serverPrice = Number(service.price)
          if (Number(item.price) !== serverPrice) {
            await tx.orderItem.update({ where: { id: item.id }, data: { price: serverPrice } })
            verifiedTotal += serverPrice
          } else {
            verifiedTotal += Number(item.price)
          }
        }
      }

      // Reverify total after price corrections
      if (verifiedTotal !== amount) {
        await tx.order.update({ where: { id: orderId }, data: { amount: verifiedTotal } })
      }

      // Check balance against corrected total
      const freshWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } })
      if (Number(freshWallet.availableBalance) < (verifiedTotal || amount)) {
        throw new BadRequestException("Insufficient available balance after price verification")
      }

      await this.billing.reserve(wallet.id, verifiedTotal || amount, orderId, { id: userId, organizationId: userOrgId })

      const submitted = await tx.order.updateMany({
        where: { id: orderId, version: order.version },
        data: { status: "PENDING_PAYMENT", amount: verifiedTotal || amount, version: { increment: 1 } },
      })
      if (submitted.count === 0) {
        throw new ConflictException("Order was modified by another request. Retry.")
      }
      const updated = await tx.order.findUniqueOrThrow({ where: { id: orderId } })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "PAYMENT_SUBMITTED",
          actorId: userId,
          message: `Funds reserved for payment — awaiting capture`,
          metadata: { reservedAmount: verifiedTotal || amount },
        },
      })

      return updated
    })
  }

  async capturePayment(orderId: string) {
    return this.prisma.$transaction(async (tx: any) => {
      const order = await tx.order.findUnique({ where: { id: orderId } })
      if (!order) throw new NotFoundException("Order not found")
      if (order.status !== "PENDING_PAYMENT") throw new BadRequestException("Order must be PENDING_PAYMENT to capture payment")

      const wallet = await tx.wallet.findFirst({ where: { organizationId: order.organizationId } })
      if (!wallet) throw new BadRequestException("No wallet found")

      const amount = order.amount ? Number(order.amount) : 0
      await this.billing.payFromReserved(wallet.id, amount, orderId, {
        id: "system",
        organizationId: order.organizationId,
      })

      // Version-guard the capture transition; payFromReserved is already
      // idempotency-protected on reserved balance, this guards the order row.
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
          actorId: "system",
          message: `Payment captured — order automatically submitted`,
          metadata: { capturedAmount: amount },
        },
      })

      // Auto-submit
      await tx.order.update({ where: { id: orderId }, data: { status: "SUBMITTED" } })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ORDER_CREATED",
          actorId: "system",
          message: `Order submitted after payment capture`,
        },
      })

      await this.audit.log({
        action: "PAYMENT_CAPTURED",
        entityType: "Order",
        entityId: orderId,
        metadata: { amount, from: "PENDING_PAYMENT", to: "SUBMITTED" },
        userId: "system",
        organizationId: order.organizationId,
      })

      return tx.order.findUnique({ where: { id: orderId } })
    })
  }

}
