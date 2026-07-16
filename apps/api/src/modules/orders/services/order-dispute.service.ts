import { CancellationResponsibility } from "@guestpost/database"
import {
  ACTIVE_CANCELLATION_REQUEST_STATUSES,
  decideOrderCancellation,
  orderEventMetadata,
} from "@guestpost/shared"
import { FinalRefundResponsibility } from "@guestpost/shared/dist/order-refund-core"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"
import { RefundService } from "./refund.service"

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
    db: any,
    orderId: string,
    fromVersion: number,
    data: any,
  ) {
    const r = await db.order.updateMany({
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
      include: {
        website: { select: { ownershipType: true } },
        cancellationRequests: {
          where: {
            status: { in: [...ACTIVE_CANCELLATION_REQUEST_STATUSES] },
          },
          select: { id: true },
          take: 1,
        },
        dispute: { select: { id: true } },
      },
    })
    if (!order) throw new NotFoundException("Order not found")

    const channel =
      order.fulfillmentChannel ??
      (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
    const decision = decideOrderCancellation({
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentChannel: channel,
      actor: "CUSTOMER",
      hasActiveRequest: order.cancellationRequests.length > 0,
      hasActiveDispute: Boolean(order.dispute),
      fulfillmentDueAt: order.fulfillmentDueAt,
      warrantyEndsAt: order.warrantyEndsAt,
    })
    if (decision.action !== "OPEN_DISPUTE") {
      throw new BadRequestException(decision.message)
    }

    if (order.dispute) {
      throw new ConflictException(
        "This order already has a dispute record; reopen it through support instead of creating a duplicate",
      )
    }

    let dispute: any
    try {
      dispute = await this.prisma.$transaction(async (tx: any) => {
        const created = await tx.orderDispute.create({
          data: {
            orderId,
            raisedBy: userId,
            reason,
            status: "OPEN",
            // RESTORE/REJECT resolutions return the order to exactly this status
            previousStatus: order.status as any,
          },
        })
        await this.transitionOrder(tx, orderId, order.version, {
          status: "DISPUTED",
        })
        await tx.orderEvent.create({
          data: {
            orderId,
            eventType: "DISPUTE_OPENED",
            actorId: userId,
            message: `Dispute opened: ${reason}`,
            metadata: { disputeId: created.id, reason },
          },
        })
        await this.audit.log(
          {
            action: "DISPUTE_OPENED",
            entityType: "Order",
            entityId: orderId,
            metadata: {
              ...orderEventMetadata(order),
              disputeId: created.id,
              reason,
            },
            userId,
            organizationId,
          },
          tx,
        )
        return created
      })
    } catch (error: any) {
      if (error?.code === "P2002") {
        throw new ConflictException(
          "This order already has a dispute record; reopen it through support instead of creating a duplicate",
        )
      }
      throw error
    }

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
    staffRole: string,
    resolution: string,
    action: "RESTORE" | "REFUND" | "REJECT",
    responsibility?: CancellationResponsibility,
  ) {
    if (
      action === "REFUND" &&
      !["SUPER_ADMIN", "FINANCE"].includes(staffRole)
    ) {
      throw new ForbiddenException(
        "Finance approval is required for a dispute refund",
      )
    }
    if (action !== "REFUND" && staffRole === "FINANCE") {
      throw new ForbiddenException(
        "Finance can approve refunds but cannot decide operational dispute outcomes",
      )
    }
    if (
      action === "REFUND" &&
      (!responsibility ||
        responsibility === CancellationResponsibility.UNDETERMINED)
    ) {
      throw new BadRequestException(
        "A specific responsibility attribution is required for a dispute refund",
      )
    }

    const resolved = await this.prisma.$transaction(async (tx: any) => {
      const dispute = await tx.orderDispute.findUnique({
        where: { id: disputeId },
        include: {
          order: {
            include: {
              website: { select: { ownershipType: true, publisherId: true } },
            },
          },
        },
      })
      if (!dispute) throw new NotFoundException("Dispute not found")
      if (dispute.status !== "OPEN" && dispute.status !== "UNDER_REVIEW") {
        throw new BadRequestException(
          "Dispute is not resolvable in current state",
        )
      }

      const order = dispute.order
      const restoreStatus =
        order.status === "DISPUTED"
          ? (dispute.previousStatus ?? "PUBLISHED")
          : order.status
      let refundTransactionId: string | null = null
      if (action === "REFUND") {
        const refunded = await this.refund.refundOrderInTransaction(
          tx,
          order,
          `Dispute resolved with refund: ${resolution}`,
          userId,
          `dispute-refund:${disputeId}`,
          responsibility as FinalRefundResponsibility,
        )
        refundTransactionId = refunded.refundTransactionId
      } else {
        await this.transitionOrder(tx, order.id, order.version, {
          status: restoreStatus as any,
        })
      }

      const updated = await tx.orderDispute.updateMany({
        where: {
          id: disputeId,
          status: { in: ["OPEN", "UNDER_REVIEW"] },
        },
        data: {
          status:
            action === "REFUND"
              ? "RESOLVED_REFUNDED"
              : action === "RESTORE"
                ? "RESOLVED_RESTORED"
                : "RESOLVED_REJECTED",
          resolvedBy: userId,
          resolvedAt: new Date(),
          resolution,
        },
      })
      if (updated.count === 0) {
        throw new ConflictException("Dispute was resolved concurrently")
      }
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          eventType: "DISPUTE_RESOLVED",
          actorId: userId,
          message: `Dispute resolved: ${resolution}`,
          metadata: {
            disputeId,
            resolution,
            action,
            responsibility: responsibility ?? null,
            refundTransactionId,
          },
        },
      })
      await this.audit.log(
        {
          action: `DISPUTE_${action}`,
          entityType: "Dispute",
          entityId: disputeId,
          metadata: {
            ...orderEventMetadata(order),
            orderId: order.id,
            resolution,
            responsibility: responsibility ?? null,
            refundTransactionId,
          },
          userId,
          organizationId: order.organizationId,
        },
        tx,
      )
      return {
        dispute: await tx.orderDispute.findUniqueOrThrow({
          where: { id: disputeId },
        }),
        orderId: order.id,
      }
    })

    await this.queue.enqueueTrustRecompute(
      await this.publisherIdForOrder(resolved.orderId),
      "DISPUTE_RESOLVED",
      `dispute ${disputeId} resolved (${action})`,
    )

    return resolved.dispute
  }
}
