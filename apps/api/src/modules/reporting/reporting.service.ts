import { Injectable, NotFoundException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { QueueService } from "../queues/queue.service"
import { QUEUES } from "@guestpost/shared"

@Injectable()
export class ReportingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async getOrderReport(orderId: string, organizationId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      include: {
        items: {
          include: {
            website: true,
            publications: true,
          },
        },
        events: { orderBy: { createdAt: "desc" } },
        website: true,
        campaign: true,
        platformRevenue: true,
      },
    })
    if (!order) throw new NotFoundException("Order not found")
    return {
      ...order,
      ownershipType: (order.website as any)?.ownershipType ?? "PUBLISHER",
    }
  }

  async getCampaignReport(campaignId: string, organizationId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, organizationId },
      include: {
        orders: {
          include: {
            items: { include: { website: true, publications: true } },
            events: { orderBy: { createdAt: "desc" }, take: 1 },
            website: { select: { ownershipType: true } },
          },
        },
      },
    })
    if (!campaign) throw new NotFoundException("Campaign not found")

    const orders = campaign.orders as any[]
    const platformOrders = orders.filter((o: any) => o.website?.ownershipType === "PLATFORM")
    const publisherOrders = orders.filter((o: any) => o.website?.ownershipType !== "PLATFORM")

    return {
      ...campaign,
      totalSpend: orders.reduce((sum: number, o: any) => sum + (Number(o.amount) || 0), 0),
      publishedCount: orders.filter((o: any) => ["PUBLISHED", "COMPLETED", "VERIFIED"].includes(o.status)).length,
      platformOrderCount: platformOrders.length,
      publisherOrderCount: publisherOrders.length,
      platformSpend: platformOrders.reduce((sum: number, o: any) => sum + (Number(o.amount) || 0), 0),
      publisherSpend: publisherOrders.reduce((sum: number, o: any) => sum + (Number(o.amount) || 0), 0),
    }
  }

  async generateOrderReport(orderId: string, organizationId: string, format: "pdf" | "csv" = "pdf") {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
    })
    if (!order) throw new NotFoundException("Order not found")

    await this.queue.addJob(QUEUES.REPORT, "generate-report", {
      orderId,
      format,
      organizationId,
    })
    return { message: "Report generation started" }
  }

  async listReports(organizationId: string, take = 50, skip = 0) {
    const where = { order: { organizationId } }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.report.findMany({
        where,
        include: { order: true },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      this.prisma.report.count({ where }),
    ])
    return { items, total, take, skip }
  }

  async getReport(id: string, organizationId: string) {
    const report = await this.prisma.report.findFirst({
      where: { id, order: { organizationId } },
      include: { order: true },
    })
    if (!report) throw new NotFoundException("Report not found")
    return report
  }
}