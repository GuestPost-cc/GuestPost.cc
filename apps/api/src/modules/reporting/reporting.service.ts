import { QUEUES } from "@guestpost/shared"
import { Injectable, NotFoundException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { QueueService } from "../queues/queue.service"

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
      // Phase 7.1 — audit #15 fix. Snapshot wins; fallback only for pre-Phase-6
      // legacy rows. Matches refund.service.ts:68 and order-review.service.ts:289.
      // A site reassigned mid-flight after the snapshot must NOT re-attribute
      // historical revenue — that's the entire point of Phase 6's channel snapshot.
      ownershipType:
        (order as { fulfillmentChannel?: string | null }).fulfillmentChannel ??
        (order.website as { ownershipType?: string | null } | null)
          ?.ownershipType ??
        "PUBLISHER",
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

    // Phase 7.1 — audit #15 fix. Channel-split must read the snapshotted
    // `fulfillmentChannel` first; the live `website.ownershipType` is only a
    // legacy-row fallback. Otherwise a site reassigned mid-flight re-attributes
    // historical campaign revenue — the exact bug Phase 6's snapshot prevents.
    const resolveChannel = (o: {
      fulfillmentChannel?: string | null
      website?: { ownershipType?: string | null } | null
    }): string =>
      o.fulfillmentChannel ?? o.website?.ownershipType ?? "PUBLISHER"

    const orders = campaign.orders as any[]
    const platformOrders = orders.filter(
      (o: any) => resolveChannel(o) === "PLATFORM",
    )
    const publisherOrders = orders.filter(
      (o: any) => resolveChannel(o) !== "PLATFORM",
    )

    return {
      ...campaign,
      totalSpend: orders.reduce(
        (sum: number, o: any) => sum + (Number(o.amount) || 0),
        0,
      ),
      publishedCount: orders.filter((o: any) =>
        ["PUBLISHED", "COMPLETED", "VERIFIED"].includes(o.status),
      ).length,
      platformOrderCount: platformOrders.length,
      publisherOrderCount: publisherOrders.length,
      platformSpend: platformOrders.reduce(
        (sum: number, o: any) => sum + (Number(o.amount) || 0),
        0,
      ),
      publisherSpend: publisherOrders.reduce(
        (sum: number, o: any) => sum + (Number(o.amount) || 0),
        0,
      ),
    }
  }

  async generateOrderReport(
    orderId: string,
    organizationId: string,
    format: "pdf" | "csv" = "pdf",
  ) {
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
