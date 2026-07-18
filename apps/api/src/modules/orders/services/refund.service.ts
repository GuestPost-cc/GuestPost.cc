import {
  notificationDedupKey,
  orderEventMetadata,
  REFUNDABLE_ORDER_STATUSES,
} from "@guestpost/shared"
import {
  FinalRefundResponsibility,
  OrderRefundConflictError,
  refundUnacceptedPaidOrderInTransaction,
} from "@guestpost/shared/dist/order-refund-core"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { PrismaService } from "../../../common/prisma.service"
import { checkPublisherBalanceInvariant } from "../../../common/publisher-balance-invariants"
import { lockPublisherBalanceForUpdate } from "../../../common/publisher-balance-lock"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"

export interface RefundOptions {
  responsibility: FinalRefundResponsibility
}

export interface RefundTransactionResult {
  order: any
  refundTransactionId: string
}

/**
 * Single refund path for captured payments. Every approved refund flow
 * (cancellation, dispute resolution, emergency force-cancel) goes through here so
 * behavior never diverges: duplicate check, settlement cancellation (with
 * publisher clawback when already released), wallet credit, order state,
 * transaction record, audit.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async refundOrder(
    orderId: string,
    reason: string,
    userId: string,
    idempotencyKey: string | undefined,
    options: RefundOptions,
  ) {
    if (!options) {
      throw new BadRequestException(
        "A final refund responsibility attribution is required",
      )
    }
    if (idempotencyKey) {
      const existing = await this.prisma.transaction.findFirst({
        where: { reference: idempotencyKey },
      })
      if (existing && existing.orderId !== orderId) {
        throw new ConflictException("Idempotency key belongs to another order")
      }
      if (existing)
        return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        website: { select: { ownershipType: true, publisherId: true } },
      },
    })
    if (!order) throw new NotFoundException("Order not found")

    if (
      !(REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(order.status)
    ) {
      throw new BadRequestException(
        `Order cannot be refunded in ${order.status} status`,
      )
    }
    if (order.paymentStatus !== "PAID") {
      throw new BadRequestException("Only paid orders can be refunded")
    }

    const responsibility = options.responsibility
    const result = await this.prisma.$transaction((tx: any) =>
      this.refundOrderInTransaction(
        tx,
        order,
        reason,
        userId,
        idempotencyKey,
        responsibility,
      ),
    )

    // Refunds only affect publisher trust when the case attributes the failure
    // to the publisher. Customer changes of mind and platform failures must not
    // silently punish a publisher.
    if (responsibility === "PUBLISHER") {
      await this.queue.enqueueTrustRecompute(
        order.website?.publisherId,
        "REFUND_ISSUED",
        `publisher-attributed refund on order ${orderId}`,
      )
    }

    return result.order
  }

  /**
   * Transaction-aware refund primitive used by dispute/cancellation workflows.
   * The caller owns the transaction and can resolve its case record in the same
   * commit as the wallet, settlement, assignment, order, event, and audit writes.
   */
  async refundOrderInTransaction(
    tx: any,
    order: any,
    reason: string,
    userId: string,
    idempotencyKey: string | undefined,
    responsibility: FinalRefundResponsibility,
  ): Promise<RefundTransactionResult> {
    // Duplicate guard
    if (idempotencyKey) {
      const existing = await tx.transaction.findFirst({
        where: { reference: idempotencyKey },
      })
      if (existing) {
        if (existing.orderId !== order.id) {
          throw new ConflictException(
            "Idempotency key belongs to another order",
          )
        }
        return {
          order: await tx.order.findUniqueOrThrow({
            where: { id: order.id },
          }),
          refundTransactionId: existing.id,
        }
      }
    }
    const existingRefund = await tx.transaction.findFirst({
      where: { orderId: order.id, type: "REFUND" },
    })
    if (existingRefund) {
      throw new BadRequestException("Order already refunded")
    }

    if (
      !(REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(order.status)
    ) {
      throw new BadRequestException(
        `Order cannot be refunded in ${order.status} status`,
      )
    }
    if (order.paymentStatus !== "PAID") {
      throw new BadRequestException("Only paid orders can be refunded")
    }

    if (["PAID", "SUBMITTED"].includes(order.status)) {
      try {
        return await refundUnacceptedPaidOrderInTransaction(
          tx,
          order,
          {
            reference: idempotencyKey ?? `refund-${order.id}`,
            reason,
            responsibility,
            actorUserId: userId,
            auditAction: "ORDER_REFUNDED",
            auditMetadata: {
              reason,
              ...orderEventMetadata(order),
            },
          },
          (data, auditTx) => this.audit.log(data, auditTx),
        )
      } catch (error) {
        if (error instanceof OrderRefundConflictError) {
          throw new ConflictException(error.message)
        }
        throw error
      }
    }

    // Channel snapshot is authoritative — but legacy orders predate the
    // snapshot, so fall back to website.ownershipType for them.
    const channel =
      order.fulfillmentChannel ??
      (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
    const isPlatformOrder = channel === "PLATFORM"
    let cancelledSettlementId: string | null = null

    if (isPlatformOrder) {
      // Platform order: reverse PlatformRevenue. The row is never deleted —
      // financial records survive; revenue queries filter reversedAt: null.
      await tx.platformRevenue.updateMany({
        where: { orderId: order.id, reversedAt: null },
        data: { reversedAt: new Date() },
      })
    } else {
      // Publisher order: cancel settlement + clawback if released
      const activeSettlement = await tx.settlement.findFirst({
        where: { orderId: order.id, status: { not: "CANCELLED" } },
      })
      if (activeSettlement && activeSettlement.status !== "RELEASED") {
        const cancelled = await tx.settlement.updateMany({
          where: {
            id: activeSettlement.id,
            version: activeSettlement.version,
          },
          data: { status: "CANCELLED", version: { increment: 1 } },
        })
        if (cancelled.count === 0) {
          throw new ConflictException(
            "Settlement was modified by another request. Retry.",
          )
        }
      }

      // Clawback: settlement already released. The publisher may have
      // withdrawn already — claw back only what is withdrawable and record
      // the remainder as debt, netted against future settlement releases.
      // (A blind decrement would hit the >= 0 CHECK constraint and make the
      // customer's refund impossible.)
      if (activeSettlement && activeSettlement.status === "RELEASED") {
        const balance = await lockPublisherBalanceForUpdate(
          tx,
          activeSettlement.publisherId,
        )
        const owed = new Decimal(activeSettlement.publisherAmount)
        if (balance) {
          const withdrawable = new Decimal(balance.withdrawableBalance)
          const clawedNow = Decimal.min(withdrawable, owed)
          const newDebt = owed.minus(clawedNow)

          const updated = await tx.publisherBalance.updateMany({
            where: {
              publisherId: activeSettlement.publisherId,
              version: balance.version,
            },
            data: {
              withdrawableBalance: { decrement: clawedNow },
              debtBalance: { increment: newDebt },
              lifetimeEarnings: { decrement: owed },
              version: { increment: 1 },
            },
          })
          if (updated.count === 0) {
            throw new ConflictException(
              "Publisher balance was modified by another request",
            )
          }

          checkPublisherBalanceInvariant(
            {
              ...balance,
              withdrawableBalance:
                Number(balance.withdrawableBalance) - Number(clawedNow),
              debtBalance: Number(balance.debtBalance ?? 0) + Number(newDebt),
              lifetimeEarnings: Number(balance.lifetimeEarnings) - Number(owed),
            },
            this.logger,
            "refundOrder/clawback",
          )

          if (clawedNow.greaterThan(0)) {
            await tx.transaction.create({
              data: {
                amount: clawedNow.negated(),
                type: "SETTLEMENT_CLAWBACK",
                orderId: order.id,
                publisherId: activeSettlement.publisherId,
                settlementId: activeSettlement.id,
                reference: `clawback-${order.id}`,
                description:
                  `Clawback of ${clawedNow.toFixed(2)} for refunded order ${order.id}` +
                  (newDebt.greaterThan(0)
                    ? ` (${newDebt.toFixed(2)} recorded as debt)`
                    : ""),
              },
            })
          }
          if (newDebt.greaterThan(0)) {
            await this.createPublisherDebtNotifications(tx, {
              publisherId: activeSettlement.publisherId,
              orderId: order.id,
              amount: newDebt,
              currency: order.currency ?? "USD",
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
          await this.createPublisherDebtNotifications(tx, {
            publisherId: activeSettlement.publisherId,
            orderId: order.id,
            amount: owed,
            currency: order.currency ?? "USD",
          })
        }

        const cancelledReleased = await tx.settlement.updateMany({
          where: {
            id: activeSettlement.id,
            status: "RELEASED",
            version: activeSettlement.version,
          },
          data: { status: "CANCELLED", version: { increment: 1 } },
        })
        if (cancelledReleased.count === 0) {
          throw new ConflictException(
            "Settlement was modified by another request. Retry.",
          )
        }
      }
      cancelledSettlementId = activeSettlement?.id ?? null
    }

    // A terminal refund must make the order disappear from every active Ops
    // queue in the same commit. This also cleans legacy DRAFT assignments.
    await tx.fulfillmentAssignment.updateMany({
      where: {
        orderId: order.id,
        status: { in: ["ASSIGNED", "IN_PROGRESS"] },
      },
      data: { status: "CANCELLED", version: { increment: 1 } },
    })

    // Refund captured payment to wallet. Refundable statuses are post-capture,
    // so the order's reservation was already consumed — reservedBalance must not
    // be touched (any reserved funds belong to other orders).
    const wallet = await tx.wallet.findUnique({
      where: { organizationId: order.organizationId },
    })
    const amount = order.amount ? new Decimal(order.amount) : new Decimal(0)
    if (!wallet && amount.greaterThan(0)) {
      throw new ConflictException(
        "Paid order has no organization wallet; refund requires reconciliation",
      )
    }
    if (wallet && amount.greaterThan(0)) {
      const refunded = await tx.wallet.updateMany({
        where: { id: wallet.id, version: wallet.version },
        data: {
          availableBalance: { increment: amount },
          version: { increment: 1 },
        },
      })
      if (refunded.count === 0) {
        throw new ConflictException(
          "Wallet was modified by another request. Retry.",
        )
      }
    }

    const refundedOrder = await tx.order.updateMany({
      where: { id: order.id, version: order.version },
      data: {
        status: "REFUNDED",
        paymentStatus: "REFUNDED",
        refundResponsibility: responsibility,
        version: { increment: 1 },
      },
    })
    if (refundedOrder.count === 0) {
      throw new ConflictException(
        "Order was modified by another request. Retry.",
      )
    }
    const updated = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
    })

    const refundTransaction = await tx.transaction.create({
      data: {
        amount,
        type: "REFUND",
        orderId: order.id,
        walletId: wallet?.id ?? null,
        reference: idempotencyKey ?? `refund-${order.id}`,
        description: `Refund for order ${order.id}: ${reason}`,
      },
    })

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "REFUND_ISSUED",
        actorId: userId,
        message: `Order refunded: ${reason}`,
        metadata: {
          reason,
          refundedBy: userId,
          responsibility,
          settlementCancelled: cancelledSettlementId,
        },
      },
    })

    await this.audit.log(
      {
        action: "ORDER_REFUNDED",
        entityType: "Order",
        entityId: order.id,
        // Phase 6 standardized metadata — orderEventMetadata supplies the
        // snapshot trio so historical refund replays don't have to chase
        // a possibly-edited live listing.
        metadata: {
          fromStatus: order.status,
          reason,
          responsibility,
          ...orderEventMetadata(order),
        },
        userId,
        organizationId: order.organizationId,
      },
      tx,
    )

    return {
      order: updated,
      refundTransactionId: refundTransaction.id,
    }
  }

  private async createPublisherDebtNotifications(
    tx: any,
    args: {
      publisherId: string
      orderId: string
      amount: Decimal
      currency: string
    },
  ) {
    const publisher = await tx.publisher.findUnique({
      where: { id: args.publisherId },
      select: {
        organizationId: true,
        publisherMemberships: { select: { userId: true } },
      },
    })
    if (!publisher) {
      throw new ConflictException(
        "Publisher account is missing for settlement clawback",
      )
    }

    for (const membership of publisher.publisherMemberships) {
      const dedupKey = notificationDedupKey.publisherDebt(
        args.orderId,
        membership.userId,
      )
      await tx.notification.upsert({
        where: {
          userId_dedupKey: { userId: membership.userId, dedupKey },
        },
        create: {
          userId: membership.userId,
          organizationId: publisher.organizationId,
          type: "PUBLISHER_DEBT_CREATED",
          message: `${args.amount.toFixed(2)} ${args.currency} was recorded as outstanding debt after the refund for order ${args.orderId}. Future settlement earnings will repay this debt before funds become withdrawable.`,
          dedupKey,
        },
        update: {},
      })
    }
  }
}
