import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { BillingService } from "../billing/billing.service"
import { QueueService } from "../queues/queue.service"
import { QUEUES } from "@guestpost/shared"

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["PENDING_PAYMENT", "SUBMITTED", "CANCELLED"],
  PENDING_PAYMENT: ["PAID", "SUBMITTED", "CANCELLED"],
  PAID: ["SUBMITTED", "ASSIGNED", "CANCELLED", "REFUNDED"],
  SUBMITTED: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["CONTENT_REQUESTED", "ASSIGNED", "CANCELLED"],
  CONTENT_REQUESTED: ["CONTENT_CREATION", "CONTENT_READY", "CANCELLED"],
  CONTENT_CREATION: ["CONTENT_READY", "OUTREACH", "CANCELLED"],
  CONTENT_READY: ["REVIEW", "PUBLISHED", "CANCELLED"],
  REVIEW: ["CONTENT_REQUESTED", "PUBLISHED", "CANCELLED"],
  ASSIGNED: ["CONTENT_CREATION", "CANCELLED"],
  OUTREACH: ["PUBLISHED", "CANCELLED", "REJECTED"],
  PUBLISHED: ["VERIFIED", "REVIEW", "CANCELLED"],
  VERIFIED: ["DELIVERED", "UNDER_REVIEW", "CANCELLED"],
  DELIVERED: ["COMPLETED", "SETTLED"],
  UNDER_REVIEW: ["SETTLED", "CANCELLED", "DISPUTED"],
  SETTLED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
  REFUNDED: [],
  REJECTED: [],
  DISPUTED: ["UNDER_REVIEW", "REFUNDED"],
}

const STATUS_EVENT_MAP: Record<string, string> = {
  PENDING_PAYMENT: "ORDER_CREATED",
  PAID: "PAYMENT_RECEIVED",
  SUBMITTED: "ORDER_CREATED",
  ACCEPTED: "ASSIGNED",
  CONTENT_REQUESTED: "CONTENT_SUBMITTED",
  CONTENT_READY: "CONTENT_APPROVED",
  REVIEW: "UNDER_REVIEW",
  ASSIGNED: "ASSIGNED",
  CONTENT_CREATION: "CONTENT_SUBMITTED",
  OUTREACH: "CONTENT_APPROVED",
  PUBLISHED: "PUBLISHED",
  VERIFIED: "VERIFIED",
  DELIVERED: "COMPLETED",
  UNDER_REVIEW: "UNDER_REVIEW",
  SETTLED: "SETTLED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  REFUNDED: "REFUNDED",
  REJECTED: "REJECTED",
  DISPUTED: "DISPUTED",
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
    private readonly queue: QueueService,
  ) {}

  async createOrder(data: {
    type: string
    title?: string
    instructions?: string
    customerId: string
    organizationId: string
    campaignId?: string
    items?: Array<{ websiteId?: string; targetUrl?: string; anchorText?: string; price?: number }>
  }, userId: string) {
    return this.prisma.$transaction(async (tx: any) => {
      const order = await tx.order.create({
        data: {
          type: data.type,
          title: data.title,
          instructions: data.instructions,
          customerId: data.customerId,
          organizationId: data.organizationId,
          campaignId: data.campaignId,
          status: "DRAFT",
          paymentStatus: "PENDING",
          amount: 0,
        },
      })

      if (data.items && data.items.length > 0) {
        for (const item of data.items) {
          await tx.orderItem.create({
            data: {
              orderId: order.id,
              websiteId: item.websiteId,
              targetUrl: item.targetUrl,
              anchorText: item.anchorText,
              price: item.price ?? 0,
              status: "PENDING_PAYMENT",
            },
          })
        }
        const total = data.items.reduce((sum, i) => sum + (i.price ?? 0), 0)
        await tx.order.update({ where: { id: order.id }, data: { amount: total } })
      }

      return order
    })
  }

  async transitionOrder(id: string, organizationId: string, newStatus: string, userId: string, metadata?: Record<string, unknown>) {
    const result = await this.prisma.$transaction(async (tx: any) => {
      const order = await tx.order.findFirst({ where: { id, organizationId } })
      if (!order) throw new NotFoundException(`Order ${id} not found`)

      const allowed = ALLOWED_TRANSITIONS[order.status] ?? []
      if (!allowed.includes(newStatus)) {
        throw new BadRequestException(
          `Cannot transition order from ${order.status} to ${newStatus}. Allowed: ${allowed.join(", ") || "none"}`,
        )
      }

      if (newStatus === "PAID" && order.paymentStatus === "PENDING") {
        const wallet = await tx.wallet.findFirst({
          where: { organizationId, OR: [{ organizationId }, { userId }] },
        })
        if (!wallet) throw new BadRequestException("No wallet found for payment")

        const amount = order.amount ? Number(order.amount) : 0
        await this.billing.payFromReserved(wallet.id, amount, id, { id: userId, organizationId })

        await tx.order.update({ where: { id }, data: { paymentStatus: "PAID" } })
      }

      const updated = await tx.order.update({ where: { id }, data: { status: newStatus } })
      const eventType = STATUS_EVENT_MAP[newStatus] ?? "ORDER_CREATED"

      await tx.orderEvent.create({
        data: {
          orderId: id,
          eventType,
          actorId: userId,
          message: `Order transitioned from ${order.status} to ${newStatus}`,
          metadata: { ...metadata, from: order.status, to: newStatus },
        },
      })

      return updated
    })

    if (["ACCEPTED", "PUBLISHED", "COMPLETED"].includes(newStatus)) {
      await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
        userId: result.customerId,
        organizationId: result.organizationId,
        type: `ORDER_${newStatus}`,
        message: `Order ${result.id} is now ${newStatus}`,
      })
      await this.queue.addJob(QUEUES.EMAIL, "send-notification", {
        to: "customer@example.com", 
        subject: `Order Update: ${newStatus}`,
        body: `Your order ${result.id} has transitioned to ${newStatus}.`,
      })
    }

    return result
  }

  async getOrder(id: string, organizationId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, organizationId },
      include: {
        items: { include: { publications: true } },
        events: { orderBy: { createdAt: "desc" } },
        contentOrder: true,
        revisions: true,
        reports: true,
        website: true,
        settlements: true,
      },
    })
    if (!order) throw new NotFoundException(`Order ${id} not found`)
    return order
  }

  async listOrders(organizationId: string, campaignId?: string) {
    const where: any = { organizationId }
    if (campaignId) where.campaignId = campaignId
    return this.prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        items: true,
        website: true,
        campaign: true,
        settlements: true,
      },
    })
  }

  async listPublisherOrders(publisherId: string) {
    return this.prisma.order.findMany({
      where: { website: { publisherId } },
      orderBy: { createdAt: "desc" },
      include: { items: true, website: true, campaign: true, settlements: true },
    })
  }

  async addOrderItem(orderId: string, organizationId: string, data: {
    websiteId?: string
    targetUrl?: string
    anchorText?: string
    price?: number
  }, userId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId } })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "DRAFT" && order.status !== "PENDING_PAYMENT") {
      throw new BadRequestException("Can only add items to draft or pending payment orders")
    }

    const item = await this.prisma.orderItem.create({
      data: {
        orderId,
        websiteId: data.websiteId,
        targetUrl: data.targetUrl,
        anchorText: data.anchorText,
        price: data.price ?? 0,
        status: "PENDING_PAYMENT",
      },
    })

    const total = await this.prisma.orderItem.aggregate({ where: { orderId }, _sum: { price: true } })
    await this.prisma.order.update({ where: { id: orderId }, data: { amount: total._sum.price ?? 0 } })

    return item
  }

  async submitPayment(orderId: string, organizationId: string, userId: string) {
    return this.prisma.$transaction(async (tx: any) => {
      const order = await tx.order.findFirst({ where: { id: orderId, organizationId } })
      if (!order) throw new NotFoundException("Order not found")
      if (order.status !== "DRAFT") throw new BadRequestException("Order is not in draft status")

      const wallet = await tx.wallet.findFirst({
        where: { organizationId, OR: [{ organizationId }, { userId }] },
      })
      if (!wallet) throw new BadRequestException("No wallet found")

      const amount = order.amount ? Number(order.amount) : 0
      await this.billing.reserve(wallet.id, amount, orderId, { id: userId, organizationId })

      const updated = await tx.order.update({ where: { id: orderId }, data: { status: "PENDING_PAYMENT" } })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ORDER_CREATED",
          actorId: userId,
          message: `Funds reserved for payment — awaiting processing`,
          metadata: { reservedAmount: amount },
        },
      })

      return updated
    })
  }
}
