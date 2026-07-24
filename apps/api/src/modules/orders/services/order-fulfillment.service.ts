import { createHash } from "node:crypto"
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
import { OrderCancellationService } from "./order-cancellation.service"
import { OrderDeliveryService } from "./order-delivery.service"

@Injectable()
export class OrderFulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly delivery: OrderDeliveryService,
    private readonly cancellation: OrderCancellationService,
  ) {}

  private async createFinalArticleVersion(
    tx: any,
    orderId: string,
    userId: string,
    content?: string,
  ) {
    const body = content?.trim()
    if (!body) return null
    if (body.length > 200_000) {
      throw new BadRequestException(
        "Content must be 200,000 characters or fewer",
      )
    }
    const checksum = createHash("sha256").update(body, "utf8").digest("hex")
    const latest = await tx.orderArticleVersion.findFirst({
      where: {
        orderId,
        source: "PUBLISHER",
        purpose: "FINAL_SUBMISSION",
      },
      orderBy: { version: "desc" },
      select: { id: true, version: true, checksum: true },
    })
    if (latest?.checksum === checksum) return latest
    return tx.orderArticleVersion.create({
      data: {
        orderId,
        version: (latest?.version ?? 0) + 1,
        source: "PUBLISHER",
        purpose: "FINAL_SUBMISSION",
        body,
        format: "MARKDOWN",
        checksum,
        wordCount: body.split(/\s+/).filter(Boolean).length,
        createdByUserId: userId,
        supersedesId: latest?.id ?? null,
      },
    })
  }

  // Optimistic-lock status transition: the row only changes if its version
  // AND current status still match what the caller read, preventing lost
  // updates / concurrent state corruption. Returns the fresh row.
  private async transition(
    orderId: string,
    fromVersion: number,
    expectedStatus: string,
    data: any,
    prisma: any = this.prisma,
  ) {
    const r = await prisma.order.updateMany({
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
    return prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  }

  async acceptOrder(orderId: string, publisherId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, website: { publisherId } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "SUBMITTED")
      throw new BadRequestException("Order must be SUBMITTED to accept")
    await this.cancellation.assertNoActiveCancellation(orderId)

    const acceptedAt = new Date()
    const fulfillmentDueAt = order.turnaroundDays
      ? new Date(acceptedAt.getTime() + order.turnaroundDays * 86_400_000)
      : null

    return this.prisma.$transaction(async (tx: any) => {
      const updated = await this.transition(
        orderId,
        order.version,
        "SUBMITTED",
        {
          status: "ACCEPTED",
          assigneeId: userId,
          acceptedAt,
          fulfillmentDueAt,
        },
        tx,
      )
      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ORDER_ACCEPTED",
          actorId: userId,
          message: "Publisher accepted order",
        },
      })
      await this.audit.log(
        {
          action: "ORDER_ACCEPTED",
          entityType: "Order",
          entityId: orderId,
          metadata: { ...orderEventMetadata(order), publisherId },
          userId,
          organizationId: order.organizationId,
        },
        tx,
      )
      return updated
    })
  }

  async submitContent(
    orderId: string,
    publisherId: string,
    userId: string,
    content?: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, website: { publisherId } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "ACCEPTED" && order.status !== "CONTENT_REQUESTED") {
      throw new BadRequestException(
        "Order must be ACCEPTED or CONTENT_REQUESTED to submit content",
      )
    }
    await this.cancellation.assertNoActiveCancellation(orderId)

    return this.prisma.$transaction(async (tx: any) => {
      const updated = await this.transition(
        orderId,
        order.version,
        order.status,
        { status: "CONTENT_CREATION" },
        tx,
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
      const articleVersion = await this.createFinalArticleVersion(
        tx,
        orderId,
        userId,
        content,
      )
      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "CONTENT_SUBMITTED",
          actorId: userId,
          message: "Content submitted by publisher",
          metadata: {
            hasContent: !!content,
            articleVersionId: articleVersion?.id,
            version: articleVersion?.version,
          },
        },
      })
      return updated
    })
  }

  async markContentReady(orderId: string, publisherId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, website: { publisherId } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "CONTENT_CREATION") {
      throw new BadRequestException(
        "Order must be in CONTENT_CREATION to mark content ready",
      )
    }
    await this.cancellation.assertNoActiveCancellation(orderId)

    return this.prisma.$transaction(async (tx: any) => {
      const updated = await this.transition(
        orderId,
        order.version,
        "CONTENT_CREATION",
        { status: "CONTENT_READY" },
        tx,
      )
      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "CONTENT_MARKED_READY",
          actorId: userId,
          message: "Content marked ready for review",
        },
      })
      return updated
    })
  }

  async submitForReview(orderId: string, publisherId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, website: { publisherId } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "CONTENT_READY") {
      throw new BadRequestException(
        "Content must be ready before submitting for review",
      )
    }
    await this.cancellation.assertNoActiveCancellation(orderId)

    const updated = await this.prisma.$transaction(async (tx: any) => {
      const fresh = await this.transition(
        orderId,
        order.version,
        "CONTENT_READY",
        { status: "CUSTOMER_REVIEW" },
        tx,
      )
      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "CONTENT_SUBMITTED_FOR_REVIEW",
          actorId: userId,
          message: "Content submitted for customer review",
        },
      })
      return fresh
    })

    await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
      userId: order.customerId,
      organizationId: order.organizationId,
      type: "CONTENT_READY_FOR_REVIEW",
      message: `Content for order ${orderId} is ready for your review`,
    })

    return updated
  }

  async submitContentForReview(
    orderId: string,
    publisherId: string,
    userId: string,
    content: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, website: { publisherId } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (
      !["ACCEPTED", "CONTENT_REQUESTED", "CONTENT_CREATION"].includes(
        order.status,
      )
    ) {
      throw new BadRequestException(
        "Order must be accepted or in content creation to submit for review",
      )
    }
    await this.cancellation.assertNoActiveCancellation(orderId)

    const updated = await this.prisma.$transaction(async (tx: any) => {
      const fresh = await this.transition(
        orderId,
        order.version,
        order.status,
        { status: "CUSTOMER_REVIEW" },
        tx,
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
      const articleVersion = await this.createFinalArticleVersion(
        tx,
        orderId,
        userId,
        content,
      )
      await tx.orderEvent.createMany({
        data: [
          {
            orderId,
            eventType: "CONTENT_SUBMITTED",
            actorId: userId,
            message: "Content submitted by publisher",
            metadata: {
              hasContent: true,
              articleVersionId: articleVersion?.id,
              version: articleVersion?.version,
            },
          },
          {
            orderId,
            eventType: "CONTENT_MARKED_READY",
            actorId: userId,
            message: "Content marked ready for review",
          },
          {
            orderId,
            eventType: "CONTENT_SUBMITTED_FOR_REVIEW",
            actorId: userId,
            message: "Content submitted for customer review",
          },
        ],
      })
      await this.audit.log(
        {
          action: "CONTENT_SUBMITTED_FOR_REVIEW",
          entityType: "Order",
          entityId: orderId,
          metadata: { ...orderEventMetadata(order), publisherId },
          userId,
          organizationId: order.organizationId,
        },
        tx,
      )
      return fresh
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
    extra: {
      articleTitle?: string
      notes?: string
      screenshotUrl?: string
    } = {},
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, website: { publisherId } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "APPROVED")
      throw new BadRequestException(
        "Content must be APPROVED before publishing",
      )
    await this.cancellation.assertNoActiveCancellation(orderId)

    await this.delivery.submitDelivery(order, userId, {
      publishedUrl,
      ...extra,
    })
    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  }
}
