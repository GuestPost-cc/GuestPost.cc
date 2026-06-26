import { ServiceType } from "@guestpost/shared"
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { OrdersService } from "../orders/orders.service"

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orders: OrdersService,
  ) {}

  async createOrder(
    data: {
      type: ServiceType
      title?: string
      instructions?: string
      targetUrl?: string
      anchorText?: string
      customerId: string
      websiteId?: string
      organizationId: string
      campaignId?: string
      idempotencyKey?: string
    },
    userId: string,
  ) {
    if (data.websiteId) {
      const website = await this.prisma.website.findUnique({
        where: { id: data.websiteId },
      })
      if (!website) throw new NotFoundException("Website not found")
      if (!website.isActive)
        throw new ForbiddenException("Website is not active")

      // Orders may only target websites with an approved marketplace listing
      const listing = await this.prisma.marketplaceListing.findFirst({
        where: { websiteId: data.websiteId, status: "APPROVED" },
        select: { id: true },
      })
      if (!listing)
        throw new ForbiddenException(
          "Website does not have an approved marketplace listing",
        )
    }
    if (data.campaignId) {
      const campaign = await this.prisma.campaign.findUnique({
        where: { id: data.campaignId },
      })
      if (!campaign) throw new NotFoundException("Campaign not found")
      if (campaign.organizationId !== data.organizationId) {
        throw new ForbiddenException(
          "Campaign does not belong to your organization",
        )
      }
    }

    // Delegate to the canonical order creation path: idempotency, item +
    // amount calculation from the approved listing, and ORDER_CREATED event
    const order = await this.orders.createOrder(
      {
        type: data.type,
        title: data.title,
        instructions: data.instructions,
        customerId: data.customerId,
        organizationId: data.organizationId,
        campaignId: data.campaignId,
        idempotencyKey: data.idempotencyKey,
        targetUrl: data.targetUrl,
        anchorText: data.anchorText,
        items: data.websiteId
          ? [
              {
                websiteId: data.websiteId,
                targetUrl: data.targetUrl,
                anchorText: data.anchorText,
              },
            ]
          : undefined,
      },
      userId,
    )

    await this.audit.log({
      action: "ORDER_CREATED",
      entityType: "Order",
      entityId: order.id,
      metadata: { type: data.type, campaignId: data.campaignId ?? null },
      userId,
      organizationId: data.organizationId,
    })
    return order
  }

  async getOrder(id: string, organizationId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, organizationId },
      include: {
        contentOrder: true,
        revisions: true,
        reports: true,
        website: true,
        items: { include: { publications: true } },
        events: { orderBy: { createdAt: "desc" } },
        settlements: { include: { approvals: true } },
        dispute: true,
      },
    })

    if (!order) throw new NotFoundException(`Order ${id} not found`)
    return order
  }

  async listOrders(organizationId: string, take = 50, skip = 0) {
    const where = { organizationId }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: { website: true, campaign: true },
        take,
        skip,
      }),
      this.prisma.order.count({ where }),
    ])
    return { items, total, take, skip }
  }

  async createCampaign(
    data: { name: string; description?: string; organizationId: string },
    userId: string,
  ) {
    const campaign = await this.prisma.campaign.create({ data })
    await this.audit.log({
      action: "CAMPAIGN_CREATED",
      entityType: "Campaign",
      entityId: campaign.id,
      metadata: { name: data.name },
      userId,
      organizationId: data.organizationId,
    })
    return campaign
  }

  async listCampaigns(organizationId: string, take = 50, skip = 0) {
    const where = { organizationId }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.campaign.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      this.prisma.campaign.count({ where }),
    ])
    return { items, total, take, skip }
  }

  async getCampaign(id: string, organizationId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, organizationId },
      include: { _count: { select: { orders: true } } },
    })
    if (!campaign) throw new NotFoundException("Campaign not found")
    return {
      ...campaign,
      orderCount: campaign._count.orders,
    }
  }

  async listCampaignOrders(
    campaignId: string,
    organizationId: string,
    take = 50,
    skip = 0,
  ) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, organizationId },
    })
    if (!campaign) throw new NotFoundException("Campaign not found")

    const where = { campaignId, organizationId }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: { items: true, website: true, settlements: true },
        take,
        skip,
      }),
      this.prisma.order.count({ where }),
    ])
    return { items, total, take, skip }
  }

  // Org-scoped partial update. Status changes never touch orders — a PAUSED
  // or ARCHIVED campaign's existing orders continue their lifecycle; only
  // new-order attachment is a frontend concern.
  async updateCampaign(
    id: string,
    organizationId: string,
    userId: string,
    data: { name?: string; description?: string; status?: string },
  ) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, organizationId },
    })
    if (!campaign) throw new NotFoundException("Campaign not found")

    const VALID_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]
    if (data.status && !VALID_STATUSES.includes(data.status)) {
      throw new BadRequestException(
        `Invalid status — must be one of ${VALID_STATUSES.join(", ")}`,
      )
    }

    const updated = await this.prisma.campaign.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined
          ? { description: data.description }
          : {}),
        ...(data.status !== undefined ? { status: data.status as any } : {}),
      },
    })

    await this.audit.log({
      action: "CAMPAIGN_UPDATED",
      entityType: "Campaign",
      entityId: id,
      metadata: {
        changes: data,
        previous: { name: campaign.name, status: campaign.status },
      },
      userId,
      organizationId,
    })

    return updated
  }

  async deleteCampaign(id: string, organizationId: string, userId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, organizationId },
    })
    if (!campaign) throw new NotFoundException("Campaign not found")

    await this.prisma.campaign.delete({ where: { id } })
    await this.audit.log({
      action: "CAMPAIGN_DELETED",
      entityType: "Campaign",
      entityId: id,
      metadata: { name: campaign.name },
      userId,
      organizationId,
    })
  }

  async listPublisherOrders(publisherId: string, take = 50, skip = 0) {
    const where = { website: { publisherId } }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: { website: true, campaign: true },
        take,
        skip,
      }),
      this.prisma.order.count({ where }),
    ])
    return { items, total, take, skip }
  }

  async requestRevision(
    orderId: string,
    organizationId: string,
    notes: string,
    userId: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
    })

    if (!order) throw new NotFoundException(`Order ${orderId} not found`)

    const revision = await this.prisma.revision.create({
      data: { orderId, notes, status: "REQUESTED" },
    })
    await this.audit.log({
      action: "REVISION_REQUESTED",
      entityType: "Order",
      entityId: orderId,
      metadata: { revisionId: revision.id },
      userId,
      organizationId,
    })
    return revision
  }
}
