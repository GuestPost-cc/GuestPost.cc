import { WorkflowDecisionService } from "@guestpost/shared"
import { Injectable, NotFoundException } from "@nestjs/common"
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
        OR: [
          {
            status: "PUBLISHED",
            activeDeliveryVersion: {
              verificationStatus: { in: ["FAILED", "MANUAL_REVIEW"] },
            },
          },
          { fraudFlags: { some: { resolution: null } } },
        ],
      },
      include: {
        website: {
          select: {
            id: true,
            name: true,
            url: true,
            domain: true,
            ownershipType: true,
            publisherId: true,
            publisher: {
              select: { id: true, name: true, email: true, tier: true },
            },
          },
        },
        customer: {
          select: { id: true, name: true, email: true },
        },
        activeDeliveryVersion: {
          include: {
            evidence: { orderBy: { createdAt: "desc" }, take: 1 },
          },
        },
        fraudFlags: {
          where: { resolution: null },
          orderBy: { createdAt: "asc" },
          include: {
            deliveryVersion: {
              select: {
                id: true,
                version: true,
                publishedUrl: true,
                verificationStatus: true,
                supersededByVersion: true,
                evidence: {
                  orderBy: { checkedAt: "desc" },
                  take: 1,
                  select: {
                    httpStatus: true,
                    resolvedUrl: true,
                    anchorFound: true,
                    linkFound: true,
                    targetUrlMatched: true,
                    checkedAt: true,
                  },
                },
              },
            },
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
      const priority =
        order.fraudFlags.length > 0
          ? { score: 100, label: "CRITICAL" as const }
          : this.decision.computeVerificationPriority(
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
        website: order.website
          ? {
              id: order.website.id,
              name: order.website.name,
              url: order.website.url,
              domain: order.website.domain,
              ownershipType: order.website.ownershipType,
            }
          : null,
        publisher: order.website?.publisher
          ? {
              id: order.website.publisher.id,
              name: order.website.publisher.name,
              email: order.website.publisher.email,
              tier: order.website.publisher.tier,
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
              fraudFlags: (order.fraudFlags ?? []).map((f: any) => ({
                id: f.id,
                deliveryVersionId: f.deliveryVersionId,
                type: f.type,
                details: f.details,
                createdAt: f.createdAt,
                deliveryVersion: {
                  ...f.deliveryVersion,
                  evidence: f.deliveryVersion.evidence[0] ?? null,
                },
              })),
            }
          : null,
        priority,
      }
    })

    items.sort((a: any, b: any) => b.priority.score - a.priority.score)
    return items
  }

  async retry(orderId: string, userId: string, role: string) {
    const order: any = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, activeDeliveryVersionId: true, status: true },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "PUBLISHED")
      throw new NotFoundException("Order is not in PUBLISHED status")
    if (!order.activeDeliveryVersionId)
      throw new NotFoundException("Order has no active delivery version")

    return this.intervention.reverify(
      order.activeDeliveryVersionId,
      userId,
      role,
    )
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
      select: { status: true, activeDeliveryVersionId: true },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "PUBLISHED")
      throw new NotFoundException("Order is not in PUBLISHED status")
    if (!order.activeDeliveryVersionId)
      throw new NotFoundException("Order has no active delivery version")

    const normalizedNotes = notes?.trim() || undefined
    const auditedReason = normalizedNotes
      ? `Manual verification classified as ${reason}. Reviewer notes: ${normalizedNotes}`
      : `Manual verification classified as ${reason}. Authorized staff directly reviewed the delivery evidence.`
    return this.intervention.manualApprove(
      order.activeDeliveryVersionId,
      userId,
      role,
      auditedReason,
      {
        overrideReason: reason as
          | "CRAWLER_BLOCKED"
          | "ROBOTS_TXT"
          | "LOGIN_REQUIRED"
          | "JS_RENDERING"
          | "TEMPORARY_FAILURE"
          | "OTHER",
        notes: normalizedNotes,
      },
    )
  }

  async reject(orderId: string, userId: string, role: string, reason: string) {
    const order: any = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, activeDeliveryVersionId: true },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "PUBLISHED")
      throw new NotFoundException("Order is not in PUBLISHED status")
    if (!order.activeDeliveryVersionId)
      throw new NotFoundException("Order has no active delivery version")
    return this.intervention.manualReject(
      order.activeDeliveryVersionId,
      userId,
      role,
      reason,
    )
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
