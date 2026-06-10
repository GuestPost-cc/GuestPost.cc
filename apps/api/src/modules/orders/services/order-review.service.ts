import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"
import { QUEUES } from "@guestpost/shared"

@Injectable()
export class OrderReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

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

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: "APPROVED" },
    })

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

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: "CONTENT_REQUESTED",
        revisionCount: { increment: 1 },
      },
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

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: "DELIVERED", deliveredAt: new Date() },
    })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "DELIVERY_CONFIRMED",
        actorId: userId,
        message: `Delivery confirmed by customer`,
      },
    })

    // Auto-create settlement
    await this.createSettlementForOrder(orderId, organizationId)

    await this.audit.log({
      action: "DELIVERY_CONFIRMED",
      entityType: "Order",
      entityId: orderId,
      metadata: {},
      userId,
      organizationId,
    })

    return updated
  }

  private async createSettlementForOrder(orderId: string, organizationId: string) {
    const existingSettlement = await this.prisma.settlement.findFirst({ where: { orderId } })
    if (existingSettlement) return

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { website: true },
    })
    if (!order) return

    const publisher = await this.prisma.publisher.findFirst({
      where: { websites: { some: { id: order.websiteId ?? undefined } } },
    })
    if (!publisher) return

    const grossAmount = order.amount ? Number(order.amount) : 0
    const platformFee = grossAmount * 0.2
    const publisherAmount = grossAmount - platformFee
    const reviewDays = 5
    const reviewEndsAt = new Date(Date.now() + reviewDays * 24 * 60 * 60 * 1000)

    await this.prisma.settlement.create({
      data: {
        orderId,
        publisherId: publisher.id,
        grossAmount,
        platformFee,
        publisherAmount,
        status: "PENDING",
        reviewEndsAt,
      },
    })
  }
}
