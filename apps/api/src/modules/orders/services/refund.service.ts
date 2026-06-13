import { Injectable, BadRequestException, NotFoundException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"
import { Decimal } from "@prisma/client/runtime/library"

const REFUNDABLE_STATUSES = [
  "PAID", "SUBMITTED", "ACCEPTED", "CONTENT_REQUESTED",
  "CONTENT_CREATION", "CONTENT_READY", "CUSTOMER_REVIEW",
  "APPROVED", "PUBLISHED", "VERIFIED", "DELIVERED",
  // SETTLED kept for legacy rows; COMPLETED is the terminal state and must stay
  // refundable so post-release publisher clawback still works.
  "SETTLED", "COMPLETED", "DISPUTED",
]

/**
 * Single refund path for captured payments. Every refund flow (admin refund,
 * dispute resolution, force-cancel of paid orders) goes through here so
 * behavior never diverges: duplicate check, settlement cancellation (with
 * publisher clawback when already released), wallet credit, order state,
 * transaction record, audit.
 */
@Injectable()
export class RefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async refundOrder(orderId: string, reason: string, userId: string, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.transaction.findFirst({
        where: { reference: idempotencyKey },
      })
      if (existing) return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { website: { select: { ownershipType: true, publisherId: true } } },
    })
    if (!order) throw new NotFoundException("Order not found")

    if (!REFUNDABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException(`Order cannot be refunded in ${order.status} status`)
    }
    if (order.paymentStatus !== "PAID") {
      throw new BadRequestException("Only paid orders can be refunded")
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      // Duplicate guard
      if (idempotencyKey) {
        const existing = await tx.transaction.findFirst({
          where: { reference: idempotencyKey },
        })
        if (existing) return tx.order.findUniqueOrThrow({ where: { id: orderId } })
      }
      const existingRefund = await tx.transaction.findFirst({
        where: { orderId, type: "REFUND" },
      })
      if (existingRefund) throw new BadRequestException("Order already refunded")

      const isPlatformOrder = order.website?.ownershipType === "PLATFORM"
      let cancelledSettlementId: string | null = null

      if (isPlatformOrder) {
        // Platform order: reverse PlatformRevenue. The row is never deleted —
        // financial records survive; revenue queries filter reversedAt: null.
        await tx.platformRevenue.updateMany({
          where: { orderId, reversedAt: null },
          data: { reversedAt: new Date() },
        })
      } else {
        // Publisher order: cancel settlement + clawback if released
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

        // Clawback: settlement already released. The publisher may have
        // withdrawn already — claw back only what is withdrawable and record
        // the remainder as debt, netted against future settlement releases.
        // (A blind decrement would hit the >= 0 CHECK constraint and make the
        // customer's refund impossible.)
        if (activeSettlement && activeSettlement.status === "RELEASED") {
          const balance = await tx.publisherBalance.findUnique({
            where: { publisherId: activeSettlement.publisherId },
          })
          const owed = new Decimal(activeSettlement.publisherAmount)
          if (balance) {
            const withdrawable = new Decimal(balance.withdrawableBalance)
            const clawedNow = Decimal.min(withdrawable, owed)
            const newDebt = owed.minus(clawedNow)

            const updated = await tx.publisherBalance.updateMany({
              where: { publisherId: activeSettlement.publisherId, version: balance.version },
              data: {
                withdrawableBalance: { decrement: clawedNow },
                debtBalance: { increment: newDebt },
                lifetimeEarnings: { decrement: owed },
                version: { increment: 1 },
              },
            })
            if (updated.count === 0) {
              throw new ConflictException("Publisher balance was modified by another request")
            }

            if (clawedNow.greaterThan(0)) {
              await tx.transaction.create({
                data: {
                  amount: clawedNow.negated(),
                  type: "SETTLEMENT_CLAWBACK",
                  orderId,
                  publisherId: activeSettlement.publisherId,
                  settlementId: activeSettlement.id,
                  reference: `clawback-${orderId}`,
                  description: `Clawback of ${clawedNow.toFixed(2)} for refunded order ${orderId}` +
                    (newDebt.greaterThan(0) ? ` (${newDebt.toFixed(2)} recorded as debt)` : ""),
                },
              })
            }
          } else {
            // No balance row at all — full amount becomes debt
            await tx.publisherBalance.create({
              data: {
                publisherId: activeSettlement.publisherId,
                debtBalance: owed,
              },
            })
          }

          await tx.settlement.updateMany({
            where: { id: activeSettlement.id, status: "RELEASED" },
            data: { status: "CANCELLED" },
          })
        }
        cancelledSettlementId = activeSettlement?.id ?? null
      }

      // Refund captured payment to wallet. Refundable statuses are post-capture,
      // so the order's reservation was already consumed — reservedBalance must not
      // be touched (any reserved funds belong to other orders).
      const wallet = await tx.wallet.findUnique({
        where: { organizationId: order.organizationId },
      })
      const amount = order.amount ? new Decimal(order.amount) : new Decimal(0)
      if (wallet && amount.greaterThan(0)) {
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

      const refundedOrder = await tx.order.updateMany({
        where: { id: orderId, version: order.version },
        data: { status: "REFUNDED", paymentStatus: "REFUNDED", version: { increment: 1 } },
      })
      if (refundedOrder.count === 0) {
        throw new ConflictException("Order was modified by another request. Retry.")
      }
      const updated = await tx.order.findUniqueOrThrow({ where: { id: orderId } })

      await tx.transaction.create({
        data: {
          amount,
          type: "REFUND",
          orderId,
          walletId: wallet?.id ?? null,
          reference: idempotencyKey ?? `refund-${orderId}`,
          description: `Refund for order ${orderId}: ${reason}`,
        },
      })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "REFUND_ISSUED",
          actorId: userId,
          message: `Order refunded: ${reason}`,
          metadata: { reason, refundedBy: userId, settlementCancelled: cancelledSettlementId },
        },
      })

      await this.audit.log({
        action: "ORDER_REFUNDED",
        entityType: "Order",
        entityId: orderId,
        metadata: { fromStatus: order.status, reason },
        userId,
        organizationId: order.organizationId,
      }, tx)

      return updated
    })

    // Event-driven trust recompute (refund reflects badly on the publisher).
    await this.queue.enqueueTrustRecompute(order.website?.publisherId, "REFUND_ISSUED", `order ${orderId} refunded`)

    return result
  }
}
