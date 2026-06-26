import { orderEventMetadata, QUEUES } from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"
import { OrderDeliveryService } from "./order-delivery.service"

@Injectable()
export class OrderOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly delivery: OrderDeliveryService,
  ) {}

  private async transition(
    orderId: string,
    fromVersion: number,
    expectedStatus: string,
    data: any,
  ) {
    const r = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        version: fromVersion,
        status: expectedStatus as any,
      },
      data: { ...data, version: { increment: 1 } },
    })
    if (r.count === 0) {
      throw new ConflictException(
        "Order was modified by another request. Retry.",
      )
    }
    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  }

  private async assertPlatformOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { website: { select: { ownershipType: true, url: true } } },
    })
    if (!order) throw new NotFoundException("Order not found")
    // Channel-first read. order.fulfillmentChannel is the Phase 2 snapshot
    // and is authoritative — website.ownershipType is the legacy fallback
    // for orders created before the snapshot existed. Once Phase 4 lands
    // and the backfill runs, this fallback is dead code.
    const channel =
      order.fulfillmentChannel ??
      (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
    if (channel !== "PLATFORM") {
      throw new BadRequestException(
        "Only platform orders can be fulfilled via operations",
      )
    }
    return order
  }

  async acceptOrder(orderId: string, userId: string) {
    const order = await this.assertPlatformOrder(orderId)
    if (order.status !== "SUBMITTED")
      throw new BadRequestException("Order must be SUBMITTED to accept")

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
      metadata: {
        ...orderEventMetadata(order),
        fromStatus: order.status,
        fulfilledBy: "operations",
      },
      userId,
      organizationId: order.organizationId,
    })

    return updated
  }

  async submitContent(orderId: string, userId: string, content?: string) {
    const order = await this.assertPlatformOrder(orderId)
    if (order.status !== "ACCEPTED" && order.status !== "CONTENT_REQUESTED") {
      throw new BadRequestException(
        "Order must be ACCEPTED or CONTENT_REQUESTED to submit content",
      )
    }

    const updated = await this.transition(
      orderId,
      order.version,
      order.status,
      {
        status: "CONTENT_CREATION",
      },
    )

    await this.prisma.contentOrder.upsert({
      where: { orderId },
      create: {
        orderId,
        title: order.title ?? "Content",
        brief: content,
        status: "IN_PROGRESS",
      },
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
      metadata: { ...orderEventMetadata(order), fromStatus: order.status },
      userId,
      organizationId: order.organizationId,
    })

    return updated
  }

  async markContentReady(orderId: string, userId: string) {
    const order = await this.assertPlatformOrder(orderId)
    if (order.status !== "CONTENT_CREATION")
      throw new BadRequestException("Order must be in CONTENT_CREATION status")

    const updated = await this.transition(
      orderId,
      order.version,
      "CONTENT_CREATION",
      {
        status: "CONTENT_READY",
      },
    )

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
      metadata: { ...orderEventMetadata(order), fromStatus: order.status },
      userId,
      organizationId: order.organizationId,
    })

    return updated
  }

  async submitForReview(orderId: string, userId: string) {
    const order = await this.assertPlatformOrder(orderId)
    if (order.status !== "CONTENT_READY")
      throw new BadRequestException(
        "Order must be CONTENT_READY to submit for review",
      )

    const updated = await this.transition(
      orderId,
      order.version,
      "CONTENT_READY",
      {
        status: "CUSTOMER_REVIEW",
      },
    )

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
      metadata: { ...orderEventMetadata(order), fromStatus: order.status },
      userId,
      organizationId: order.organizationId,
    })

    return updated
  }

  // Operations submits a platform delivery. Requires an active fulfillment
  // assignment to this user (no unassigned drive-by deliveries). Same immutable
  // version + verification path as publisher inventory.
  async markPublished(
    orderId: string,
    userId: string,
    publishedUrl: string,
    extra: {
      articleTitle?: string
      notes?: string
      screenshotUrl?: string
    } = {},
  ) {
    const order = await this.assertPlatformOrder(orderId)
    if (order.status !== "APPROVED")
      throw new BadRequestException("Order must be APPROVED to mark published")

    const assignment = await this.prisma.fulfillmentAssignment.findFirst({
      where: {
        orderId,
        assignedToUserId: userId,
        status: { in: ["ASSIGNED", "IN_PROGRESS"] },
      },
    })
    if (!assignment) {
      throw new BadRequestException(
        "You must be assigned this order before submitting a delivery",
      )
    }

    const version = await this.delivery.submitDelivery(order, userId, {
      publishedUrl,
      ...extra,
    })

    // Mark the assignment delivered (version-guarded)
    const delivered = await this.prisma.fulfillmentAssignment.updateMany({
      where: { id: assignment.id, version: assignment.version },
      data: {
        status: "DELIVERED",
        completedAt: new Date(),
        version: { increment: 1 },
      },
    })
    if (delivered.count === 0) {
      throw new ConflictException(
        "Assignment was modified by another request. Retry.",
      )
    }

    void version
    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  }
}
