import { Injectable, BadRequestException, NotFoundException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"

const REFUNDABLE_STATUSES = ["PAID", "SUBMITTED", "VERIFIED", "DELIVERED", "SETTLED", "DISPUTED"]

/**
 * Single refund path for captured payments. Every refund flow (admin refund,
 * dispute resolution) goes through here so behavior never diverges:
 * duplicate check, settlement cancellation (with publisher clawback when
 * already released), wallet credit, order state, transaction record, audit.
 */
@Injectable()
export class RefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async refundOrder(orderId: string, reason: string, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } })
    if (!order) throw new NotFoundException("Order not found")

    if (!REFUNDABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException(`Order cannot be refunded in ${order.status} status`)
    }
    if (order.paymentStatus !== "PAID") {
      throw new BadRequestException("Only paid orders can be refunded")
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      // Duplicate guard: app-level check plus DB-level @@unique([reference])
      // via the stable `refund-<orderId>` reference below
      const existingRefund = await tx.transaction.findFirst({
        where: { orderId, type: "REFUND" },
      })
      if (existingRefund) throw new BadRequestException("Order already refunded")

      // Cancel active settlement so the publisher is not paid after refund
      const activeSettlement = await tx.settlement.findFirst({
        where: { orderId, status: { not: "CANCELLED" } },
      })
      if (activeSettlement && activeSettlement.status !== "RELEASED") {
        const cancelled = await tx.settlement.updateMany({
          where: { id: activeSettlement.id, version: activeSettlement.version },
          data: { status: "CANCELLED", version: { increment: 1 } },
        })
        if (cancelled.count === 0) {
          throw new ConflictException("Settlement was modified by another request. Retry.")
        }
      }

      // Clawback: settlement already released — pull funds back from publisher
      if (activeSettlement && activeSettlement.status === "RELEASED") {
        const balance = await tx.publisherBalance.findUnique({
          where: { publisherId: activeSettlement.publisherId },
        })
        if (balance) {
          const clawbackAmount = Number(activeSettlement.publisherAmount)
          const updated = await tx.publisherBalance.updateMany({
            where: { publisherId: activeSettlement.publisherId, version: balance.version },
            data: {
              withdrawableBalance: { decrement: clawbackAmount },
              lifetimeEarnings: { decrement: clawbackAmount },
              version: { increment: 1 },
            },
          })
          if (updated.count === 0) {
            throw new ConflictException("Publisher balance was modified by another request")
          }
        }

        await tx.settlement.updateMany({
          where: { id: activeSettlement.id, status: "RELEASED" },
          data: { status: "CANCELLED" },
        })
      }

      // Refund captured payment to wallet. Refundable statuses are post-capture,
      // so the order's reservation was already consumed — reservedBalance must not
      // be touched (any reserved funds belong to other orders).
      const wallet = await tx.wallet.findFirst({
        where: { organizationId: order.organizationId },
      })
      const amount = order.amount ? Number(order.amount) : 0
      if (wallet && amount > 0) {
        const refunded = await tx.wallet.updateMany({
          where: { id: wallet.id, version: wallet.version },
          data: {
            availableBalance: { increment: amount },
            version: { increment: 1 },
          },
        })
        if (refunded.count === 0) {
          throw new ConflictException("Wallet was modified by another request. Retry.")
        }
      }

      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: "REFUNDED", paymentStatus: "REFUNDED" },
      })

      await tx.transaction.create({
        data: {
          amount,
          type: "REFUND",
          orderId,
          walletId: wallet?.id ?? null,
          reference: `refund-${orderId}`,
          description: `Refund for order ${orderId}: ${reason}`,
        },
      })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "REFUND_ISSUED",
          actorId: userId,
          message: `Order refunded: ${reason}`,
          metadata: { reason, refundedBy: userId, settlementCancelled: activeSettlement?.id ?? null },
        },
      })

      return updated
    })

    await this.audit.log({
      action: "ORDER_REFUNDED",
      entityType: "Order",
      entityId: orderId,
      metadata: { fromStatus: order.status, reason },
      userId,
      organizationId: order.organizationId,
    })

    return result
  }
}
