import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { RefundService } from "./refund.service"

@Injectable()
export class OrderDisputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly refund: RefundService,
  ) {}

  async openDispute(orderId: string, organizationId: string, userId: string, reason: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
    })
    if (!order) throw new NotFoundException("Order not found")

    const disputableStatuses = ["PUBLISHED", "VERIFIED", "DELIVERED", "CANCELLED"]
    if (!disputableStatuses.includes(order.status) && order.paymentStatus !== "PAID") {
      throw new BadRequestException("Order cannot be disputed in its current state")
    }

    const existingDispute = await this.prisma.orderDispute.findFirst({ where: { orderId } })
    if (existingDispute && existingDispute.status !== "RESOLVED_REJECTED" && existingDispute.status !== "RESOLVED_RESTORED") {
      throw new BadRequestException("An active dispute already exists for this order")
    }

    const dispute = await this.prisma.orderDispute.create({
      data: {
        orderId,
        raisedBy: userId,
        reason,
        status: "OPEN",
      },
    })

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: "DISPUTED" },
    })

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
      metadata: { disputeId: dispute.id, reason },
      userId,
      organizationId,
    })

    return dispute
  }

  async resolveDispute(disputeId: string, userId: string, staffRole: string, resolution: string, action: "RESTORE" | "REFUND" | "REJECT") {
    const dispute = await this.prisma.orderDispute.findUnique({
      where: { id: disputeId },
      include: { order: true },
    })
    if (!dispute) throw new NotFoundException("Dispute not found")
    if (dispute.status !== "OPEN" && dispute.status !== "UNDER_REVIEW") {
      throw new BadRequestException("Dispute is not resolvable in current state")
    }

    const order = dispute.order

    if (action === "RESTORE") {
      // Restore to previous status before dispute
      const previousStatus = order.status === "DISPUTED" ? "PUBLISHED" : order.status

      await this.prisma.orderDispute.update({
        where: { id: disputeId },
        data: {
          status: "RESOLVED_RESTORED",
          resolvedBy: userId,
          resolvedAt: new Date(),
          resolution,
        },
      })

      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: previousStatus as any },
      })
    } else if (action === "REFUND") {
      // Refund first — if it fails, the dispute stays open instead of being
      // marked resolved with the customer never refunded
      await this.refund.refundOrder(order.id, `Dispute resolved with refund: ${resolution}`, userId)

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
      const previousStatus = order.status === "DISPUTED" ? "PUBLISHED" : order.status
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: previousStatus as any },
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
      action: "DISPUTE_" + action,
      entityType: "Dispute",
      entityId: disputeId,
      metadata: { orderId: order.id, resolution },
      userId,
      organizationId: order.organizationId,
    })

    return this.prisma.orderDispute.findUnique({ where: { id: disputeId } })
  }
}
