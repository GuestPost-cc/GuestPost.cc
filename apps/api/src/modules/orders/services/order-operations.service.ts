import { Injectable, BadRequestException, NotFoundException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"
import { QUEUES } from "@guestpost/shared"

@Injectable()
export class OrderOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

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

  private async assertPlatformOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { website: { select: { ownershipType: true, url: true } } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.website?.ownershipType !== "PLATFORM") {
      throw new BadRequestException("Only platform orders can be fulfilled via operations")
    }
    return order
  }

  async acceptOrder(orderId: string, userId: string) {
    const order = await this.assertPlatformOrder(orderId)
    if (order.status !== "SUBMITTED") throw new BadRequestException("Order must be SUBMITTED to accept")

    const updated = await this.transition(orderId, order.version, "SUBMITTED", {
      status: "ACCEPTED",
      assigneeId: userId,
    })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "ORDER_ACCEPTED",
        actorId: userId,
        message: `Order accepted by operations staff`,
      },
    })

    await this.audit.log({
      action: "ORDER_ACCEPTED",
      entityType: "Order",
      entityId: orderId,
      metadata: { fromStatus: order.status, fulfilledBy: "operations" },
      userId,
      organizationId: order.organizationId,
    })

    return updated
  }

  async submitContent(orderId: string, userId: string, content?: string) {
    const order = await this.assertPlatformOrder(orderId)
    if (order.status !== "ACCEPTED" && order.status !== "CONTENT_REQUESTED") {
      throw new BadRequestException("Order must be ACCEPTED or CONTENT_REQUESTED to submit content")
    }

    const updated = await this.transition(orderId, order.version, order.status, {
      status: "CONTENT_CREATION",
    })

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
        message: `Content submitted by operations`,
        metadata: { hasContent: !!content },
      },
    })

    await this.audit.log({
      action: "CONTENT_SUBMITTED",
      entityType: "Order",
      entityId: orderId,
      metadata: { fromStatus: order.status },
      userId,
      organizationId: order.organizationId,
    })

    return updated
  }

  async markContentReady(orderId: string, userId: string) {
    const order = await this.assertPlatformOrder(orderId)
    if (order.status !== "CONTENT_CREATION") throw new BadRequestException("Order must be in CONTENT_CREATION status")

    const updated = await this.transition(orderId, order.version, "CONTENT_CREATION", {
      status: "CONTENT_READY",
    })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "CONTENT_MARKED_READY",
        actorId: userId,
        message: `Content marked ready by operations`,
      },
    })

    await this.audit.log({
      action: "CONTENT_MARKED_READY",
      entityType: "Order",
      entityId: orderId,
      metadata: { fromStatus: order.status },
      userId,
      organizationId: order.organizationId,
    })

    return updated
  }

  async submitForReview(orderId: string, userId: string) {
    const order = await this.assertPlatformOrder(orderId)
    if (order.status !== "CONTENT_READY") throw new BadRequestException("Order must be CONTENT_READY to submit for review")

    const updated = await this.transition(orderId, order.version, "CONTENT_READY", {
      status: "CUSTOMER_REVIEW",
    })

    await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
      userId: order.customerId,
      organizationId: order.organizationId,
      type: "CONTENT_READY_FOR_REVIEW",
      message: "Your content is ready for review",
    })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "CONTENT_SUBMITTED_FOR_REVIEW",
        actorId: userId,
        message: `Content submitted for review by operations`,
      },
    })

    await this.audit.log({
      action: "CONTENT_SUBMITTED_FOR_REVIEW",
      entityType: "Order",
      entityId: orderId,
      metadata: { fromStatus: order.status },
      userId,
      organizationId: order.organizationId,
    })

    return updated
  }

  async markPublished(orderId: string, userId: string, publishedUrl: string) {
    const order = await this.assertPlatformOrder(orderId)
    if (order.status !== "APPROVED") throw new BadRequestException("Order must be APPROVED to mark published")

    const updated = await this.transition(orderId, order.version, "APPROVED", {
      status: "PUBLISHED",
      publishedUrl,
      publishedAt: new Date(),
    })

    await this.queue.addJob(QUEUES.VERIFICATION, "verify-link", {
      orderId,
      publishedUrl,
      websiteUrl: order.website?.url,
    })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "PUBLICATION_MARKED",
        actorId: userId,
        message: `Publication marked by operations`,
        metadata: { publishedUrl },
      },
    })

    await this.audit.log({
      action: "PUBLICATION_MARKED",
      entityType: "Order",
      entityId: orderId,
      metadata: { fromStatus: order.status, publishedUrl },
      userId,
      organizationId: order.organizationId,
    })

    return updated
  }
}
