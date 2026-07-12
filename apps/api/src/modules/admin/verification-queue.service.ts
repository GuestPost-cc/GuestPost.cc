import { WorkflowDecisionService } from "@guestpost/shared"
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { DeliveryInterventionService } from "../orders/services/delivery-intervention.service"

@Injectable()
export class AdminVerificationQueueService {
  private readonly decision: WorkflowDecisionService

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly intervention: DeliveryInterventionService,
  ) {
    this.decision = new WorkflowDecisionService()
  }

  async listQueue() {
    const orders = await this.prisma.order.findMany({
      where: {
        status: "PUBLISHED",
        activeDeliveryVersion: {
          verificationStatus: { in: ["FAILED", "MANUAL_REVIEW"] },
        },
      },
      include: {
        website: {
          select: {
            id: true,
            url: true,
            publisherId: true,
            publisher: {
              select: { tier: true },
            },
          },
        },
        customer: {
          select: { id: true, name: true, email: true },
        },
        activeDeliveryVersion: {
          include: {
            evidence: { orderBy: { createdAt: "desc" }, take: 1 },
            fraudFlags: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    })

    const now = Date.now()
    const items = (orders as any[]).map((order: any) => {
      const version = order.activeDeliveryVersion
      const evidence = version?.evidence?.[0] ?? null
      const queueTimeMs = now - (version?.createdAt?.getTime() ?? now)
      const priority = this.decision.computeVerificationPriority(
        { amount: Number(order.amount ?? 0) },
        order.website?.publisher ?? null,
        queueTimeMs,
      )

      return {
        orderId: order.id,
        status: order.status,
        title: order.title,
        amount: order.amount,
        targetUrl: order.targetUrl,
        anchorText: order.anchorText,
        createdAt: order.createdAt,
        customer: order.customer,
        publisher: order.website
          ? {
              id: order.website.publisherId,
              tier: order.website.publisher?.tier ?? null,
            }
          : null,
        deliveryVersion: version
          ? {
              id: version.id,
              version: version.version,
              verificationStatus: version.verificationStatus,
              verificationFailureReason: version.verificationFailureReason,
              publishedUrl: version.publishedUrl,
              submittedAt: version.submittedAt,
              verificationVersion: version.verificationVersion,
              adminOverrideReason: version.adminOverrideReason,
              adminVerifiedNotes: version.adminVerifiedNotes,
              evidence: evidence
                ? {
                    httpStatus: evidence.httpStatus,
                    resolvedUrl: evidence.resolvedUrl,
                    anchorFound: evidence.anchorFound,
                    linkFound: evidence.linkFound,
                    targetUrlMatched: evidence.targetUrlMatched,
                    redirectChain: evidence.redirectChain,
                    checkedAt: evidence.checkedAt,
                  }
                : null,
              fraudFlags: (version.fraudFlags ?? []).map((f: any) => ({
                type: f.type,
                details: f.details,
              })),
            }
          : null,
        priority,
      }
    })

    items.sort((a: any, b: any) => b.priority.score - a.priority.score)
    return items
  }

  async retry(orderId: string, userId: string) {
    const order: any = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, activeDeliveryVersionId: true, status: true },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "PUBLISHED")
      throw new NotFoundException("Order is not in PUBLISHED status")
    if (!order.activeDeliveryVersionId)
      throw new NotFoundException("Order has no active delivery version")

    return this.intervention.reverify(order.activeDeliveryVersionId, userId)
  }

  async markVerified(
    orderId: string,
    userId: string,
    role: string,
    reason: string,
    notes?: string,
  ) {
    const order: any = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        website: { select: { publisherId: true } },
        activeDeliveryVersion: true,
      },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "PUBLISHED")
      throw new NotFoundException("Order is not in PUBLISHED status")
    if (!order.activeDeliveryVersion)
      throw new NotFoundException("Order has no active delivery version")

    const version: any = order.activeDeliveryVersion
    const now = new Date()
    const reviewWindowMs =
      this.decision.computeReviewWindowDays() * 24 * 60 * 60 * 1000
    const autoAcceptAt = new Date(now.getTime() + reviewWindowMs)

    const upd = await this.prisma.orderDeliveryVersion.updateMany({
      where: {
        id: version.id,
        verificationVersion: version.verificationVersion,
      },
      data: {
        interventionStatus: "APPROVED",
        verificationFailureReason: null,
        verificationVersion: version.verificationVersion + 1,
        adminVerifiedById: userId,
        adminOverrideReason: reason as any,
        adminVerifiedNotes: notes ?? null,
      },
    })
    if (upd.count === 0)
      throw new ConflictException(
        "Delivery was modified by another request. Retry.",
      )

    const orderUpd = await this.prisma.order.updateMany({
      where: { id: order.id, status: "PUBLISHED" },
      data: {
        status: "VERIFIED",
        verifiedAt: now,
        verifiedBy: userId,
        verifyMethod: "MANUAL_ADMIN",
        autoAcceptAt,
      },
    })
    if (orderUpd.count === 0)
      throw new ConflictException(
        "Order was modified by another request. Retry.",
      )

    await this.prisma.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "VERIFIED_MANUAL",
        actorId: userId,
        message: `Admin manually verified delivery — reason: ${reason}${notes ? ` (${notes})` : ""}`,
        metadata: {
          deliveryVersionId: version.id,
          verifyMethod: "MANUAL_ADMIN",
          adminReason: reason,
          adminNotes: notes ?? null,
          autoAcceptAt: autoAcceptAt.toISOString(),
        },
      },
    })

    await this.audit.log({
      action: "ORDER_DELIVERY_MANUAL_APPROVED",
      entityType: "OrderDeliveryVersion",
      entityId: version.id,
      metadata: {
        orderId: order.id,
        deliveryVersionId: version.id,
        publisherId: order.website?.publisherId ?? null,
        reason,
        roleAtTime: role,
        notes: notes ?? null,
      },
      userId,
      organizationId: order.organizationId,
    })

    return {
      status: "VERIFIED",
      verifyMethod: "MANUAL_ADMIN",
      autoAcceptAt,
    }
  }

  async reject(orderId: string, userId: string, role: string, reason: string) {
    const order: any = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        website: { select: { publisherId: true } },
        activeDeliveryVersion: true,
      },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "PUBLISHED")
      throw new NotFoundException("Order is not in PUBLISHED status")
    if (!order.activeDeliveryVersion)
      throw new NotFoundException("Order has no active delivery version")

    const version: any = order.activeDeliveryVersion

    const upd = await this.prisma.orderDeliveryVersion.updateMany({
      where: {
        id: version.id,
        verificationVersion: version.verificationVersion,
      },
      data: {
        interventionStatus: "REJECTED",
        verificationFailureReason: reason,
        verificationVersion: version.verificationVersion + 1,
      },
    })
    if (upd.count === 0)
      throw new ConflictException(
        "Delivery was modified by another request. Retry.",
      )

    await this.prisma.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "ORDER_CANCELLED",
        actorId: userId,
        message: `Delivery rejected by admin: ${reason}`,
        metadata: {
          deliveryVersionId: version.id,
          reason,
        },
      },
    })

    await this.audit.log({
      action: "ORDER_DELIVERY_MANUAL_REJECTED",
      entityType: "OrderDeliveryVersion",
      entityId: version.id,
      metadata: {
        orderId: order.id,
        deliveryVersionId: version.id,
        publisherId: order.website?.publisherId ?? null,
        reason,
        roleAtTime: role,
      },
      userId,
      organizationId: order.organizationId,
    })

    return { status: "REJECTED" }
  }

  async requestReverify(
    orderId: string,
    userId: string,
    role: string,
    ticketId?: string,
  ) {
    const order: any = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        website: { select: { id: true, url: true, publisherId: true } },
      },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "PUBLISHED")
      throw new NotFoundException("Order is not in PUBLISHED status")

    const version: any = order.activeDeliveryVersionId
      ? await this.prisma.orderDeliveryVersion.findUnique({
          where: { id: order.activeDeliveryVersionId },
        })
      : null

    await this.prisma.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "VERIFICATION_ESCALATED",
        actorId: userId,
        message: `Reverification requested${ticketId ? ` — ticket #${ticketId}` : ""}`,
        metadata: {
          requestedBy: userId,
          ticketId: ticketId ?? null,
          deliveryVersionId: version?.id ?? null,
        },
      },
    })

    await this.audit.log({
      action: "ORDER_DELIVERY_REVERIFY_REQUESTED",
      entityType: "Order",
      entityId: order.id,
      metadata: {
        orderId: order.id,
        publisherId: order.website?.publisherId ?? null,
        ticketId: ticketId ?? null,
        roleAtTime: role,
      },
      userId,
      organizationId: order.organizationId,
    })

    if (order.website?.publisherId) {
      const owners = await this.prisma.publisherMembership.findMany({
        where: {
          publisherId: order.website.publisherId,
          role: "PUBLISHER_OWNER",
        },
        select: { userId: true },
      })
      for (const owner of owners) {
        await this.prisma.notification.create({
          data: {
            userId: owner.userId,
            organizationId: order.organizationId,
            type: "ORDER_DELIVERY_REVERIFY_REQUESTED",
            message: `Reverification requested for order ${order.id}. Please review and re-submit your delivery.${ticketId ? ` Support ticket: #${ticketId}.` : ""}`,
            dedupKey: `reverify-${order.id}-${owner.userId}`,
          },
        })
      }
    }

    return { status: "REVERIFY_REQUESTED", ticketId: ticketId ?? null }
  }
}
