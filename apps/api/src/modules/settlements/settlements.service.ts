import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { QueueService } from "../queues/queue.service"
import { QUEUES } from "@guestpost/shared"
import { Decimal } from "@prisma/client/runtime/library"
import { resolvePlatformFeeFraction, splitPlatformFee } from "../../common/platform-fee"

@Injectable()
export class SettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  // organizationId is null for staff callers — they may create settlements for any org
  async createSettlement(orderId: string, organizationId: string | null, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: organizationId ? { id: orderId, organizationId } : { id: orderId },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "DELIVERED") throw new BadRequestException("Order must be DELIVERED to create settlement")

    // Find publisher from order items' websites
    const item = await this.prisma.orderItem.findFirst({
      where: { orderId, websiteId: { not: null } },
      include: { website: { select: { publisherId: true } } },
    })
    const publisherId = item?.website?.publisherId
    if (!publisherId) throw new BadRequestException("No publisher found for this order")

    if (!order.amount || new Decimal(order.amount).lessThanOrEqualTo(0)) {
      throw new BadRequestException("Order has no amount to settle")
    }
    const feeFraction = await resolvePlatformFeeFraction(this.prisma)
    const { fee: platformFee, net: publisherAmount } = splitPlatformFee(order.amount, feeFraction)

    const reviewDays = Math.max(Number(process.env.SETTLEMENT_REVIEW_DAYS ?? 7), 0)
    const reviewEndsAt = new Date(Date.now() + reviewDays * 24 * 60 * 60 * 1000)

    return this.prisma.$transaction(async (tx: any) => {
      // Re-check inside transaction; partial unique index on Settlement.orderId
      // (status != CANCELLED) is the hard guarantee against concurrent duplicates
      const existing = await tx.settlement.findFirst({
        where: { orderId, status: { not: "CANCELLED" } },
      })
      if (existing) throw new BadRequestException("Settlement already exists for this order")

      let settlement: any
      try {
        settlement = await tx.settlement.create({
          data: {
            orderId,
            publisherId,
            grossAmount: order.amount,
            platformFee,
            publisherAmount,
            status: "PENDING",
            reviewEndsAt,
          },
        })
      } catch (err: any) {
        if (err?.code === "P2002" || /Settlement_orderId_active_key/.test(err?.message ?? "")) {
          throw new BadRequestException("Settlement already exists for this order")
        }
        throw err
      }

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "SETTLEMENT_CREATED",
          actorId: userId,
          message: `Settlement created — customer amount: ${order.amount}, publisher amount: ${publisherAmount}`,
          metadata: { settlementId: settlement.id, publisherAmount: publisherAmount.toNumber(), platformFee: platformFee.toNumber() },
        },
      })

      await this.audit.log({
        action: "SETTLEMENT_CREATED",
        entityType: "Settlement",
        entityId: settlement.id,
        metadata: { orderId, publisherAmount: publisherAmount.toNumber(), platformFee: platformFee.toNumber() },
        userId,
        organizationId: order.organizationId,
      }, tx)

      return settlement
    })
  }

  // organizationId is null for staff callers — customers may only see their own org's settlements
  async getSettlement(id: string, organizationId: string | null = null) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: {
        order: { include: { customer: true, website: true } },
        publisher: true,
        approvals: true,
      },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (organizationId && settlement.order.organizationId !== organizationId) {
      throw new ForbiddenException("Settlement does not belong to your organization")
    }
    return settlement
  }

  async listSettlements(organizationId?: string, take = 50, skip = 0) {
    const where = organizationId ? { order: { organizationId } } : {}
    const [items, total] = await this.prisma.$transaction([
      this.prisma.settlement.findMany({
        where,
        include: { order: true, publisher: true, approvals: true },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      this.prisma.settlement.count({ where }),
    ])
    return { items, total, take, skip }
  }

  // Customer approves settlement
  async customerApprove(id: string, userId: string, organizationId: string, role: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.order.organizationId !== organizationId) {
      throw new ForbiddenException("Settlement does not belong to your organization")
    }
    if (settlement.status !== "PENDING" && settlement.status !== "UNDER_REVIEW") {
      throw new BadRequestException(`Cannot approve settlement in ${settlement.status} status`)
    }

    // Check for active dispute
    const activeDispute = await this.prisma.orderDispute.findFirst({
      where: { orderId: settlement.orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } },
    })
    if (activeDispute) throw new BadRequestException("Cannot approve settlement while dispute is active")

    return this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.settlement.update({
        where: { id },
        data: { status: "CUSTOMER_APPROVED" },
      })

      await tx.settlementApproval.upsert({
        where: { settlementId_type: { settlementId: id, type: "CUSTOMER" } },
        create: {
          settlementId: id,
          type: "CUSTOMER",
          approvedBy: userId,
          roleAtTime: role,
        },
        update: {
          approvedBy: userId,
          roleAtTime: role,
          approvedAt: new Date(),
        },
      })

      await tx.orderEvent.create({
        data: {
          orderId: settlement.orderId,
          eventType: "SETTLED",
          actorId: userId,
          message: `Settlement customer-approved`,
          metadata: { settlementId: id, publisherAmount: Number(settlement.publisherAmount) },
        },
      })

      await this.audit.log({
        action: "SETTLEMENT_CUSTOMER_APPROVED",
        entityType: "Settlement",
        entityId: id,
        metadata: { orderId: settlement.orderId, publisherAmount: Number(settlement.publisherAmount) },
        userId,
        organizationId,
      })

      return updated
    })
  }

  // Fired after the release transaction commits — queue writes are not transactional
  private async notifySettlementReleased(settlement: { id: string; orderId: string; publisherId: string; publisherAmount: any; order: { organizationId: string; customerId: string } }) {
    const memberships = await this.prisma.publisherMembership.findMany({
      where: { publisherId: settlement.publisherId },
      select: { userId: true },
    })
    for (const m of memberships) {
      await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
        userId: m.userId,
        organizationId: settlement.order.organizationId,
        type: "SETTLEMENT_RELEASED",
        message: `Settlement of ${settlement.publisherAmount} has been released to your balance.`,
      })
    }
    await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
      userId: settlement.order.customerId,
      organizationId: settlement.order.organizationId,
      type: "SETTLEMENT_RELEASED",
      message: `Settlement for order ${settlement.orderId} has been released.`,
    })
  }

  // Staff approves settlement (admin side)
  async adminApprove(id: string, userId: string, staffRole: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.status !== "CUSTOMER_APPROVED") {
      throw new BadRequestException("Customer must approve before admin can approve")
    }

    // Check for active dispute
    const activeDispute = await this.prisma.orderDispute.findFirst({
      where: { orderId: settlement.orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } },
    })
    if (activeDispute) throw new BadRequestException("Cannot approve settlement while dispute is active")

    const result = await this.prisma.$transaction(async (tx: any) => {
      const adminUpdated = await tx.settlement.updateMany({
        where: { id, status: "CUSTOMER_APPROVED", version: settlement.version },
        data: {
          status: "ADMIN_APPROVED",
          version: { increment: 1 },
        },
      })
      if (adminUpdated.count === 0) {
        throw new ConflictException("Settlement status changed by another request")
      }

      const fresh = await tx.settlement.findUniqueOrThrow({ where: { id } })

      await tx.settlementApproval.create({
        data: {
          settlementId: id,
          type: "ADMIN",
          approvedBy: userId,
          roleAtTime: staffRole,
        },
      })

      // Auto-release if admin approved
      await this.releaseFundsInternal(tx, id, { ...settlement, version: fresh.version }, userId)

      return fresh
    })

    await this.notifySettlementReleased(settlement)

    return result
  }

  // Combined approval for dual-role staff (SUPER_ADMIN)
  async forceApprove(id: string, userId: string, staffRole: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.status === "RELEASED") throw new BadRequestException("Settlement already released")

    const activeDispute = await this.prisma.orderDispute.findFirst({
      where: { orderId: settlement.orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } },
    })
    if (activeDispute) throw new BadRequestException("Cannot approve settlement while dispute is active")

    const targetStatus = settlement.status === "CUSTOMER_APPROVED" ? "ADMIN_APPROVED" : "CUSTOMER_APPROVED"

    const result = await this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.settlement.updateMany({
        where: { id, version: settlement.version },
        data: {
          status: targetStatus,
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException("Settlement was modified by another request")
      }

      const fresh = await tx.settlement.findUniqueOrThrow({ where: { id } })

      await tx.settlementApproval.create({
        data: { settlementId: id, type: targetStatus === "ADMIN_APPROVED" ? "ADMIN" : "CUSTOMER", approvedBy: userId, roleAtTime: staffRole },
      })

      if (targetStatus === "ADMIN_APPROVED") {
        await this.releaseFundsInternal(tx, id, { ...settlement, version: fresh.version }, userId)
      }

      return fresh
    })

    if (targetStatus === "ADMIN_APPROVED") {
      await this.notifySettlementReleased(settlement)
    }

    return result
  }

  async cancelSettlement(id: string, userId: string, reason: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true, publisher: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.status === "RELEASED") throw new BadRequestException("Cannot cancel released settlement")

    return this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.settlement.updateMany({
        where: { id, version: settlement.version },
        data: { status: "CANCELLED", version: { increment: 1 } },
      })
      if (updated.count === 0) {
        throw new ConflictException("Settlement was modified by another request. Retry.")
      }
      const settlementRow = await tx.settlement.findUniqueOrThrow({ where: { id } })

      await this.audit.log({
        action: "SETTLEMENT_CANCELLED",
        entityType: "Settlement",
        entityId: id,
        metadata: { orderId: settlement.orderId, reason },
        userId,
        organizationId: settlement.order.organizationId,
      }, tx)

      return settlementRow
    })
  }

  async returnToReview(id: string, userId: string, reason: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.status !== "CUSTOMER_APPROVED") {
      throw new BadRequestException("Only customer-approved settlements can be returned to review")
    }

    return this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.settlement.update({
        where: { id },
        data: { status: "UNDER_REVIEW" },
      })

      // Remove stale customer approval so the customer can approve again
      // (unique [settlementId, type] would otherwise block re-approval forever).
      // The revoked approval is preserved in the audit log below before deletion.
      const revoked = await tx.settlementApproval.findUnique({
        where: { settlementId_type: { settlementId: id, type: "CUSTOMER" } },
      })
      if (revoked) {
        await this.audit.log({
          action: "SETTLEMENT_APPROVAL_REVOKED",
          entityType: "SettlementApproval",
          entityId: revoked.id,
          metadata: {
            settlementId: id,
            type: revoked.type,
            approvedBy: revoked.approvedBy,
            roleAtTime: revoked.roleAtTime,
            approvedAt: revoked.approvedAt?.toISOString?.() ?? revoked.approvedAt,
            revokedBy: userId,
            reason,
          },
          userId,
          organizationId: settlement.order.organizationId,
        })
        await tx.settlementApproval.delete({ where: { id: revoked.id } })
      }

      await tx.orderEvent.create({
        data: {
          orderId: settlement.orderId,
          eventType: "SETTLED",
          actorId: userId,
          message: `Settlement returned to review: ${reason}`,
          metadata: revoked
            ? { settlementId: id, revokedApprovalBy: revoked.approvedBy, revokedApprovalAt: revoked.approvedAt }
            : { settlementId: id },
        },
      })

      return updated
    })
  }

  private async releaseFundsInternal(tx: any, settlementId: string, settlement: any, userId: string) {
    // Prevent duplicate release: only release if status is ADMIN_APPROVED and version matches
    const released = await tx.settlement.updateMany({
      where: { id: settlementId, status: "ADMIN_APPROVED", version: settlement.version },
      data: {
        status: "RELEASED",
        settledAt: new Date(),
        version: { increment: 1 },
      },
    })
    if (released.count === 0) {
      throw new ConflictException("Settlement was already released or modified by another request")
    }

    const balance = await tx.publisherBalance.findUnique({
      where: { publisherId: settlement.publisherId },
    })

    const publisherAmount = new Decimal(settlement.publisherAmount)
    // Outstanding clawback debt is repaid before anything reaches
    // withdrawable — the publisher owes the platform from a prior refund.
    const debt = balance ? new Decimal(balance.debtBalance ?? 0) : new Decimal(0)
    const debtApplied = Decimal.min(debt, publisherAmount)
    const credited = publisherAmount.minus(debtApplied)

    if (balance) {
      const updated = await tx.publisherBalance.updateMany({
        where: { publisherId: settlement.publisherId, version: balance.version },
        data: {
          withdrawableBalance: { increment: credited },
          debtBalance: { decrement: debtApplied },
          lifetimeEarnings: { increment: publisherAmount },
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException("Publisher balance was modified by another request. Retry.")
      }
    } else {
      await tx.publisherBalance.create({
        data: {
          publisherId: settlement.publisherId,
          withdrawableBalance: publisherAmount,
          lifetimeEarnings: publisherAmount,
        },
      })
    }

    await tx.order.update({
      where: { id: settlement.orderId },
      data: { status: "SETTLED" },
    })

    await tx.transaction.create({
      data: {
        amount: publisherAmount,
        type: "SETTLEMENT_RELEASE",
        orderId: settlement.orderId,
        publisherId: settlement.publisherId,
        settlementId,
        description: `Settlement release of ${publisherAmount.toFixed(2)} for order ${settlement.orderId}`,
      },
    })

    if (debtApplied.greaterThan(0)) {
      await tx.transaction.create({
        data: {
          amount: debtApplied.negated(),
          type: "DEBT_REPAYMENT",
          orderId: settlement.orderId,
          publisherId: settlement.publisherId,
          settlementId,
          description: `Debt repayment of ${debtApplied.toFixed(2)} netted from settlement release`,
        },
      })
    }

    await tx.orderEvent.create({
      data: {
        orderId: settlement.orderId,
        eventType: "SETTLED",
        actorId: userId,
        message: `Settlement released — ${settlement.publisherAmount} added to publisher balance`,
        metadata: { settlementId, publisherAmount: Number(settlement.publisherAmount) },
      },
    })
  }
}
