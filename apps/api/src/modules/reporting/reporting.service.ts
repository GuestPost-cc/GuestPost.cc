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
