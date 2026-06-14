import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { QueueService } from "../queues/queue.service"
import { AuditService } from "../audit/audit.service"
import { QUEUES } from "@guestpost/shared"

// Phase 6.5: tickets are channel-aware. The participant matrix per channel is:
//
//   PUBLISHER channel:  customer org members + publisher org members + Admin + Finance
//   PLATFORM channel:   customer org members + assigned Ops + Admin + Finance
//
// Ticket schema gained `fulfillmentChannel`, `assignedToUserId`,
// `assignedPublisherId`. createTicket snapshots them from the linked order;
// later admin reassignment of a website does NOT retroactively re-route an
// existing ticket (prevents exposing past conversations to a new owner).
//
// Visibility (`listTickets`) and reply gate (`addMessage`) read the
// authenticated actor's role/membership and refuse to widen via client
// query params.

type ActorKind = "CUSTOMER" | "PUBLISHER" | "STAFF"
interface SupportActor {
  userId: string
  kind: ActorKind
  // For CUSTOMER: organizationId of the active org. For PUBLISHER: publisherId
  // of the active publisher org. For STAFF: staffRole.
  organizationId?: string | null
  publisherId?: string | null
  staffRole?: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE" | null
}

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  async createTicket(data: {
    subject: string
    description?: string
    orderId?: string
    userId: string
    organizationId: string
  }) {
    // Channel/fulfiller defaults — populated when the ticket is linked to an
    // order. Non-order tickets keep all three NULL (legacy generic support).
    let fulfillmentChannel: "PUBLISHER" | "PLATFORM" | null = null
    let assignedToUserId: string | null = null
    let assignedPublisherId: string | null = null

    if (data.orderId) {
      const order = await this.prisma.order.findFirst({
        where: { id: data.orderId, organizationId: data.organizationId },
        include: {
          website: { select: { publisherId: true, managedByUserId: true, ownershipType: true } },
        },
      })
      if (!order) throw new NotFoundException("Order not found")

      const channel = order.fulfillmentChannel
        ?? (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
      fulfillmentChannel = channel
      if (channel === "PLATFORM") {
        assignedToUserId = order.website?.managedByUserId ?? null
      } else {
        assignedPublisherId = order.website?.publisherId ?? null
      }
    }

    const ticket = await this.prisma.ticket.create({
      data: {
        subject: data.subject,
        description: data.description,
        userId: data.userId,
        organizationId: data.organizationId,
        orderId: data.orderId,
        fulfillmentChannel,
        assignedToUserId,
        assignedPublisherId,
      },
    })

    await this.audit.log({
      action: "TICKET_OPENED",
      entityType: "Ticket",
      entityId: ticket.id,
      metadata: {
        orderId: data.orderId ?? null,
        fulfillmentChannel,
        assignedToUserId,
        assignedPublisherId,
      },
      userId: data.userId,
      organizationId: data.organizationId,
    })

    // Notify the fulfiller side. Customer-side notifications fan out from
    // their existing ticket-thread UI; we only push the cross-role
    // participants here.
    await this.fanOutTicketEvent(ticket.id, "TICKET_OPENED", `New ticket: ${ticket.subject}`, data.userId)

    return ticket
  }

  // ── Visibility: role-keyed OR clause ────────────────────────────────────
  // The actor's role decides what `where` they get. There is no client param
  // that widens this; the only customer-supplied filter is `status`.
  async listTickets(actor: SupportActor, opts: { status?: string } = {}) {
    const where: any = {}
    if (opts.status) where.status = opts.status

    switch (actor.kind) {
      case "CUSTOMER":
        if (!actor.organizationId) throw new ForbiddenException("Missing organization context")
        where.organizationId = actor.organizationId
        break
      case "PUBLISHER":
        if (!actor.publisherId) throw new ForbiddenException("Missing publisher context")
        where.assignedPublisherId = actor.publisherId
        break
      case "STAFF":
        if (actor.staffRole === "OPERATIONS") {
          // Ops see tickets explicitly assigned to them PLUS the unassigned
          // platform pool (where another OPS staffer hasn't yet claimed).
          where.OR = [
            { assignedToUserId: actor.userId },
            { assignedToUserId: null, fulfillmentChannel: "PLATFORM" },
          ]
        }
        // SUPER_ADMIN + FINANCE see everything — no where clause beyond status.
        break
    }

    return this.prisma.ticket.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        order: { select: { id: true, title: true, status: true, type: true, fulfillmentChannel: true } },
        assignedTo: { select: { id: true, name: true } },
        assignedPublisher: { select: { id: true, name: true } },
      },
      orderBy: { updatedAt: "desc" },
    })
  }

  async getTicket(id: string, actor: SupportActor) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        messages: { include: { user: { select: { id: true, name: true } } } },
        order: { select: { id: true, title: true, status: true, type: true, fulfillmentChannel: true } },
        assignedTo: { select: { id: true, name: true } },
        assignedPublisher: { select: { id: true, name: true } },
      },
    })
    if (!ticket) throw new NotFoundException("Ticket not found")
    await this.assertVisible(actor, ticket)
    return ticket
  }

  // ── Reply gate: same matrix, applied to a single ticket ─────────────────
  async addMessage(ticketId: string, actor: SupportActor, data: { content: string }) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } })
    if (!ticket) throw new NotFoundException("Ticket not found")
    await this.assertCanReply(actor, ticket)

    const message = await this.prisma.ticketMessage.create({
      data: { content: data.content, userId: actor.userId, ticketId },
    })

    await this.audit.log({
      action: "TICKET_MESSAGE_ADDED",
      entityType: "Ticket",
      entityId: ticketId,
      metadata: {
        orderId: ticket.orderId,
        fulfillmentChannel: ticket.fulfillmentChannel,
        actorKind: actor.kind,
        actorStaffRole: actor.staffRole ?? null,
      },
      userId: actor.userId,
      organizationId: ticket.organizationId,
    })

    // Fan-out across the participant matrix (excluding the actor who just
    // wrote the message — they don't need to notify themselves).
    await this.fanOutTicketEvent(ticketId, "SUPPORT_REPLY", `New reply on ticket: ${ticket.subject}`, actor.userId)

    return message
  }

  // ── Admin reassignment of a single ticket (Phase 6.5) ───────────────────
  // Visibility migration only — historical messages are untouched. Use sparingly;
  // the default flow is auto-routing at ticket-create.
  async reassignTicket(
    ticketId: string,
    body: { assignedToUserId?: string | null; assignedPublisherId?: string | null; reason?: string },
    staff: { userId: string; staffRole: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE" | null },
  ) {
    if (staff.staffRole !== "SUPER_ADMIN") {
      throw new ForbiddenException("Only SUPER_ADMIN can reassign tickets")
    }
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } })
    if (!ticket) throw new NotFoundException("Ticket not found")

    // Target validation. If reassigning to an Ops user, they must have an
    // OPERATIONS staff membership. If reassigning to a publisher, the
    // publisher must exist.
    if (body.assignedToUserId) {
      const target = await this.prisma.staffMembership.findUnique({
        where: { userId: body.assignedToUserId }, select: { role: true },
      })
      if (!target || target.role !== "OPERATIONS") {
        throw new BadRequestException({ code: "INVALID_OWNER", message: "assignedToUserId must be an OPERATIONS staff member" })
      }
    }
    if (body.assignedPublisherId) {
      const pub = await this.prisma.publisher.findUnique({ where: { id: body.assignedPublisherId }, select: { id: true } })
      if (!pub) throw new BadRequestException("Publisher not found")
    }

    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        assignedToUserId:    body.assignedToUserId    ?? null,
        assignedPublisherId: body.assignedPublisherId ?? null,
      },
    })

    await this.audit.log({
      action: "TICKET_REASSIGNED",
      entityType: "Ticket",
      entityId: ticketId,
      metadata: {
        fromAssignedToUserId:    ticket.assignedToUserId,
        toAssignedToUserId:      body.assignedToUserId ?? null,
        fromAssignedPublisherId: ticket.assignedPublisherId,
        toAssignedPublisherId:   body.assignedPublisherId ?? null,
        reason: body.reason ?? null,
      },
      userId: staff.userId,
      organizationId: ticket.organizationId,
    })

    return this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private async assertVisible(actor: SupportActor, ticket: any) {
    switch (actor.kind) {
      case "CUSTOMER":
        if (ticket.organizationId !== actor.organizationId) {
          throw new NotFoundException("Ticket not found")
        }
        return
      case "PUBLISHER":
        if (ticket.assignedPublisherId !== actor.publisherId) {
          throw new NotFoundException("Ticket not found")
        }
        return
      case "STAFF":
        if (actor.staffRole === "OPERATIONS") {
          const isOwn = ticket.assignedToUserId === actor.userId
          const isUnassignedPlatform = ticket.assignedToUserId === null && ticket.fulfillmentChannel === "PLATFORM"
          if (!isOwn && !isUnassignedPlatform) throw new NotFoundException("Ticket not found")
        }
        // SUPER_ADMIN + FINANCE: all visible.
        return
    }
  }

  private async assertCanReply(actor: SupportActor, ticket: any) {
    await this.assertVisible(actor, ticket)
    // CUSTOMER: anyone in the org can reply (matches existing behaviour).
    if (actor.kind === "CUSTOMER") return
    // PUBLISHER: must be in the assigned publisher org (already validated by
    // assertVisible's publisherId match).
    if (actor.kind === "PUBLISHER") return
    // STAFF: SUPER_ADMIN + FINANCE always; OPERATIONS only on tickets they
    // own (the unassigned-platform pool is read-only — they must claim by
    // having SUPER_ADMIN reassign the ticket to them, or by being the
    // FulfillmentAssignment owner of the underlying order).
    if (actor.kind === "STAFF") {
      if (actor.staffRole === "OPERATIONS" && ticket.assignedToUserId !== actor.userId) {
        throw new ForbiddenException("Unassigned platform tickets are read-only until claimed")
      }
      return
    }
    throw new ForbiddenException("Cannot reply to this ticket")
  }

  // Compute the recipient set for a ticket event and enqueue notifications.
  // Excludes the actor (no self-notification).
  private async fanOutTicketEvent(ticketId: string, type: string, message: string, excludeUserId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        // Customer org members
        organization: { include: { memberships: { where: { status: "ACTIVE" } } } },
        // Publisher org members (only when assigned)
        assignedPublisher: { include: { publisherMemberships: true } },
      },
    })
    if (!ticket) return

    const recipients = new Set<{ userId: string; organizationId: string | null }>()

    // Customer org members
    for (const m of ticket.organization.memberships) {
      if (m.userId !== excludeUserId) recipients.add({ userId: m.userId, organizationId: ticket.organizationId })
    }
    // Publisher org members (PUBLISHER channel)
    if (ticket.assignedPublisher) {
      for (const m of ticket.assignedPublisher.publisherMemberships) {
        if (m.userId !== excludeUserId) recipients.add({ userId: m.userId, organizationId: null })
      }
    }
    // Assigned Ops user (PLATFORM channel)
    if (ticket.assignedToUserId && ticket.assignedToUserId !== excludeUserId) {
      recipients.add({ userId: ticket.assignedToUserId, organizationId: null })
    }
    // Admin + Finance: every active SUPER_ADMIN + FINANCE staff
    const adminFinance = await this.prisma.staffMembership.findMany({
      where: { role: { in: ["SUPER_ADMIN", "FINANCE"] } },
      select: { userId: true },
    })
    for (const sm of adminFinance) {
      if (sm.userId !== excludeUserId) recipients.add({ userId: sm.userId, organizationId: null })
    }

    for (const r of recipients) {
      await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
        userId: r.userId,
        organizationId: r.organizationId,
        type,
        message,
      })
    }
  }
}
