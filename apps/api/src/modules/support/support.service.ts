import { QUEUES } from "@guestpost/shared"
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { QueueService } from "../queues/queue.service"

// Phase 6.6: tickets are channel-aware. The participant matrix below is the
// single source of truth — admin-route handlers delegate here so the matrix
// is enforced through one code path.
//
//   PUBLISHER channel
//     Customer org members           R + W(PUBLIC)
//     Publisher org members          R + W(PUBLIC)
//     SUPER_ADMIN                    R + W(PUBLIC, INTERNAL)
//     FINANCE                        R + W(PUBLIC, INTERNAL)
//
//   PLATFORM channel
//     Customer org members           R + W(PUBLIC)
//     Assigned Ops (managedByUserId) R + W(PUBLIC, INTERNAL)
//     SUPER_ADMIN                    R + W(PUBLIC, INTERNAL)
//     FINANCE                        R + W(INTERNAL)   -- read-only on the
//                                                       -- customer-facing thread;
//                                                       -- writes are limited to
//                                                       -- internal notes used as
//                                                       -- an audit escape valve
//
// INTERNAL messages are never returned to CUSTOMER or PUBLISHER actors — they
// are filtered server-side in `getTicket` and `listTicketsDetailed`. The UI
// is decorative; this server filter is the source of truth.
//
// Channel/assignment is snapshotted from the linked order at ticket creation;
// later admin reassignment of a website does NOT retroactively re-route an
// existing ticket (prevents exposing past conversations to a new owner).

type ActorKind = "CUSTOMER" | "PUBLISHER" | "STAFF"
type StaffRole = "SUPER_ADMIN" | "OPERATIONS" | "FINANCE"
type CustomerRole = "OWNER" | "MEMBER"
type PublisherRole = "PUBLISHER_OWNER" | "PUBLISHER_MEMBER"
type Visibility = "PUBLIC" | "INTERNAL"
type ParticipantRole = "CUSTOMER" | "PUBLISHER" | "OPS" | "ADMIN" | "FINANCE"
type MessageType = "MESSAGE" | "INTERNAL_NOTE" | "SYSTEM_EVENT"

export interface SupportActor {
  userId: string
  kind: ActorKind
  organizationId?: string | null
  publisherId?: string | null
  // Phase 6.6.2: full role context. participantRole is the collapsed value
  // used for badges + audit filters; these uncollapsed roles get
  // snapshotted onto TicketMessage.actorSnapshot so investigations have
  // the raw schema-level answer ("OWNER vs MEMBER", "SUPER_ADMIN vs
  // FINANCE") without joining StaffMembership/Membership at query time.
  staffRole?: StaffRole | null
  customerRole?: CustomerRole | null
  publisherRole?: PublisherRole | null
}

// Phase 6.6.2: uncollapsed role snapshot. Stored in TicketMessage.actorSnapshot
// for forensic queries. The shape is intentionally open — future fields
// (e.g. effective permissions[] from StaffMembership) can be added without
// a schema migration since the column is JSONB.
export interface ActorSnapshot {
  kind: ActorKind
  staffRole: StaffRole | null
  organizationRole: CustomerRole | null
  publisherRole: PublisherRole | null
}

// Pure helper — exported so admin investigation views and tests can build
// the same shape. Always returns concrete values (never `undefined`) so the
// stored JSON has a stable schema.
export function buildActorSnapshot(actor: SupportActor): ActorSnapshot {
  return {
    kind: actor.kind,
    staffRole: actor.staffRole ?? null,
    organizationRole: actor.customerRole ?? null,
    publisherRole: actor.publisherRole ?? null,
  }
}

// Phase 6.6.1: collapses the (actor.kind, actor.staffRole) pair down to the
// single TicketParticipantRole that gets snapshotted onto the message row.
// Pure function — exported for the matrix tests + future system-event paths.
// NEVER call this with client-supplied data; the actor must come from
// AuthGuard / SupportController.buildActor.
export function resolveParticipantRole(actor: SupportActor): ParticipantRole {
  if (actor.kind === "CUSTOMER") return "CUSTOMER"
  if (actor.kind === "PUBLISHER") return "PUBLISHER"
  switch (actor.staffRole) {
    case "SUPER_ADMIN":
      return "ADMIN"
    case "OPERATIONS":
      return "OPS"
    case "FINANCE":
      return "FINANCE"
    default:
      // STAFF without a role should never reach a write path — guards refuse
      // earlier. Refuse here too rather than silently mislabel.
      throw new ForbiddenException("Staff role required")
  }
}

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  // ── createTicket ────────────────────────────────────────────────────────
  // The opening description is always PUBLIC (it is the customer's question).
  async createTicket(data: {
    subject: string
    description?: string
    orderId?: string
    userId: string
    organizationId: string
  }) {
    let fulfillmentChannel: "PUBLISHER" | "PLATFORM" | null = null
    let assignedToUserId: string | null = null
    let assignedPublisherId: string | null = null

    if (data.orderId) {
      const order = await this.prisma.order.findFirst({
        where: { id: data.orderId, organizationId: data.organizationId },
        include: {
          website: {
            select: {
              publisherId: true,
              managedByUserId: true,
              ownershipType: true,
            },
          },
        },
      })
      if (!order) throw new NotFoundException("Order not found")

      const channel =
        order.fulfillmentChannel ??
        (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
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

    // TICKET_OPENED uses the PUBLIC recipient set — the ticket subject + body
    // ARE the customer's public message. Internal-only events use the
    // INTERNAL set.
    await this.fanOutTicketEvent(
      ticket.id,
      "TICKET_OPENED",
      `New ticket: ${ticket.subject}`,
      data.userId,
      "PUBLIC",
    )

    return ticket
  }

  // ── listTickets ─────────────────────────────────────────────────────────
  // Role-keyed OR clause. The actor's role decides what `where` they get;
  // there is no client param that widens this (status is the only filter).
  // Capped at 500 rows to prevent OOM for actors with many tickets (SUPER_ADMIN
  // sees all orgs). Full pagination (take/skip/page/limit) is available on the
  // admin variant: listTicketsDetailed.
  async listTickets(actor: SupportActor, opts: { status?: string } = {}) {
    const where = this.scopeWhere(actor, opts.status)

    return this.prisma.ticket.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        order: {
          select: {
            id: true,
            title: true,
            status: true,
            type: true,
            fulfillmentChannel: true,
          },
        },
        assignedTo: { select: { id: true, name: true } },
        assignedPublisher: { select: { id: true, name: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 500,
    })
  }

  // Paginated + searchable variant used by the admin inbox — returns the same
  // visibility slice as listTickets, plus a message count. INTERNAL count is
  // included only for staff actors.
  async listTicketsDetailed(
    actor: SupportActor,
    params: {
      status?: string
      search?: string
      channel?: "PLATFORM" | "PUBLISHER"
      assignedToUserId?: string | "UNASSIGNED"
      page?: number
      limit?: number
    } = {},
  ) {
    const page = Math.max(params.page ?? 1, 1)
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)

    const where: any = this.scopeWhere(actor, params.status)
    if (params.search)
      where.subject = { contains: params.search, mode: "insensitive" }
    if (params.channel) {
      // Merge with the role-scoped where — for an OPS actor this further
      // narrows their already-scoped slice, never widens it.
      where.fulfillmentChannel = params.channel
    }
    if (params.assignedToUserId === "UNASSIGNED") {
      // Only valid for staff (the OR clause for OPS already includes the
      // unassigned-platform pool; SUPER_ADMIN/FINANCE see everything).
      where.assignedToUserId = null
    } else if (params.assignedToUserId) {
      where.assignedToUserId = params.assignedToUserId
    }

    // Staff can see INTERNAL message count; customers/publishers see only
    // their PUBLIC slice.
    const messageCountWhere = this.isStaff(actor)
      ? undefined
      : { visibility: "PUBLIC" as const }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.ticket.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true } },
          organization: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
          assignedPublisher: { select: { id: true, name: true } },
          order: {
            select: {
              id: true,
              title: true,
              status: true,
              type: true,
              fulfillmentChannel: true,
            },
          },
          _count: {
            select: {
              messages: messageCountWhere ? { where: messageCountWhere } : true,
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.ticket.count({ where }),
    ])

    return {
      items: rows.map((t: any) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        fulfillmentChannel: t.fulfillmentChannel,
        assignedTo: t.assignedTo
          ? { id: t.assignedTo.id, name: t.assignedTo.name }
          : null,
        assignedPublisher: t.assignedPublisher
          ? { id: t.assignedPublisher.id, name: t.assignedPublisher.name }
          : null,
        customer: { id: t.user.id, name: t.user.name, email: t.user.email },
        organization: t.organization
          ? { id: t.organization.id, name: t.organization.name }
          : null,
        order: t.order,
        messageCount: t._count.messages,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    }
  }

  // ── getTicket ───────────────────────────────────────────────────────────
  // Filters INTERNAL messages from the response for non-staff actors. Staff
  // see every message regardless of visibility.
  async getTicket(id: string, actor: SupportActor) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, userType: true } },
        organization: { select: { id: true, name: true } },
        messages: {
          where: this.isStaff(actor) ? undefined : { visibility: "PUBLIC" },
          include: {
            user: {
              select: { id: true, name: true, email: true, userType: true },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        order: {
          select: {
            id: true,
            title: true,
            status: true,
            type: true,
            fulfillmentChannel: true,
          },
        },
        assignedTo: { select: { id: true, name: true } },
        assignedPublisher: { select: { id: true, name: true } },
      },
    })
    if (!ticket) throw new NotFoundException("Ticket not found")
    await this.assertVisible(actor, ticket)
    return ticket
  }

  // ── addMessage ──────────────────────────────────────────────────────────
  // Visibility defaults to PUBLIC for backwards compatibility. The reply
  // matrix is enforced per channel + role + visibility. Phase 6.6.1:
  // participantRole + messageType are derived server-side from the actor and
  // snapshotted onto the row — never derived dynamically at render time.
  async addMessage(
    ticketId: string,
    actor: SupportActor,
    data: { content: string; visibility?: Visibility },
  ) {
    const visibility: Visibility = data.visibility ?? "PUBLIC"

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
    })
    if (!ticket) throw new NotFoundException("Ticket not found")
    await this.assertCanReply(actor, ticket, visibility)

    if (!data.content?.trim()) {
      throw new BadRequestException("Message content is required")
    }

    // Snapshot the role-at-write-time. INTERNAL → INTERNAL_NOTE, PUBLIC →
    // MESSAGE. SYSTEM_EVENT is reserved for the future emitSystemEvent path
    // (status transitions, reassignments) — humans never write it.
    const participantRole = resolveParticipantRole(actor)
    const messageType: MessageType =
      visibility === "INTERNAL" ? "INTERNAL_NOTE" : "MESSAGE"
    // Phase 6.6.2: uncollapsed role snapshot for forensic queries.
    const actorSnapshot = buildActorSnapshot(actor)

    const message = await this.prisma.ticketMessage.create({
      data: {
        content: data.content.trim(),
        userId: actor.userId,
        ticketId,
        visibility,
        participantRole,
        messageType,
        actorSnapshot: actorSnapshot as any,
      },
    })

    // Touch updatedAt so the inbox sort surfaces this ticket.
    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { updatedAt: new Date() },
    })

    await this.audit.log({
      action:
        visibility === "INTERNAL"
          ? "TICKET_INTERNAL_NOTE_ADDED"
          : "TICKET_MESSAGE_ADDED",
      entityType: "Ticket",
      entityId: ticketId,
      metadata: {
        orderId: ticket.orderId,
        fulfillmentChannel: ticket.fulfillmentChannel,
        actorKind: actor.kind,
        actorStaffRole: actor.staffRole ?? null,
        // Phase 6.6.1 — the value reports + dispute review will key off. Same
        // string the row carries, so audit + row never drift.
        participantRole,
        messageType,
        visibility,
        // Phase 6.6.2 — uncollapsed role snapshot. Mirrors the column so
        // audit-log readers don't have to join TicketMessage to answer
        // "what authority did this person have?".
        actorSnapshot,
      },
      userId: actor.userId,
      organizationId: ticket.organizationId,
    })

    await this.fanOutTicketEvent(
      ticketId,
      visibility === "INTERNAL" ? "SUPPORT_INTERNAL_NOTE" : "SUPPORT_REPLY",
      visibility === "INTERNAL"
        ? `Internal note added on: ${ticket.subject}`
        : `New reply on ticket: ${ticket.subject}`,
      actor.userId,
      visibility,
    )

    return message
  }

  // ── updateStatus ────────────────────────────────────────────────────────
  // Status changes are surface-level (no money implications), but the actor
  // still needs reply-tier access on the ticket so we don't let a stranger
  // close someone else's thread. PUBLIC visibility is used for the gate
  // (status changes are inherently customer-visible).
  async updateStatus(ticketId: string, status: string, actor: SupportActor) {
    const valid = [
      "OPEN",
      "IN_PROGRESS",
      "WAITING_ON_CUSTOMER",
      "RESOLVED",
      "CLOSED",
    ]
    if (!valid.includes(status)) {
      throw new BadRequestException(
        `Invalid status — must be one of ${valid.join(", ")}`,
      )
    }
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
    })
    if (!ticket) throw new NotFoundException("Ticket not found")
    await this.assertCanReply(actor, ticket, "PUBLIC")

    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { status: status as any },
    })

    await this.audit.log({
      action: "SUPPORT_TICKET_STATUS_CHANGED",
      entityType: "Ticket",
      entityId: ticketId,
      metadata: {
        from: ticket.status,
        to: status,
        actorKind: actor.kind,
        actorStaffRole: actor.staffRole ?? null,
      },
      userId: actor.userId,
      organizationId: ticket.organizationId,
    })

    // Notify the customer who opened the ticket — public-visible state change.
    await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
      userId: ticket.userId,
      organizationId: ticket.organizationId,
      type: "SUPPORT_TICKET_UPDATED",
      message: `Your support ticket "${ticket.subject}" is now ${status.replace(/_/g, " ").toLowerCase()}.`,
    })

    return updated
  }

  // ── Admin reassignment of a single ticket ───────────────────────────────
  // Visibility migration only — historical messages stay where they were.
  async reassignTicket(
    ticketId: string,
    body: {
      assignedToUserId?: string | null
      assignedPublisherId?: string | null
      reason?: string
    },
    staff: { userId: string; staffRole: StaffRole | null },
  ) {
    if (staff.staffRole !== "SUPER_ADMIN") {
      throw new ForbiddenException("Only SUPER_ADMIN can reassign tickets")
    }
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
    })
    if (!ticket) throw new NotFoundException("Ticket not found")

    if (body.assignedToUserId) {
      const target = await this.prisma.staffMembership.findUnique({
        where: { userId: body.assignedToUserId },
        select: { role: true },
      })
      if (target?.role !== "OPERATIONS") {
        throw new BadRequestException({
          code: "INVALID_OWNER",
          message: "assignedToUserId must be an OPERATIONS staff member",
        })
      }
    }
    if (body.assignedPublisherId) {
      const pub = await this.prisma.publisher.findUnique({
        where: { id: body.assignedPublisherId },
        select: { id: true },
      })
      if (!pub) throw new BadRequestException("Publisher not found")
    }

    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        assignedToUserId: body.assignedToUserId ?? null,
        assignedPublisherId: body.assignedPublisherId ?? null,
      },
    })

    await this.audit.log({
      action: "TICKET_REASSIGNED",
      entityType: "Ticket",
      entityId: ticketId,
      metadata: {
        fromAssignedToUserId: ticket.assignedToUserId,
        toAssignedToUserId: body.assignedToUserId ?? null,
        fromAssignedPublisherId: ticket.assignedPublisherId,
        toAssignedPublisherId: body.assignedPublisherId ?? null,
        reason: body.reason ?? null,
      },
      userId: staff.userId,
      organizationId: ticket.organizationId,
    })

    return this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────────────────────────────────

  private isStaff(actor: SupportActor): boolean {
    return actor.kind === "STAFF"
  }

  private scopeWhere(actor: SupportActor, status?: string) {
    const where: any = {}
    if (status) where.status = status

    switch (actor.kind) {
      case "CUSTOMER":
        if (!actor.organizationId)
          throw new ForbiddenException("Missing organization context")
        where.organizationId = actor.organizationId
        break
      case "PUBLISHER":
        if (!actor.publisherId)
          throw new ForbiddenException("Missing publisher context")
        where.assignedPublisherId = actor.publisherId
        break
      case "STAFF":
        if (actor.staffRole === "OPERATIONS") {
          where.OR = [
            { assignedToUserId: actor.userId },
            { assignedToUserId: null, fulfillmentChannel: "PLATFORM" },
          ]
        }
        // SUPER_ADMIN + FINANCE see everything (audit + monitoring).
        break
    }
    return where
  }

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
          const isUnassignedPlatform =
            ticket.assignedToUserId === null &&
            ticket.fulfillmentChannel === "PLATFORM"
          if (!isOwn && !isUnassignedPlatform)
            throw new NotFoundException("Ticket not found")
        }
        // SUPER_ADMIN + FINANCE: all visible (read for audit/monitoring).
        return
    }
  }

  // ── The Phase 6.6 matrix, applied to a single ticket + intended visibility.
  // Splits cleanly along three axes: actor kind, channel, intended visibility.
  private async assertCanReply(
    actor: SupportActor,
    ticket: any,
    visibility: Visibility,
  ) {
    await this.assertVisible(actor, ticket)

    // Customers and publishers can never write INTERNAL — that's the whole
    // point of the visibility scope.
    if (
      visibility === "INTERNAL" &&
      (actor.kind === "CUSTOMER" || actor.kind === "PUBLISHER")
    ) {
      throw new ForbiddenException("Only staff can post internal notes")
    }

    if (actor.kind === "CUSTOMER") {
      // Org match was already enforced by assertVisible.
      return
    }
    if (actor.kind === "PUBLISHER") {
      // Publisher membership was already enforced. Publishers cannot reply on
      // PLATFORM tickets (they are not on the visibility list), and
      // assertVisible already refused.
      return
    }
    if (actor.kind === "STAFF") {
      const channel = ticket.fulfillmentChannel as
        | "PUBLISHER"
        | "PLATFORM"
        | null
      switch (actor.staffRole) {
        case "SUPER_ADMIN":
          // Universal participant — can write PUBLIC and INTERNAL anywhere.
          return
        case "FINANCE":
          // PUBLISHER channel: full participant.
          // PLATFORM channel: read-only on customer thread; INTERNAL notes allowed.
          if (channel === "PLATFORM" && visibility === "PUBLIC") {
            throw new ForbiddenException(
              "FINANCE cannot post public replies on PLATFORM tickets — escalate to SUPER_ADMIN or Ops, or post an internal note",
            )
          }
          return
        case "OPERATIONS":
          // Only on tickets they actually own. Unassigned-platform pool is
          // read-only until SUPER_ADMIN reassigns the ticket to them.
          if (ticket.assignedToUserId !== actor.userId) {
            throw new ForbiddenException(
              "Unassigned platform tickets are read-only until claimed",
            )
          }
          return
        default:
          throw new ForbiddenException("Unknown staff role")
      }
    }
    throw new ForbiddenException("Cannot reply to this ticket")
  }

  // ── Channel-aware notification fan-out ──────────────────────────────────
  // Recipient sets are computed at send time so a paused / removed member is
  // dropped immediately. The Map is keyed on userId (string) so a user
  // holding multiple roles still gets one notification per event — fixes the
  // Set<object>-identity duplicate bug from the audit.
  private async fanOutTicketEvent(
    ticketId: string,
    type: string,
    message: string,
    excludeUserId: string,
    visibility: Visibility,
  ) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        organization: {
          include: { memberships: { where: { status: "ACTIVE" } } },
        },
        assignedPublisher: { include: { publisherMemberships: true } },
      },
    })
    if (!ticket) return

    // userId -> organizationId (for the notification's tenant scope).
    const recipients = new Map<string, string | null>()
    const add = (userId: string, organizationId: string | null) => {
      if (userId === excludeUserId) return
      if (recipients.has(userId)) return
      recipients.set(userId, organizationId)
    }

    const channel = ticket.fulfillmentChannel as "PUBLISHER" | "PLATFORM" | null
    const isInternal = visibility === "INTERNAL"

    // Customer side — only on PUBLIC events. INTERNAL notes are invisible to
    // the customer and so are their notifications.
    if (!isInternal) {
      for (const m of ticket.organization.memberships) {
        add(m.userId, ticket.organizationId)
      }
    }

    // Publisher side — PUBLISHER channel only, only on PUBLIC events.
    if (!isInternal && channel === "PUBLISHER" && ticket.assignedPublisher) {
      for (const m of ticket.assignedPublisher.publisherMemberships) {
        add(m.userId, null)
      }
    }

    // Assigned Ops user — PLATFORM channel. Notified on both PUBLIC and
    // INTERNAL (they are the operational owner and need full thread context).
    if (channel === "PLATFORM" && ticket.assignedToUserId) {
      add(ticket.assignedToUserId, null)
    }

    // SUPER_ADMIN — universal participant. Notified on every event.
    const superAdmins = await this.prisma.staffMembership.findMany({
      where: { role: "SUPER_ADMIN" },
      select: { userId: true },
    })
    for (const sm of superAdmins) add(sm.userId, null)

    // FINANCE — channel-dependent fan-out:
    //   PUBLISHER channel: full participant on PUBLIC + INTERNAL.
    //   PLATFORM  channel: read-only on customer thread (no PUBLIC ping);
    //                      INTERNAL pings to keep them in the loop.
    if (channel === "PUBLISHER" || isInternal) {
      const finance = await this.prisma.staffMembership.findMany({
        where: { role: "FINANCE" },
        select: { userId: true },
      })
      for (const sm of finance) add(sm.userId, null)
    }

    for (const [userId, organizationId] of recipients) {
      await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
        userId,
        organizationId,
        type,
        message,
      })
    }
  }
}
