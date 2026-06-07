import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { Decimal } from "@prisma/client/runtime/library"

const TIER_REVIEW_DAYS: Record<string, number> = {
  NEW: 30,
  TRUSTED: 14,
  VERIFIED: 7,
}

const DEFAULT_REVIEW_DAYS = 5

@Injectable()
export class SettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createSettlement(orderId: string, organizationId: string | null, userId: string) {
    const where: any = { id: orderId }
    if (organizationId) where.organizationId = organizationId
    const order = await this.prisma.order.findFirst({
      where,
      include: { website: true },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "VERIFIED") {
      throw new BadRequestException("Order must be VERIFIED before settlement")
    }

    const publisher = await this.prisma.publisher.findFirst({
      where: { websites: { some: { id: order.websiteId ?? undefined } } },
    })
    if (!publisher) throw new NotFoundException("Publisher not found for this order")

    const grossAmount = order.amount ? Number(order.amount) : 0
    const platformFee = grossAmount * 0.2
    const publisherAmount = grossAmount - platformFee
    const reviewDays = TIER_REVIEW_DAYS[publisher.tier] ?? DEFAULT_REVIEW_DAYS
    const reviewEndsAt = new Date(Date.now() + reviewDays * 24 * 60 * 60 * 1000)

    const settlement = await this.prisma.settlement.create({
      data: {
        orderId,
        publisherId: publisher.id,
        grossAmount,
        platformFee,
        publisherAmount,
        status: "PENDING",
        reviewEndsAt,
      },
    })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "UNDER_REVIEW",
        actorId: userId,
        message: `Settlement created — ${reviewDays}-day review window started`,
        metadata: { settlementId: settlement.id, reviewEndsAt: reviewEndsAt.toISOString() },
      },
    })

    await this.prisma.order.update({ where: { id: orderId }, data: { status: "UNDER_REVIEW" } })

    await this.audit.log({
      action: "SETTLEMENT_CREATED",
      entityType: "Settlement",
      entityId: settlement.id,
      metadata: { orderId, grossAmount, platformFee, publisherAmount, reviewDays },
      userId,
      organizationId: organizationId ?? order.organizationId,
    })

    return settlement
  }

  async approveSettlement(id: string, userId: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true, publisher: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.status !== "PENDING" && settlement.status !== "UNDER_REVIEW") {
      throw new BadRequestException(`Cannot approve settlement in ${settlement.status} status`)
    }

    return this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.settlement.update({
        where: { id },
        data: { status: "APPROVED", settledAt: new Date() },
      })

      const balance = await tx.publisherBalance.upsert({
        where: { publisherId: settlement.publisherId },
        create: {
          publisherId: settlement.publisherId,
          pendingBalance: 0,
          approvedBalance: Number(settlement.publisherAmount),
          withdrawableBalance: 0,
          lifetimeEarnings: Number(settlement.publisherAmount),
        },
        update: {
          pendingBalance: { decrement: Number(settlement.publisherAmount) },
          approvedBalance: { increment: Number(settlement.publisherAmount) },
          lifetimeEarnings: { increment: Number(settlement.publisherAmount) },
        },
      })

      await tx.orderEvent.create({
        data: {
          orderId: settlement.orderId,
          eventType: "SETTLED",
          actorId: userId,
          message: `Settlement approved — ${settlement.publisherAmount} added to publisher balance`,
          metadata: { settlementId: id, publisherAmount: Number(settlement.publisherAmount) },
        },
      })

      await tx.order.update({ where: { id: settlement.orderId }, data: { status: "SETTLED" } })

      await this.audit.log({
        action: "SETTLEMENT_APPROVED",
        entityType: "Settlement",
        entityId: id,
        metadata: { publisherId: settlement.publisherId, amount: Number(settlement.publisherAmount) },
        userId,
        organizationId: settlement.order.organizationId,
      })

      return { settlement: updated, balance }
    })
  }

  async listSettlements(organizationId?: string, take = 50, skip = 0) {
    const where = organizationId ? { order: { organizationId } } : {}
    const [items, total] = await this.prisma.$transaction([
      this.prisma.settlement.findMany({
        where,
        include: { order: true, publisher: true },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      this.prisma.settlement.count({ where }),
    ])
    return { items, total, take, skip }
  }

  async getSettlement(id: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: { include: { customer: true, website: true } }, publisher: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    return settlement
  }
}
