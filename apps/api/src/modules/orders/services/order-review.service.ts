import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"
import { QUEUES } from "@guestpost/shared"
import { resolvePlatformFeeFraction, splitPlatformFee } from "../../../common/platform-fee"

@Injectable()
export class OrderReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  private async transition(orderId: string, fromVersion: number, data: any) {
    const r = await this.prisma.order.updateMany({
      where: { id: orderId, version: fromVersion },
      data: { ...data, version: { increment: 1 } },
    })
    if (r.count === 0) {
      throw new ConflictException("Order was modified by another request. Retry.")
    }
    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  }

  async approveContent(orderId: string, organizationId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      include: { items: { include: { website: { select: { publisherId: true } } } } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "CUSTOMER_REVIEW") {
      throw new BadRequestException("Order must be in CUSTOMER_REVIEW to approve content")
    }

    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId },
    })
    const isOwner = membership?.role === "OWNER"
    const isCreator = order.customerId === userId
    if (!isOwner && !isCreator) {
      throw new ForbiddenException("Only organization owner or order creator can approve content")
    }

    const updated = await this.transition(orderId, order.version, { status: "APPROVED" })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "CONTENT_APPROVED",
        actorId: userId,
        message: `Content approved by customer`,
      },
    })

    await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
      userId: order.assigneeId ?? "",
      organizationId,
      type: "CONTENT_APPROVED",
      message: `Content for order ${orderId} was approved — proceed to publish`,
    })

    return updated
  }

  async requestRevision(orderId: string, organizationId: string, userId: string, notes: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      include: {
        items: {
          include: { website: { select: { publisherId: true } } },
        },
      },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "CUSTOMER_REVIEW") {
      throw new BadRequestException("Order must be in CUSTOMER_REVIEW to request revision")
    }

    // Find revision rounds cap from first listing
    const listing = await this.prisma.marketplaceListing.findFirst({
      where: { websiteId: order.websiteId ?? undefined },
      select: { revisionRounds: true },
    })
    const maxRevisions = listing?.revisionRounds ?? 2
    if (order.revisionCount >= maxRevisions) {
      throw new BadRequestException(`Maximum revisions (${maxRevisions}) reached. Open a dispute if unsatisfied.`)
    }

    const updated = await this.transition(orderId, order.version, {
      status: "CONTENT_REQUESTED",
      revisionCount: { increment: 1 },
    })

    await this.prisma.revision.create({
      data: { orderId, notes, status: "REQUESTED" },
    })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "REVISION_REQUESTED",
        actorId: userId,
        message: `Revision requested: ${notes}`,
        metadata: { revisionNumber: order.revisionCount + 1, notes },
      },
    })

    await this.audit.log({
      action: "REVISION_REQUESTED",
      entityType: "Order",
      entityId: orderId,
      metadata: { revisionNumber: order.revisionCount + 1 },
      userId,
      organizationId,
    })

    return updated
  }

  async confirmDelivery(orderId: string, organizationId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "VERIFIED") {
      throw new BadRequestException("Order must be VERIFIED before confirming delivery")
    }

    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId },
    })
    const isOwner = membership?.role === "OWNER"
    const isCreator = order.customerId === userId
    if (!isOwner && !isCreator) {
      throw new ForbiddenException("Only organization owner or order creator can confirm delivery")
    }

    // Delivery transition and settlement/revenue creation commit atomically —
    // a crash in between would leave a DELIVERED order with no settlement and
    // nothing to retry it.
    const updated = await this.prisma.$transaction(async (tx: any) => {
      const r = await tx.order.updateMany({
        where: { id: orderId, version: order.version },
        data: { status: "DELIVERED", deliveredAt: new Date(), version: { increment: 1 } },
      })
      if (r.count === 0) {
        throw new ConflictException("Order was modified by another request. Retry.")
      }
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId } })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "DELIVERY_CONFIRMED",
          actorId: userId,
          message: `Delivery confirmed by customer`,
        },
      })

      await this.createSettlementForOrder(tx, orderId)

      await this.audit.log({
        action: "DELIVERY_CONFIRMED",
        entityType: "Order",
        entityId: orderId,
        metadata: {},
        userId,
        organizationId,
      }, tx)

      return fresh
    })

    return updated
  }

  private async createSettlementForOrder(tx: any, orderId: string) {
    const existingSettlement = await tx.settlement.findFirst({
      where: { orderId, status: { not: "CANCELLED" } },
    })
    if (existingSettlement) return

    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { website: true },
    })
    if (!order || !order.amount) return

    // Platform-owned websites: record platform revenue, skip settlement
    if (order.website?.ownershipType === "PLATFORM") {
      const existingRevenue = await tx.platformRevenue.findUnique({ where: { orderId } })
      if (existingRevenue) return

      const feeFraction = await resolvePlatformFeeFraction(tx)
      const { fee: platformFee, net: netRevenue } = splitPlatformFee(order.amount, feeFraction)

      await tx.platformRevenue.create({
        data: {
          orderId,
          amount: order.amount,
          platformFee,
          netRevenue,
          recordedAt: new Date(),
        },
      })
      return
    }

    // Publisher-owned websites: create settlement for publisher payout
    const publisher = await tx.publisher.findFirst({
      where: { websites: { some: { id: order.websiteId ?? undefined } } },
    })
    if (!publisher) return

    const feeFraction = await resolvePlatformFeeFraction(tx)
    const { fee: platformFee, net: publisherAmount } = splitPlatformFee(order.amount, feeFraction)
    const reviewDays = Math.max(Number(process.env.SETTLEMENT_REVIEW_DAYS ?? 7), 0)
    const reviewEndsAt = new Date(Date.now() + reviewDays * 24 * 60 * 60 * 1000)

    await tx.settlement.create({
      data: {
        orderId,
        publisherId: publisher.id,
        grossAmount: order.amount,
        platformFee,
        publisherAmount,
        status: "PENDING",
        reviewEndsAt,
      },
    })
  }
}
