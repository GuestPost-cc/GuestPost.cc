import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { QueueService } from "../queues/queue.service"
import { QUEUES } from "@guestpost/shared"

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async createOrder(data: {
    type: string
    title?: string
    instructions?: string
    customerId: string
    organizationId: string
    campaignId?: string
    idempotencyKey?: string
    targetUrl?: string
    anchorText?: string
    items?: Array<{ websiteId?: string; targetUrl?: string; anchorText?: string }>
  }, userId: string) {
    return this.prisma.$transaction(async (tx: any) => {
      if (data.idempotencyKey) {
        const existing = await tx.order.findUnique({
          where: { idempotencyKey: data.idempotencyKey },
        })
        if (existing) return existing
      }

      // Order-level website link is required for publisher fulfillment
      // (acceptOrder matches on order.website.publisherId)
      const firstItem = data.items?.find((i) => i.websiteId)
      const order = await tx.order.create({
        data: {
          type: data.type,
          title: data.title,
          instructions: data.instructions,
          customerId: data.customerId,
          organizationId: data.organizationId,
          campaignId: data.campaignId,
          idempotencyKey: data.idempotencyKey ?? null,
          websiteId: firstItem?.websiteId ?? null,
          targetUrl: data.targetUrl ?? firstItem?.targetUrl ?? null,
          anchorText: data.anchorText ?? firstItem?.anchorText ?? null,
          status: "DRAFT",
          paymentStatus: "PENDING",
          amount: 0,
        },
      })

      if (data.items && data.items.length > 0) {
        let total = 0
        for (const item of data.items) {
          let price: number
          if (item.websiteId) {
            const listing = await this.prisma.marketplaceListing.findFirst({
              where: { websiteId: item.websiteId, status: "APPROVED" },
              select: { price: true },
            })
            if (!listing) throw new BadRequestException(`No approved marketplace listing found for website ${item.websiteId}`)
            price = Number(listing.price)
          } else {
            const service = await this.prisma.service.findFirst({
              where: { type: data.type as any, isActive: true },
              select: { price: true },
            })
            if (!service) throw new BadRequestException(`No active service found for type ${data.type}`)
            price = Number(service.price)
          }

          await tx.orderItem.create({
            data: {
              orderId: order.id,
              websiteId: item.websiteId,
              targetUrl: item.targetUrl,
              anchorText: item.anchorText,
              price,
              status: "PENDING_PAYMENT",
            },
          })
          total += price
        }
        await tx.order.update({ where: { id: order.id }, data: { amount: total } })
      }

      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          eventType: "ORDER_CREATED",
          actorId: userId,
          message: `Order created as DRAFT`,
          metadata: { type: data.type },
        },
      })

      return order
    })
  }

  async addOrderItem(orderId: string, organizationId: string, data: {
    websiteId?: string
    targetUrl?: string
    anchorText?: string
  }, userId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId } })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "DRAFT") {
      throw new BadRequestException("Can only add items to draft orders")
    }

    let price: number
    if (data.websiteId) {
      const listing = await this.prisma.marketplaceListing.findFirst({
        where: { websiteId: data.websiteId, status: "APPROVED" },
        select: { price: true },
      })
      if (!listing) throw new BadRequestException(`No approved marketplace listing found for website ${data.websiteId}`)
      price = Number(listing.price)
    } else {
      const service = await this.prisma.service.findFirst({
        where: { type: order.type as any, isActive: true },
        select: { price: true },
      })
      if (!service) throw new BadRequestException(`No active service found for type ${order.type}`)
      price = Number(service.price)
    }

    const item = await this.prisma.orderItem.create({
      data: {
        orderId,
        websiteId: data.websiteId,
        targetUrl: data.targetUrl,
        anchorText: data.anchorText,
        price,
        status: "PENDING_PAYMENT",
      },
    })

    const total = await this.prisma.orderItem.aggregate({ where: { orderId }, _sum: { price: true } })
    await this.prisma.order.update({ where: { id: orderId }, data: { amount: total._sum.price ?? 0 } })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "ITEM_ADDED",
        actorId: userId,
        message: `Item added to order`,
        metadata: { itemId: item.id, websiteId: data.websiteId, price },
      },
    })

    return item
  }

  async removeOrderItem(orderId: string, itemId: string, organizationId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId } })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "DRAFT") throw new BadRequestException("Can only remove items from draft orders")

    const item = await this.prisma.orderItem.findFirst({ where: { id: itemId, orderId } })
    if (!item) throw new NotFoundException("Item not found")

    await this.prisma.orderItem.delete({ where: { id: itemId } })

    const total = await this.prisma.orderItem.aggregate({ where: { orderId }, _sum: { price: true } })
    await this.prisma.order.update({ where: { id: orderId }, data: { amount: total._sum.price ?? 0 } })

    return { success: true }
  }

  async cancelOrder(orderId: string, organizationId: string, userId: string) {
    return this.prisma.$transaction(async (tx: any) => {
      const order = await tx.order.findFirst({ where: { id: orderId, organizationId } })
      if (!order) throw new NotFoundException("Order not found")

      const cancellableStatuses = ["DRAFT", "PENDING_PAYMENT", "SUBMITTED", "ACCEPTED", "CONTENT_REQUESTED", "CONTENT_CREATION", "CONTENT_READY", "CUSTOMER_REVIEW", "APPROVED", "PUBLISHED", "VERIFIED"]
      if (!cancellableStatuses.includes(order.status)) {
        throw new BadRequestException(`Order cannot be cancelled in ${order.status} status`)
      }

      const amount = order.amount ? Number(order.amount) : 0

      // Release reserved funds if any
      if (order.paymentStatus === "PENDING" && order.status === "PENDING_PAYMENT") {
        const wallet = await tx.wallet.findFirst({ where: { organizationId } })
        if (wallet && amount > 0) {
          const released = await tx.wallet.updateMany({
            where: { id: wallet.id, version: wallet.version },
            data: {
              reservedBalance: { decrement: amount },
              availableBalance: { increment: amount },
              version: { increment: 1 },
            },
          })
          if (released.count === 0) {
            throw new ConflictException("Wallet was modified by another request. Retry.")
          }
        }
      }

      // Refund captured payments back to wallet
      if (order.paymentStatus === "PAID" && amount > 0) {
        // Cancel any active settlement so the publisher is not paid after the
        // customer is refunded. Cancellable statuses end before SETTLED, so a
        // RELEASED settlement (clawback case) cannot occur here.
        const activeSettlement = await tx.settlement.findFirst({
          where: { orderId, status: { notIn: ["CANCELLED", "RELEASED"] } },
        })
        if (activeSettlement) {
          const cancelled = await tx.settlement.updateMany({
            where: { id: activeSettlement.id, version: activeSettlement.version },
            data: { status: "CANCELLED", version: { increment: 1 } },
          })
          if (cancelled.count === 0) {
            throw new ConflictException("Settlement was modified by another request. Retry.")
          }
        }

        const existingRefund = await tx.transaction.findFirst({
          where: { orderId, type: "REFUND" },
        })
        if (!existingRefund) {
          const wallet = await tx.wallet.findFirst({ where: { organizationId } })
          if (!wallet) throw new BadRequestException("No wallet found for refund")

          const refunded = await tx.wallet.updateMany({
            where: { id: wallet.id, version: wallet.version },
            data: {
              availableBalance: { increment: amount },
              version: { increment: 1 },
            },
          })
          if (refunded.count === 0) {
            throw new ConflictException("Wallet was modified by another request. Retry.")
          }

          await tx.transaction.create({
            data: {
              walletId: wallet.id,
              amount,
              type: "REFUND",
              orderId,
              reference: `refund-${orderId}`,
              description: `Refund of ${amount} for cancelled order ${orderId}`,
            },
          })
        }
      }

      const updated = await tx.order.update({
        where: { id: orderId },
        data: {
          status: "CANCELLED",
          ...(order.paymentStatus === "PAID" ? { paymentStatus: "REFUNDED" } : {}),
        },
      })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ORDER_CANCELLED",
          actorId: userId,
          message: `Order cancelled by customer`,
        },
      })

      await this.audit.log({
        action: "ORDER_CANCELLED",
        entityType: "Order",
        entityId: orderId,
        metadata: { fromStatus: order.status },
        userId,
        organizationId,
      })

      return updated
    })
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
        settlements: { include: { approvals: true } },
        dispute: true,
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
        settlements: { include: { approvals: true } },
        dispute: true,
      },
    })
  }

  async listPublisherOrders(publisherId: string) {
    return this.prisma.order.findMany({
      where: { website: { publisherId } },
      orderBy: { createdAt: "desc" },
      include: { items: true, website: true, campaign: true, settlements: { include: { approvals: true } }, dispute: true },
    })
  }
}
