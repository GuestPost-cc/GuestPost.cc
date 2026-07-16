import { orderEventMetadata, QUEUES } from "@guestpost/shared"
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
import { OrderCancellationService } from "./order-cancellation.service"
import { OrderDeliveryService } from "./order-delivery.service"

@Injectable()
export class OrderOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly delivery: OrderDeliveryService,
    private readonly cancellation: OrderCancellationService,
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

  private async assertAssignedOperator(
    orderId: string,
    userId: string,
    staffRole: string,
  ) {
    const assignment = await this.prisma.fulfillmentAssignment.findFirst({
      where: {
        orderId,
        status: { in: ["ASSIGNED", "IN_PROGRESS"] },
        ...(staffRole === "SUPER_ADMIN" ? {} : { assignedToUserId: userId }),
      },
    })
    if (!assignment && staffRole !== "SUPER_ADMIN") {
      throw new ForbiddenException(
        "Only the assigned Operations user can progress this order",
      )
    }
    return assignment
  }

  private async guardAssignment(
    tx: any,
    assignment: any,
    userId: string,
    staffRole: string,
    status?: "ASSIGNED" | "IN_PROGRESS",
  ) {
    if (!assignment) return
    const guarded = await tx.fulfillmentAssignment.updateMany({
      where: {
        id: assignment.id,
        version: assignment.version,
        status: { in: ["ASSIGNED", "IN_PROGRESS"] },
        ...(staffRole === "SUPER_ADMIN" ? {} : { assignedToUserId: userId }),
      },
      data: {
        ...(status ? { status } : {}),
        version: { increment: 1 },
      },
    })
    if (guarded.count === 0) {
      throw new ConflictException(
        "Order assignment changed. Refresh before continuing.",
      )
    }
  }

  async acceptOrder(orderId: string, userId: string, staffRole: string) {
    const order = await this.assertPlatformOrder(orderId)
    const assignment = await this.assertAssignedOperator(
      orderId,
      userId,
      staffRole,
    )
    if (order.status !== "SUBMITTED")
      throw new BadRequestException("Order must be SUBMITTED to accept")
    await this.cancellation.assertNoActiveCancellation(orderId)

    const acceptedAt = new Date()
    const fulfillmentDueAt = order.turnaroundDays
      ? new Date(acceptedAt.getTime() + order.turnaroundDays * 86_400_000)
      : null

    return this.prisma.$transaction(async (tx: any) => {
      const changed = await tx.order.updateMany({
        where: { id: orderId, version: order.version, status: "SUBMITTED" },
        data: {
          status: "ACCEPTED",
          assigneeId: userId,
          acceptedAt,
          fulfillmentDueAt,
          version: { increment: 1 },
        },
      })
      if (changed.count === 0) {
        throw new ConflictException(
          "Order was modified by another request. Retry.",
        )
      }
      await this.guardAssignment(
        tx,
        assignment,
        userId,
        staffRole,
        "IN_PROGRESS",
      )
      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ORDER_ACCEPTED",
          actorId: userId,
          message: `Order accepted by operations staff`,
        },
      })
      await this.audit.log(
        {
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
        },
        tx,
      )
      return tx.order.findUniqueOrThrow({ where: { id: orderId } })
    })
  }

  async submitContent(
    orderId: string,
    userId: string,
    staffRole: string,
    content?: string,
  ) {
    const order = await this.assertPlatformOrder(orderId)
    const assignment = await this.assertAssignedOperator(
      orderId,
      userId,
      staffRole,
    )
    if (
      order.status !== "ACCEPTED" &&
      order.status !== "CONTENT_REQUESTED" &&
      order.status !== "CONTENT_CREATION"
    ) {
      throw new BadRequestException("Order must be ready for content creation")
    }
    await this.cancellation.assertNoActiveCancellation(orderId)

    return this.prisma.$transaction(async (tx: any) => {
      const changed = await tx.order.updateMany({
        where: { id: orderId, version: order.version, status: order.status },
        data: { status: "CONTENT_CREATION", version: { increment: 1 } },
      })
      if (changed.count === 0) {
        throw new ConflictException(
          "Order was modified by another request. Retry.",
        )
      }
      await this.guardAssignment(
        tx,
        assignment,
        userId,
        staffRole,
        "IN_PROGRESS",
      )
      await tx.contentOrder.upsert({
        where: { orderId },
        create: {
          orderId,
          title: order.title ?? "Content",
          brief: content,
          status: "IN_PROGRESS",
        },
        update: { brief: content, status: "IN_PROGRESS" },
      })
      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "CONTENT_SUBMITTED",
          actorId: userId,
          message: `Content draft saved by operations`,
          metadata: { hasContent: !!content },
        },
      })
      await this.audit.log(
        {
          action: "CONTENT_SUBMITTED",
          entityType: "Order",
          entityId: orderId,
          metadata: { ...orderEventMetadata(order), fromStatus: order.status },
          userId,
          organizationId: order.organizationId,
        },
        tx,
      )
      return tx.order.findUniqueOrThrow({ where: { id: orderId } })
    })
  }

  async submitContentForReview(
    orderId: string,
    userId: string,
    staffRole: string,
    content: string,
  ) {
    const order = await this.assertPlatformOrder(orderId)
    const assignment = await this.assertAssignedOperator(
      orderId,
      userId,
      staffRole,
    )
    if (
      ![
        "ACCEPTED",
        "CONTENT_REQUESTED",
        "CONTENT_CREATION",
        "CONTENT_READY",
      ].includes(order.status)
    ) {
      throw new BadRequestException(
        "Order must be in the content workflow to submit for review",
      )
    }
    await this.cancellation.assertNoActiveCancellation(orderId)

    const updated = await this.prisma.$transaction(async (tx: any) => {
      const changed = await tx.order.updateMany({
        where: { id: orderId, version: order.version, status: order.status },
        data: { status: "CUSTOMER_REVIEW", version: { increment: 1 } },
      })
      if (changed.count === 0) {
        throw new ConflictException(
          "Order was modified by another request. Retry.",
        )
      }
      await this.guardAssignment(
        tx,
        assignment,
        userId,
        staffRole,
        "IN_PROGRESS",
      )
      await tx.contentOrder.upsert({
        where: { orderId },
        create: {
          orderId,
          title: order.title ?? "Content",
          brief: content,
          status: "IN_PROGRESS",
        },
        update: { brief: content, status: "IN_PROGRESS" },
      })
      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "CONTENT_SUBMITTED_FOR_REVIEW",
          actorId: userId,
          message: `Content submitted for review by operations`,
          metadata: { hasContent: true, fromStatus: order.status },
        },
      })
      await this.audit.log(
        {
          action: "CONTENT_SUBMITTED_FOR_REVIEW",
          entityType: "Order",
          entityId: orderId,
          metadata: { ...orderEventMetadata(order), fromStatus: order.status },
          userId,
          organizationId: order.organizationId,
        },
        tx,
      )
      return tx.order.findUniqueOrThrow({ where: { id: orderId } })
    })

    await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
      userId: order.customerId,
      organizationId: order.organizationId,
      type: "CONTENT_READY_FOR_REVIEW",
      message: "Your content is ready for review",
    })
    return updated
  }

  async markContentReady(orderId: string, userId: string, staffRole: string) {
    const order = await this.assertPlatformOrder(orderId)
    await this.assertAssignedOperator(orderId, userId, staffRole)
    if (order.status !== "CONTENT_CREATION")
      throw new BadRequestException("Order must be in CONTENT_CREATION status")
    await this.cancellation.assertNoActiveCancellation(orderId)

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

  async submitForReview(orderId: string, userId: string, staffRole: string) {
    const order = await this.assertPlatformOrder(orderId)
    await this.assertAssignedOperator(orderId, userId, staffRole)
    if (order.status !== "CONTENT_READY")
      throw new BadRequestException(
        "Order must be CONTENT_READY to submit for review",
      )
    await this.cancellation.assertNoActiveCancellation(orderId)

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
    staffRole: string,
    publishedUrl: string,
    extra: {
      articleTitle?: string
      notes?: string
      screenshotUrl?: string
    } = {},
  ) {
    const order = await this.assertPlatformOrder(orderId)
    const assignment = await this.assertAssignedOperator(
      orderId,
      userId,
      staffRole,
    )
    if (order.status !== "APPROVED")
      throw new BadRequestException("Order must be APPROVED to mark published")
    await this.cancellation.assertNoActiveCancellation(orderId)

    const version = await this.delivery.submitDelivery(
      order,
      userId,
      {
        publishedUrl,
        ...extra,
      },
      assignment
        ? async (tx: any) => {
            const delivered = await tx.fulfillmentAssignment.updateMany({
              where: {
                id: assignment.id,
                assignedToUserId: assignment.assignedToUserId,
                status: { in: ["ASSIGNED", "IN_PROGRESS"] },
                version: assignment.version,
              },
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
          }
        : undefined,
    )

    void version
    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  }
}
