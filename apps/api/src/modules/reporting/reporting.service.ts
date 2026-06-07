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
      },
    })
    if (!order) throw new NotFoundException("Order not found")
    return order
  }

  async getCampaignReport(campaignId: string, organizationId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, organizationId },
      include: {
        orders: {
          include: {
            items: { include: { website: true, publications: true } },
            events: { orderBy: { createdAt: "desc" }, take: 1 },
          },
        },
      },
    })
    if (!campaign) throw new NotFoundException("Campaign not found")
    return {
      ...campaign,
      totalSpend: campaign.orders.reduce((sum: number, o: any) => sum + (Number(o.amount) || 0), 0),
      publishedCount: campaign.orders.filter((o: any) => ["PUBLISHED", "COMPLETED", "VERIFIED"].includes(o.status)).length,
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

  async listReports(organizationId: string) {
    return this.prisma.report.findMany({
      where: { order: { organizationId } },
      include: { order: true },
      orderBy: { createdAt: "desc" },
    })
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