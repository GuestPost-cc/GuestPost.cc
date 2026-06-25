import { orderEventMetadata } from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import type { PrismaService } from "../../../common/prisma.service"
import type { AuditService } from "../../audit/audit.service"
import type { BillingService } from "../../billing/billing.service"
import { assertOwnerOrCreator } from "./owner-or-creator"

@Injectable()
export class OrderPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
  ) {}

  // Phase 6.9 — actorRole is the acting user's customerRole in `userOrgId`
  // ("OWNER" | "MEMBER" | null). Used to enforce the OWNER||creator gate
  // before money moves. Default `undefined` keeps tests / legacy callers
  // from breaking — but the controller always passes user.customerRole now.
  async submitPayment(
    orderId: string,
    userId: string,
    userOrgId: string,
    actorRole?: string | null,
  ) {
    return this.prisma.$transaction(async (tx: any) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, organizationId: userOrgId },
      })
      if (!order) throw new NotFoundException("Order not found")
      // Phase 6.9 — Audit finding #3. Block non-creator MEMBERs from draining
      // the wallet via someone else's DRAFT order. OWNER can always submit;
      // a MEMBER can submit only on THEIR OWN draft (customerId === userId).
      assertOwnerOrCreator({
        customerId: order.customerId,
        actorUserId: userId,
        actorRole,
        action: "submit payment",
      })
      if (order.status !== "DRAFT")
        throw new BadRequestException("Order must be DRAFT to submit payment")

      const wallet = await tx.wallet.findFirst({
        where: { organizationId: userOrgId },
      })
      if (!wallet)
        throw new BadRequestException("No wallet found for organization")

      const amount = order.amount ? Number(order.amount) : 0
      if (amount <= 0)
        throw new BadRequestException("Order has zero amount — add items first")

      if (Number(wallet.availableBalance) < amount) {
        throw new BadRequestException("Insufficient available balance")
      }

      // Verify listing still available and price matches. The customer is
      // NEVER silently charged a drifted price — they approved the cart at
      // the old price, so any drift fails with 409 and the items are updated
      // for an explicit re-confirmation on the next attempt.
      //
      // Drift source preference: when the order has a listingServiceId snapshot
      // we read THAT row's live price (the per-service price the customer
      // picked); otherwise we fall back to the listing's flat price
      // (legacy orders that predate the snapshot).
      const items = await tx.orderItem.findMany({ where: { orderId } })
      const driftedItems: Array<{
        itemId: string
        oldPrice: number
        newPrice: number
      }> = []
      for (const item of items) {
        let serverPrice: any
        // Post-Phase-4: order.listingServiceId is the only drift source.
        // Pre-snapshot legacy orders are out of band — they were backfilled,
        // and any order created today is guaranteed to have a snapshot
        // (orders.service.ts asserts).
        if (!order.listingServiceId) {
          throw new BadRequestException(
            "Order has no listingServiceId snapshot — cannot price",
          )
        }
        const ls = await tx.listingService.findUnique({
          where: { id: order.listingServiceId },
          select: { price: true, availability: true },
        })
        if (!ls)
          throw new BadRequestException("Listing service no longer available")
        if (ls.availability !== "AVAILABLE") {
          throw new ConflictException({
            code: "SERVICE_UNAVAILABLE",
            message: "Service is no longer available — refresh and try again",
          })
        }
        serverPrice = ls.price
        if (!new Decimal(item.price ?? 0).equals(serverPrice)) {
          // Sync via the NON-transactional client: the 409 below aborts this
          // transaction, and the corrected prices must survive the rollback
          // so the customer's retry sees the new total.
          await this.prisma.orderItem.update({
            where: { id: item.id },
            data: { price: serverPrice },
          })
          driftedItems.push({
            itemId: item.id,
            oldPrice: Number(item.price),
            newPrice: Number(serverPrice),
          })
        }
      }

      if (driftedItems.length > 0) {
        const newTotal = await this.prisma.orderItem.aggregate({
          where: { orderId },
          _sum: { price: true },
        })
        await this.prisma.order.update({
          where: { id: orderId },
          data: { amount: newTotal._sum.price ?? 0 },
        })
        throw new ConflictException({
          message:
            "Prices changed since the order was created. Review the updated total and submit payment again.",
          driftedItems,
        })
      }

      // Claim the order BEFORE any money moves. Under concurrent
      // submit-payment, only one request wins this version-guarded transition;
      // losers throw here and never touch the wallet. (Previously the wallet
      // debit happened first, so every parallel request debited and only the
      // order guard deduped — a double-charge.)
      const captured = await tx.order.updateMany({
        where: { id: orderId, version: order.version, status: "DRAFT" },
        data: {
          paymentStatus: "PAID",
          status: "PAID",
          version: { increment: 1 },
        },
      })
      if (captured.count === 0) {
        throw new ConflictException(
          "Order was modified by another request. Retry.",
        )
      }

      // Reserve + capture inside THIS transaction so the debit commits or rolls
      // back atomically with the order claim above.
      await this.billing.reserve(
        wallet.id,
        amount,
        orderId,
        { id: userId, organizationId: userOrgId },
        tx,
      )
      await this.billing.payFromReserved(
        wallet.id,
        amount,
        orderId,
        { id: userId, organizationId: userOrgId },
        tx,
      )

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
      await tx.order.update({
        where: { id: orderId },
        data: { status: "SUBMITTED" },
      })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ORDER_SUBMITTED",
          actorId: userId,
          message: `Order submitted after payment capture`,
        },
      })

      // Pass tx — an un-scoped audit.log would grab a SECOND pooled connection
      // while this transaction still holds its own. Under concurrency that
      // exhausts the pool and every in-flight payment deadlocks until timeout.
      await this.audit.log(
        {
          action: "PAYMENT_CAPTURED",
          entityType: "Order",
          entityId: orderId,
          // Phase 6.9 — uniform snapshot trio across every Order-scoped audit.
          metadata: {
            ...orderEventMetadata(order),
            amount,
            from: "DRAFT",
            to: "SUBMITTED",
          },
          userId,
          organizationId: userOrgId,
        },
        tx,
      )

      return tx.order.findUnique({ where: { id: orderId } })
    })
  }
}
