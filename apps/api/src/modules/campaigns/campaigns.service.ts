import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { ServiceType } from "@guestpost/shared"

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["CONTENT_CREATION", "CANCELLED"],
  CONTENT_CREATION: ["OUTREACH", "CANCELLED"],
  OUTREACH: ["PUBLISHED", "CANCELLED"],
  PUBLISHED: ["VERIFIED", "CANCELLED"],
  VERIFIED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
}

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createOrder(data: {
    type: ServiceType
    title?: string
    instructions?: string
    targetUrl?: string
    anchorText?: string
    customerId: string
    websiteId?: string
    organizationId: string
    campaignId?: string
  }, userId: string) {
    if (data.websiteId) {
      const website = await this.prisma.website.findUnique({
        where: { id: data.websiteId },
      })
      if (!website) throw new NotFoundException("Website not found")
    }
    if (data.campaignId) {
      const campaign = await this.prisma.campaign.findUnique({
        where: { id: data.campaignId },
      })
      if (!campaign) throw new NotFoundException("Campaign not found")
      if (campaign.organizationId !== data.organizationId) {
        throw new ForbiddenException("Campaign does not belong to your organization")
      }
    }
    const order = await this.prisma.order.create({
      data: {
        type: data.type,
        title: data.title,
        instructions: data.instructions,
        targetUrl: data.targetUrl,
        anchorText: data.anchorText,
        customerId: data.customerId,
        websiteId: data.websiteId,
        organizationId: data.organizationId,
        campaignId: data.campaignId,
        status: "DRAFT",
        paymentStatus: "PENDING",
      },
    })
    await this.audit.log({
      action: "ORDER_CREATED",
      entityType: "Order",
      entityId: order.id,
      metadata: { type: data.type },
      userId,
      organizationId: data.organizationId,
    })
    return order
  }

  async updateOrderStatus(id: string, organizationId: string, status: any, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, organizationId },
    })

    if (!order) throw new NotFoundException(`Order ${id} not found`)

    const allowed = ALLOWED_TRANSITIONS[order.status] ?? []
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Cannot transition order from ${order.status} to ${status}. Allowed: ${allowed.join(", ") || "none"}`,
      )
    }

    const updated = await this.prisma.order.update({
      where: { id },
      data: { status },
    })
    await this.audit.log({
      action: "ORDER_STATUS_CHANGED",
      entityType: "Order",
      entityId: id,
      metadata: { from: order.status, to: status },
      userId,
      organizationId,
    })
    return updated
  }

  async getOrder(id: string, organizationId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, organizationId },
      include: {
        contentOrder: true,
        revisions: true,
        reports: true,
        website: true,
      },
    })

    if (!order) throw new NotFoundException(`Order ${id} not found`)
    return order
  }

  async listOrders(organizationId: string) {
    return this.prisma.order.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      include: { website: true, campaign: true },
    })
  }

  async createCampaign(data: { name: string; description?: string; organizationId: string }, userId: string) {
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

  async listCampaigns(organizationId: string) {
    return this.prisma.campaign.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    })
  }

  async listPublisherOrders(publisherId: string) {
    return this.prisma.order.findMany({
      where: {
        website: { publisherId },
      },
      orderBy: { createdAt: "desc" },
      include: { website: true, campaign: true },
    })
  }

  async requestRevision(orderId: string, organizationId: string, notes: string, userId: string) {
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
