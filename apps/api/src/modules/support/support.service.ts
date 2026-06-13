import { Injectable, NotFoundException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { QueueService } from "../queues/queue.service"
import { QUEUES } from "@guestpost/shared"

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async createTicket(data: { subject: string; description?: string; orderId?: string; userId: string; organizationId: string }) {
    // If an order is referenced, it must belong to the caller's org — blocks
    // attaching a ticket to another tenant's order.
    if (data.orderId) {
      const order = await this.prisma.order.findFirst({ where: { id: data.orderId, organizationId: data.organizationId }, select: { id: true } })
      if (!order) throw new NotFoundException("Order not found")
    }
    return this.prisma.ticket.create({ data })
  }

  async listTickets(organizationId: string) {
    return this.prisma.ticket.findMany({
      where: { organizationId },
      include: { user: true, order: { select: { id: true, title: true, status: true } } },
      orderBy: { updatedAt: "desc" },
    })
  }

  async getTicket(id: string, organizationId: string) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, organizationId },
      include: { messages: { include: { user: true } }, order: { select: { id: true, title: true, status: true } } },
    })

    if (!ticket) throw new NotFoundException("Ticket not found")
    return ticket
  }

  async addMessage(ticketId: string, organizationId: string, data: { content: string; userId: string }) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, organizationId },
    })

    if (!ticket) throw new NotFoundException("Ticket not found")

    const message = await this.prisma.ticketMessage.create({
      data: {
        ...data,
        ticketId,
      },
    })

    if (data.userId !== ticket.userId) {
      await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
        userId: ticket.userId,
        organizationId: ticket.organizationId,
        type: "SUPPORT_REPLY",
        message: `New reply on ticket: ${ticket.subject}`,
      })
    }

    return message
  }
}
