import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"
import { QUEUES, orderEventMetadata } from "@guestpost/shared"
import { OrderDeliveryService } from "./order-delivery.service"

@Injectable()
export class OrderFulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly delivery: OrderDeliveryService,
  ) {}

  // Optimistic-lock status transition: the row only changes if its version
  // AND current status still match what the caller read, preventing lost
  // updates / concurrent state corruption. Returns the fresh row.
  private async transition(orderId: string, fromVersion: number, expectedStatus: string, data: any) {
    const r = await this.prisma.order.updateMany({
      where: { id: orderId, version: fromVersion, status: expectedStatus as any },
      data: { ...data, version: { increment: 1 } },
    })
    if (r.count === 0) {
      throw new ConflictException("Order was modified by another request. Retry.")
    }
    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  }

  async acceptOrder(orderId: string, publisherId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, website: { publisherId } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "SUBMITTED") throw new BadRequestException("Order must be SUBMITTED to accept")

    const updated = await this.transition(orderId, order.version, "SUBMITTED", { status: "ACCEPTED", assigneeId: userId })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "ORDER_ACCEPTED",
        actorId: userId,
        message: `Publisher accepted order`,
      },
    })

    await this.audit.log({
      action: "ORDER_ACCEPTED",
      entityType: "Order",
      entityId: orderId,
      // Phase 6.9 — uniform Order-scoped audit metadata.
      metadata: { ...orderEventMetadata(order), publisherId },
      userId,
      organizationId: order.organizationId,
    })

    return updated
  }

  async submitContent(orderId: string, publisherId: string, userId: string, content?: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, website: { publisherId } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "ACCEPTED" && order.status !== "CONTENT_REQUESTED") {
      throw new BadRequestException("Order must be ACCEPTED or CONTENT_REQUESTED to submit content")
    }

    const updated = await this.transition(orderId, order.version, order.status, { status: "CONTENT_CREATION" })

    // Upsert content order
    await this.prisma.contentOrder.upsert({
      where: { orderId },
      create: { orderId, title: order.title ?? "Content", brief: content, status: "IN_PROGRESS" },
      update: { brief: content, status: "IN_PROGRESS" },
    })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "CONTENT_SUBMITTED",
        actorId: userId,
        message: `Content submitted by publisher`,
        metadata: { hasContent: !!content },
      },
    })

    return updated
  }

  async markContentReady(orderId: string, publisherId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, website: { publisherId } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "CONTENT_CREATION") {
      throw new BadRequestException("Order must be in CONTENT_CREATION to mark content ready")
    }

    const updated = await this.transition(orderId, order.version, "CONTENT_CREATION", { status: "CONTENT_READY" })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "CONTENT_MARKED_READY",
        actorId: userId,
        message: `Content marked ready for review`,
      },
    })

    return updated
  }

  async submitForReview(orderId: string, publisherId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, website: { publisherId } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "CONTENT_READY") {
      throw new BadRequestException("Content must be ready before submitting for review")
    }

    const updated = await this.transition(orderId, order.version, "CONTENT_READY", { status: "CUSTOMER_REVIEW" })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "CONTENT_SUBMITTED_FOR_REVIEW",
        actorId: userId,
        message: `Content submitted for customer review`,
      },
    })

    await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
      userId: order.customerId,
      organizationId: order.organizationId,
      type: "CONTENT_READY_FOR_REVIEW",
      message: `Content for order ${orderId} is ready for your review`,
    })

    return updated
  }

  // Publisher submits a delivery. Creates an immutable OrderDeliveryVersion and
  // enqueues independent verification (same path as platform Operations).
  async markPublished(
    orderId: string,
    publisherId: string,
    userId: string,
    publishedUrl: string,
    extra: { articleTitle?: string; notes?: string; screenshotUrl?: string } = {},
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, website: { publisherId } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "APPROVED") throw new BadRequestException("Content must be APPROVED before publishing")

    await this.delivery.submitDelivery(order, userId, { publishedUrl, ...extra })
    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  }
}
