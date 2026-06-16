import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"
import { QUEUES, recomputePublisherTrustCore, orderEventMetadata, getSettlementReviewDays, type PublisherTier } from "@guestpost/shared"
import { resolvePlatformFeeFraction, splitPlatformFee } from "../../../common/platform-fee"

@Injectable()
export class OrderReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  // Customer review for a completed order. One per order. Recomputes the
  // publisher's aggregate rating (the trust score in TR-B3 builds on this).
  async submitReview(orderId: string, organizationId: string, userId: string, rating: number, comment?: string) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException("Rating must be an integer from 1 to 5")
    }
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      include: { website: { select: { publisherId: true } } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (!["DELIVERED", "SETTLED", "COMPLETED"].includes(order.status)) {
      throw new BadRequestException("You can review an order once it is delivered")
    }
    const isCreator = order.customerId === userId
    const isOwner = await this.prisma.membership.findFirst({ where: { organizationId, userId, role: "OWNER" } })
    if (!isCreator && !isOwner) throw new ForbiddenException("Only the order creator or organization owner can review")

    const publisherId = order.website?.publisherId ?? null

    const existing = await this.prisma.orderReview.findUnique({ where: { orderId }, select: { id: true } })
    const review = await this.prisma.orderReview.upsert({
      where: { orderId },
      create: { orderId, publisherId, customerId: userId, rating, comment: comment?.slice(0, 2000) || null },
      update: { rating, comment: comment?.slice(0, 2000) || null },
    })

    // Event-driven trust recompute (debounced/deduped via the queue).
    await this.queue.enqueueTrustRecompute(
      publisherId,
      existing ? "ORDER_REVIEW_UPDATED" : "ORDER_REVIEW_CREATED",
      `review on order ${orderId}`,
    )

    await this.prisma.orderEvent.create({
      data: { orderId, eventType: "DELIVERY_CONFIRMED", actorId: userId, message: `Customer left a ${rating}-star review` },
    })
    await this.audit.log({
      action: "ORDER_REVIEWED",
      entityType: "Order",
      entityId: orderId,
      metadata: { ...orderEventMetadata(order), rating, publisherId },
      userId,
      organizationId,
    })
    return review
  }

  // Synchronous recompute (manual admin endpoint). The shared core is the single
  // implementation; the worker uses the same one for the event-driven path.
  async recomputePublisherTrust(publisherId: string, sourceEvent = "MANUAL") {
    const r = await recomputePublisherTrustCore(this.prisma, publisherId, { sourceEvent })
    return r ? { publisherId, score: r.newScore, tier: r.newTier, band: r.newScore >= 70 ? "High" : r.newScore >= 40 ? "Medium" : "Low" } : null
  }

  async getReview(orderId: string, organizationId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId }, select: { id: true } })
    if (!order) throw new NotFoundException("Order not found")
    return this.prisma.orderReview.findUnique({ where: { orderId } })
  }

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

    // Phase 7: revision-rounds cap moved off the deprecated listing-level
    // column onto the snapshotted ListingService. We read the SAME row the
    // order locked into at creation, so customer + publisher contract
    // matches what they saw at checkout even after subsequent edits.
    let maxRevisions = 2
    if (order.listingServiceId) {
      const ls = await this.prisma.listingService.findUnique({
        where: { id: order.listingServiceId },
        select: { revisionRounds: true },
      })
      if (ls?.revisionRounds != null) maxRevisions = ls.revisionRounds
    }
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
      metadata: { ...orderEventMetadata(order), revisionNumber: order.revisionCount + 1 },
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
      // Phase 6.9 — Audit finding #22 closure. The inner updateMany previously
      // gated on (id, version) only. A race window existed where a parallel
      // customer-accept-delivery (PUBLISHED → DELIVERED) could commit first,
      // bumping `version` but ALSO leaving the row in DELIVERED state. Without
      // the status guard, confirmDelivery's updateMany would still match (it
      // re-reads the version on retry) and we'd attempt a second DELIVERED
      // transition + duplicate settlement creation. The status guard makes
      // this race deterministic — the second tx fails fast with 409.
      const r = await tx.order.updateMany({
        where: { id: orderId, version: order.version, status: "VERIFIED" },
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
        // Use `fresh` so the audit row carries the post-transition state
        // (status=DELIVERED, version+1). orderEventMetadata reads the
        // snapshot trio which is immutable after creation either way.
        metadata: { ...orderEventMetadata(fresh) },
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

    // Phase 6 snapshot resolver. Reads the order's per-service price from
    // the snapshotted ListingService (or NULL for legacy orders) so both
    // PlatformRevenue and Settlement freeze the same five fields.
    let snapshotLsId: string | null = order.listingServiceId ?? null
    let snapshotServiceType: any   = order.type ?? null
    let snapshotUnitPrice: any     = null
    if (order.listingServiceId) {
      const ls = await tx.listingService.findUnique({
        where: { id: order.listingServiceId },
        select: { price: true, serviceType: true },
      })
      if (ls) {
        snapshotUnitPrice = ls.price
        snapshotServiceType = ls.serviceType
      }
    }
    const snapshotOwnerType = order.website?.ownershipType ?? null

    // Platform channel orders: record platform revenue, skip settlement.
    // Channel snapshot wins; ownership fallback for legacy orders only.
    const channel = order.fulfillmentChannel ?? (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
    if (channel === "PLATFORM") {
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
          // Phase 6 snapshots — frozen at recognition time.
          listingServiceId:   snapshotLsId,
          serviceType:        snapshotServiceType,
          ownerType:          snapshotOwnerType,
          fulfillmentChannel: "PLATFORM",
          unitPrice:          snapshotUnitPrice,
        },
      })
      return
    }

    // Publisher-owned websites: create settlement for publisher payout
    if (!order.websiteId) {
      throw new Error(`Order ${orderId} has no websiteId — cannot create settlement`)
    }
    const website = await tx.website.findUnique({
      where: { id: order.websiteId },
      select: { publisherId: true },
    })
    if (!website) {
      throw new Error(`Website ${order.websiteId} not found for order ${orderId}`)
    }
    if (!website.publisherId) {
      throw new Error(`Website ${order.websiteId} has no publisher — cannot create settlement`)
    }
    const publisher = await tx.publisher.findUnique({
      where: { id: website.publisherId },
    })
    if (!publisher) return

    const feeFraction = await resolvePlatformFeeFraction(tx)
    const { fee: platformFee, net: publisherAmount } = splitPlatformFee(order.amount, feeFraction)
    // Phase 7.2 — tier-aware review window (audit #6). Helper applies env
    // override when set (incident-response escape hatch); otherwise per-tier
    // table in packages/shared/src/publisher-tier-policy.ts.
    const reviewDays = getSettlementReviewDays(publisher.tier as PublisherTier, process.env.SETTLEMENT_REVIEW_DAYS)
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
        // Phase 6 snapshots — same shape as createSettlement() in
        // SettlementsService for parity.
        listingServiceId:   snapshotLsId,
        serviceType:        snapshotServiceType,
        ownerType:          snapshotOwnerType,
        fulfillmentChannel: "PUBLISHER",
        unitPrice:          snapshotUnitPrice,
      },
    })
  }
}
