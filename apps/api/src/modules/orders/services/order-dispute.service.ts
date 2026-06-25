import { orderEventMetadata } from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import type { PrismaService } from "../../../common/prisma.service"
import type { AuditService } from "../../audit/audit.service"
import type { QueueService } from "../../queues/queue.service"
import type { RefundService } from "./refund.service"

@Injectable()
export class OrderDisputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly refund: RefundService,
    private readonly queue: QueueService,
  ) {}

  // Resolve the order's publisher for trust events.
  private async publisherIdForOrder(orderId: string): Promise<string | null> {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { website: { select: { publisherId: true } } },
    })
    return o?.website?.publisherId ?? null
  }

  // Staff dispute queue — open/under-review first, with the order + customer
  // context needed to triage without opening each one.
  async listDisputes(params: {
    status?: string
    page?: number
    limit?: number
  }) {
    const page = Math.max(params.page ?? 1, 1)
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)
    const where: any = {}
    if (params.status && params.status !== "all") where.status = params.status

    const [rows, total, openCount, underReviewCount] =
      await this.prisma.$transaction([
        this.prisma.orderDispute.findMany({
          where,
          include: {
            order: {
              select: {
                id: true,
                title: true,
                amount: true,
                status: true,
                organizationId: true,
                customer: { select: { id: true, name: true, email: true } },
                website: {
                  select: { domain: true, url: true, ownershipType: true },
                },
              },
            },
          },
          // Active disputes (OPEN/UNDER_REVIEW) bubble up, then newest first.
          orderBy: [{ status: "asc" }, { createdAt: "desc" }],
          take: limit,
          skip: (page - 1) * limit,
        }),
        this.prisma.orderDispute.count({ where }),
        this.prisma.orderDispute.count({ where: { status: "OPEN" } }),
        this.prisma.orderDispute.count({ where: { status: "UNDER_REVIEW" } }),
      ])

    return {
      items: rows.map((d: any) => ({
        id: d.id,
        orderId: d.orderId,
        status: d.status,
        reason: d.reason,
        resolution: d.resolution,
        raisedBy: d.raisedBy,
        resolvedBy: d.resolvedBy,
        resolvedAt: d.resolvedAt,
        createdAt: d.createdAt,
        order: d.order
          ? {
              id: d.order.id,
              title: d.order.title,
              amount: d.order.amount != null ? Number(d.order.amount) : null,
              status: d.order.status,
              customer: d.order.customer,
              website: d.order.website,
            }
          : null,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      counts: {
        open: openCount,
        underReview: underReviewCount,
        active: openCount + underReviewCount,
      },
    }
  }

  // Move an OPEN dispute to UNDER_REVIEW (triage claim).
  async markUnderReview(disputeId: string, userId: string) {
    const dispute = await this.prisma.orderDispute.findUnique({
      where: { id: disputeId },
    })
    if (!dispute) throw new NotFoundException("Dispute not found")
    if (dispute.status !== "OPEN")
      throw new BadRequestException("Only OPEN disputes can be moved to review")
    const updated = await this.prisma.orderDispute.update({
      where: { id: disputeId },
      data: { status: "UNDER_REVIEW" },
    })
    await this.audit.log({
      action: "DISPUTE_UNDER_REVIEW",
      entityType: "OrderDispute",
      entityId: disputeId,
      metadata: { orderId: dispute.orderId },
      userId,
      organizationId: null,
    })
    return updated
  }

  private async transitionOrder(
    orderId: string,
    fromVersion: number,
    data: any,
  ) {
    const r = await this.prisma.order.updateMany({
      where: { id: orderId, version: fromVersion },
      data: { ...data, version: { increment: 1 } },
    })
    if (r.count === 0) {
      throw new ConflictException(
        "Order was modified by another request. Retry.",
      )
    }
  }

  async openDispute(
    orderId: string,
    organizationId: string,
    userId: string,
    reason: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
    })
    if (!order) throw new NotFoundException("Order not found")

    const disputableStatuses = [
      "PUBLISHED",
      "VERIFIED",
      "DELIVERED",
      "CANCELLED",
    ]
    if (
      !disputableStatuses.includes(order.status) &&
      order.paymentStatus !== "PAID"
    ) {
      throw new BadRequestException(
        "Order cannot be disputed in its current state",
      )
    }

    const existingDispute = await this.prisma.orderDispute.findFirst({
      where: { orderId },
    })
    if (
      existingDispute &&
      existingDispute.status !== "RESOLVED_REJECTED" &&
      existingDispute.status !== "RESOLVED_RESTORED"
    ) {
      throw new BadRequestException(
        "An active dispute already exists for this order",
      )
    }

    const dispute = await this.prisma.orderDispute.create({
      data: {
        orderId,
        raisedBy: userId,
        reason,
        status: "OPEN",
        // RESTORE/REJECT resolutions return the order to exactly this status
        previousStatus: order.status as any,
      },
    })

    await this.transitionOrder(orderId, order.version, { status: "DISPUTED" })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "DISPUTE_OPENED",
        actorId: userId,
        message: `Dispute opened: ${reason}`,
        metadata: { disputeId: dispute.id, reason },
      },
    })

    await this.audit.log({
      action: "DISPUTE_OPENED",
      entityType: "Order",
      entityId: orderId,
      metadata: { ...orderEventMetadata(order), disputeId: dispute.id, reason },
      userId,
      organizationId,
    })

    // Snapshot the evidence inventory at dispute-open so reviewers see a
    // complete, immutable package (assembled live via GET /disputes/:id/evidence).
    const [versionCount, snapshotCount, fraudCount] = await Promise.all([
      this.prisma.orderDeliveryVersion.count({ where: { orderId } }),
      this.prisma.deliverySnapshot.count({
        where: { deliveryVersion: { orderId } },
      }),
      this.prisma.deliveryFraudFlag.count({ where: { orderId } }),
    ])
    await this.audit.log({
      action: "DISPUTE_EVIDENCE_ATTACHED",
      entityType: "OrderDispute",
      entityId: dispute.id,
      metadata: {
        ...orderEventMetadata(order),
        orderId,
        deliveryVersions: versionCount,
        snapshots: snapshotCount,
        fraudFlags: fraudCount,
      },
      userId,
      organizationId,
    })

    await this.queue.enqueueTrustRecompute(
      await this.publisherIdForOrder(orderId),
      "DISPUTE_OPENED",
      `dispute opened on order ${orderId}`,
    )

    return dispute
  }

  async resolveDispute(
    disputeId: string,
    userId: string,
    _staffRole: string,
    resolution: string,
    action: "RESTORE" | "REFUND" | "REJECT",
  ) {
    const dispute = await this.prisma.orderDispute.findUnique({
      where: { id: disputeId },
      include: { order: true },
    })
    if (!dispute) throw new NotFoundException("Dispute not found")
    if (dispute.status !== "OPEN" && dispute.status !== "UNDER_REVIEW") {
      throw new BadRequestException(
        "Dispute is not resolvable in current state",
      )
    }

    const order = dispute.order
    // Stored at dispute open; fall back to PUBLISHED only for pre-migration
    // disputes that never recorded it.
    const restoreStatus =
      order.status === "DISPUTED"
        ? (dispute.previousStatus ?? "PUBLISHED")
        : order.status

    if (action === "RESTORE") {
      await this.prisma.orderDispute.update({
        where: { id: disputeId },
        data: {
          status: "RESOLVED_RESTORED",
          resolvedBy: userId,
          resolvedAt: new Date(),
          resolution,
        },
      })

      await this.transitionOrder(order.id, order.version, {
        status: restoreStatus as any,
      })
    } else if (action === "REFUND") {
      // Refund first — if it fails, the dispute stays open instead of being
      // marked resolved with the customer never refunded. If the order was
      // ALREADY refunded (a prior resolution attempt crashed after the refund
      // committed), skip straight to resolving — otherwise the dispute is
      // permanently stuck behind the duplicate-refund guard.
      if (order.paymentStatus !== "REFUNDED") {
        await this.refund.refundOrder(
          order.id,
          `Dispute resolved with refund: ${resolution}`,
          userId,
        )
      }

      await this.prisma.orderDispute.update({
        where: { id: disputeId },
        data: {
          status: "RESOLVED_REFUNDED",
          resolvedBy: userId,
          resolvedAt: new Date(),
          resolution,
        },
      })
    } else if (action === "REJECT") {
      await this.prisma.orderDispute.update({
        where: { id: disputeId },
        data: {
          status: "RESOLVED_REJECTED",
          resolvedBy: userId,
          resolvedAt: new Date(),
          resolution,
        },
      })

      // Restore order to pre-dispute state
      await this.transitionOrder(order.id, order.version, {
        status: restoreStatus as any,
      })
    }

    await this.prisma.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "DISPUTE_RESOLVED",
        actorId: userId,
        message: `Dispute resolved: ${resolution}`,
        metadata: { disputeId, resolution, action },
      },
    })

    await this.audit.log({
      action: `DISPUTE_${action}`,
      entityType: "Dispute",
      entityId: disputeId,
      metadata: { ...orderEventMetadata(order), orderId: order.id, resolution },
      userId,
      organizationId: order.organizationId,
    })

    await this.queue.enqueueTrustRecompute(
      await this.publisherIdForOrder(order.id),
      "DISPUTE_RESOLVED",
      `dispute ${disputeId} resolved (${action})`,
    )

    return this.prisma.orderDispute.findUnique({ where: { id: disputeId } })
  }
}
