import { Prisma } from "@guestpost/database"
import { QUEUE_JOBS, QUEUES } from "@guestpost/shared"
import { Injectable, NotFoundException } from "@nestjs/common"
import { canCustomerViewWebsite } from "../../common/customer-website-access"
import { PrismaService } from "../../common/prisma.service"
import { projectExternalOrder } from "../orders/order-visibility"
import { QueueService } from "../queues/queue.service"

const REPORT_EVENT_LIMIT = 100
const REPORT_RELATION_LIMIT = 100

const CUSTOMER_REPORT_ORDER_SELECT = {
  id: true,
  customerId: true,
  version: true,
  type: true,
  status: true,
  amount: true,
  currency: true,
  paymentStatus: true,
  title: true,
  instructions: true,
  targetUrl: true,
  anchorText: true,
  publishedUrl: true,
  campaignId: true,
  autoAcceptAt: true,
  verifyMethod: true,
  deliveryAcceptedMethod: true,
  turnaroundDays: true,
  submittedAt: true,
  acceptedAt: true,
  fulfillmentDueAt: true,
  warrantyEndsAt: true,
  briefData: true,
  fulfillmentChannel: true,
  createdAt: true,
  updatedAt: true,
  campaign: { select: { id: true, name: true } },
  website: { select: { id: true, name: true, url: true, ownershipType: true } },
  items: {
    take: REPORT_RELATION_LIMIT,
    select: {
      id: true,
      websiteId: true,
      targetUrl: true,
      anchorText: true,
      price: true,
      status: true,
      website: { select: { id: true, name: true, url: true } },
      publications: {
        take: REPORT_RELATION_LIMIT,
        select: {
          id: true,
          publishedUrl: true,
          targetUrl: true,
          anchorText: true,
          screenshotUrl: true,
          publicationDate: true,
          verificationStatus: true,
        },
      },
    },
  },
  events: {
    orderBy: { createdAt: "desc" as const },
    take: REPORT_EVENT_LIMIT + 1,
    select: {
      id: true,
      eventType: true,
      message: true,
      metadata: true,
      createdAt: true,
    },
  },
} satisfies Prisma.OrderSelect

const CUSTOMER_CAMPAIGN_ORDER_SELECT = {
  ...CUSTOMER_REPORT_ORDER_SELECT,
  items: false,
  events: false,
} satisfies Prisma.OrderSelect

const REPORT_LIST_SELECT = {
  id: true,
  type: true,
  format: true,
  exportedAt: true,
  createdAt: true,
  updatedAt: true,
  order: {
    select: { id: true, title: true, type: true, status: true },
  },
} satisfies Prisma.ReportSelect

const EXTERNAL_REPORT_DATA_KEYS = [
  "orderId",
  "type",
  "status",
  "targetUrl",
  "publishedUrl",
  "anchorText",
  "fulfillmentChannel",
  "listingId",
  "listingServiceId",
  "serviceType",
  "unitPrice",
  "turnaroundDays",
  "publishedAt",
  "campaignProgress",
] as const

function projectExternalReportData(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const source = data as Record<string, unknown>
  return Object.fromEntries(
    EXTERNAL_REPORT_DATA_KEYS.flatMap((key) => {
      if (!Object.hasOwn(source, key)) return []
      const value = source[key]
      return value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
        ? [[key, value] as const]
        : []
    }),
  )
}

@Injectable()
export class ReportingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async getOrderReport(orderId: string, organizationId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      select: CUSTOMER_REPORT_ORDER_SELECT,
    })
    if (!order) throw new NotFoundException("Order not found")

    const websiteUnlocked = await canCustomerViewWebsite(
      this.prisma,
      organizationId,
    )
    const projected = projectExternalOrder(
      { ...order, events: order.events.slice(0, REPORT_EVENT_LIMIT) },
      "CUSTOMER",
      websiteUnlocked,
    )
    return {
      ...projected,
      ownershipType:
        order.fulfillmentChannel ?? order.website?.ownershipType ?? "PUBLISHER",
      eventLimit: REPORT_EVENT_LIMIT,
      eventsTruncated: order.events.length > REPORT_EVENT_LIMIT,
    }
  }

  async getCampaignReport(
    campaignId: string,
    organizationId: string,
    take = 50,
    skip = 0,
  ) {
    const where: Prisma.OrderWhereInput = { campaignId, organizationId }
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, organizationId },
      select: { id: true, name: true, description: true, status: true },
    })
    if (!campaign) throw new NotFoundException("Campaign not found")

    const platformWhere: Prisma.OrderWhereInput = {
      ...where,
      OR: [
        { fulfillmentChannel: "PLATFORM" },
        { fulfillmentChannel: null, website: { ownershipType: "PLATFORM" } },
      ],
    }
    const publisherWhere: Prisma.OrderWhereInput = {
      ...where,
      NOT: platformWhere,
    }
    const [
      orders,
      total,
      totals,
      platformTotals,
      publisherTotals,
      publishedCount,
    ] = await this.prisma.$transaction(
      (tx) =>
        Promise.all([
          tx.order.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take,
            skip,
            select: CUSTOMER_CAMPAIGN_ORDER_SELECT,
          }),
          tx.order.count({ where }),
          tx.order.aggregate({
            where,
            _sum: { amount: true },
            _count: { _all: true },
          }),
          tx.order.aggregate({
            where: platformWhere,
            _sum: { amount: true },
            _count: { _all: true },
          }),
          tx.order.aggregate({
            where: publisherWhere,
            _sum: { amount: true },
            _count: { _all: true },
          }),
          tx.order.count({
            where: {
              ...where,
              status: { in: ["PUBLISHED", "COMPLETED", "VERIFIED"] },
            },
          }),
        ]),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 30_000,
      },
    )
    const websiteUnlocked = await canCustomerViewWebsite(
      this.prisma,
      organizationId,
    )

    return {
      ...campaign,
      orders: orders.map((order) =>
        projectExternalOrder(order, "CUSTOMER", websiteUnlocked),
      ),
      total,
      take,
      skip,
      totalSpend: String(totals._sum.amount ?? 0),
      publishedCount,
      platformOrderCount: platformTotals._count._all,
      publisherOrderCount: publisherTotals._count._all,
      platformSpend: String(platformTotals._sum.amount ?? 0),
      publisherSpend: String(publisherTotals._sum.amount ?? 0),
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

    const jobName =
      format === "csv"
        ? QUEUE_JOBS[QUEUES.REPORT].GENERATE_CSV
        : QUEUE_JOBS[QUEUES.REPORT].GENERATE_PDF
    await this.queue.addJob(QUEUES.REPORT, jobName, {
      orderId,
      format,
      organizationId,
    })
    return { message: "Report generation started" }
  }

  async listReports(organizationId: string, take = 50, skip = 0) {
    const where = { order: { organizationId } }
    const [items, total] = await this.prisma.$transaction((tx) =>
      Promise.all([
        tx.report.findMany({
          where,
          select: REPORT_LIST_SELECT,
          orderBy: { createdAt: "desc" },
          take,
          skip,
        }),
        tx.report.count({ where }),
      ]),
    )
    return { items, total, take, skip }
  }

  async getReport(id: string, organizationId: string) {
    const report = await this.prisma.report.findFirst({
      where: { id, order: { organizationId } },
      select: { ...REPORT_LIST_SELECT, data: true },
    })
    if (!report) throw new NotFoundException("Report not found")
    return { ...report, data: projectExternalReportData(report.data) }
  }
}
