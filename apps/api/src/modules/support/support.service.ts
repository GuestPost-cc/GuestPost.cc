import { createHash } from "node:crypto"
import { Prisma } from "@guestpost/database"
import { QUEUES, runSerializableTransactionWithRetry } from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { CommunicationsService } from "../communications/communications.service"
import { QueueService } from "../queues/queue.service"
import {
  isOperationsPlatformSupportTicket,
  operationsPlatformSupportWhere,
} from "./support-routing"

// Phase 6.6: tickets are channel-aware. The participant matrix below is the
// single source of truth — admin-route handlers delegate here so the matrix
// is enforced through one code path.
//
//   PUBLISHER channel
//     Customer org members           R + W(PUBLIC)
//     Publisher org members          R + W(PUBLIC)
//     SUPER_ADMIN                    R + W(PUBLIC, INTERNAL)
//
//   PLATFORM channel
//     Customer org members           R + W(PUBLIC)
//     Assigned Operations           R + W(PUBLIC, INTERNAL)
//     SUPER_ADMIN                    R + W(PUBLIC, INTERNAL)
//
// INTERNAL messages are never returned to CUSTOMER or PUBLISHER actors — they
// are filtered server-side in `getTicket` and `listTicketsDetailed`. The UI
// is decorative; this server filter is the source of truth.
//
// Order-linked Platform assignment follows the authoritative active order
// fulfillment assignment. Publisher routing is derived from the linked order
// at creation and cannot be nominated by a client.

type ActorKind = "CUSTOMER" | "PUBLISHER" | "STAFF"
type StaffRole = "SUPER_ADMIN" | "OPERATIONS" | "FINANCE"
type CustomerRole = "OWNER" | "MEMBER"
type PublisherRole = "PUBLISHER_OWNER" | "PUBLISHER_MEMBER"
type Visibility = "PUBLIC" | "INTERNAL"
type ParticipantRole = "CUSTOMER" | "PUBLISHER" | "OPS" | "ADMIN" | "FINANCE"
type MessageType = "MESSAGE" | "INTERNAL_NOTE" | "SYSTEM_EVENT"
type TicketStatus =
  | "OPEN"
  | "IN_PROGRESS"
  | "WAITING_ON_CUSTOMER"
  | "RESOLVED"
  | "CLOSED"
type SenderParty = "CUSTOMER" | "PUBLISHER" | "SUPPORT" | "SYSTEM"

const VALID_TICKET_STATUSES: readonly TicketStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_ON_CUSTOMER",
  "RESOLVED",
  "CLOSED",
]
const TERMINAL_PUBLIC_REPLY_STATUSES: readonly TicketStatus[] = [
  "RESOLVED",
  "CLOSED",
]
const ACTIVE_FULFILLMENT_ASSIGNMENT_STATUSES = [
  "ASSIGNED",
  "IN_PROGRESS",
] as const
const POST_FULFILLMENT_SUPPORT_ORDER_STATUSES = [
  "PUBLISHED",
  "VERIFIED",
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
  "REFUNDED",
] as const
const POST_FULFILLMENT_DISPUTE_PREVIOUS_STATUSES = [
  "PUBLISHED",
  "VERIFIED",
  "DELIVERED",
  "COMPLETED",
] as const
const MESSAGE_PAGE_LIMIT = 200
const UNSAFE_SUPPORT_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export interface TicketSenderDto {
  party: SenderParty
  displayName: string
  isSelf: boolean
}

export interface TicketCapabilitiesDto {
  canReply: boolean
  canClose: boolean
  canReopen: boolean
  canPostInternal: boolean
  canClaim: boolean
  canReassign: boolean
  allowedVisibilities: Visibility[]
  allowedStatuses: TicketStatus[]
  readOnlyReason: string | null
}

export interface TicketMessageDto {
  id: string
  content: string
  visibility: Visibility
  messageType: MessageType
  createdAt: Date
  sender: TicketSenderDto
  participantRole?: ParticipantRole
  actorSnapshot?: ActorSnapshot | null
  authorEvidence?: {
    displayName: string
    userId?: string
    email?: string
  } | null
}

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

interface TicketFanOut {
  communicationEventId: string | null
  legacyRecipients: Array<{ userId: string; organizationId: string | null }>
  legacyType: string
  message: string
}

function normalizeSupportText(
  value: string,
  field: string,
  maxLength: number,
): string {
  const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n").trim()
  if (!normalized) {
    throw new BadRequestException(`${field} is required`)
  }
  if (normalized.length > maxLength) {
    throw new BadRequestException(`${field} is too long`)
  }
  if (UNSAFE_SUPPORT_CONTROL_CHARACTERS.test(normalized)) {
    throw new BadRequestException(
      `${field} contains unsupported control characters`,
    )
  }
  return normalized
}

function deterministicMessageId(
  actorUserId: string,
  ticketId: string,
  clientMessageId: string,
): string {
  const digest = createHash("sha256")
    .update("support-message-v1\0")
    .update(actorUserId)
    .update("\0")
    .update(ticketId)
    .update("\0")
    .update(clientMessageId)
    .digest("hex")
  return `sm_${digest.slice(0, 40)}`
}

function deterministicTicketId(
  actorUserId: string,
  clientRequestId: string,
): string {
  const digest = createHash("sha256")
    .update("support-ticket-v1\0")
    .update(actorUserId)
    .update("\0")
    .update(clientRequestId)
    .digest("hex")
  return `st_${digest.slice(0, 40)}`
}

function assertClientUuid(value: string, field: string): void {
  if (!UUID_V4.test(value)) {
    throw new BadRequestException(`${field} must be a UUID v4`)
  }
}

function encodeMessageCursor(message: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      at: message.createdAt.toISOString(),
      id: message.id,
    }),
    "utf8",
  ).toString("base64url")
}

function decodeMessageCursor(
  cursor?: string,
): { createdAt: Date; id: string } | null {
  if (!cursor) return null
  if (cursor.length > 512) {
    throw new BadRequestException("Invalid message cursor")
  }
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    const createdAt = new Date(value?.at)
    if (
      value?.v !== 1 ||
      typeof value?.id !== "string" ||
      value.id.length < 1 ||
      value.id.length > 100 ||
      !Number.isFinite(createdAt.getTime())
    ) {
      throw new Error("invalid")
    }
    return { createdAt, id: value.id }
  } catch {
    throw new BadRequestException("Invalid message cursor")
  }
}

function encodeTicketCursor(row: {
  publicActivityAt: Date
  id: string
}): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      at: row.publicActivityAt.toISOString(),
      id: row.id,
    }),
    "utf8",
  ).toString("base64url")
}

function decodeTicketCursor(
  cursor?: string,
): { publicActivityAt: Date; id: string } | null {
  if (!cursor) return null
  if (cursor.length > 512) {
    throw new BadRequestException("Invalid ticket cursor")
  }
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    const publicActivityAt = new Date(value?.at)
    if (
      value?.v !== 1 ||
      typeof value?.id !== "string" ||
      !/^[a-z0-9_-]{1,191}$/iu.test(value.id) ||
      !Number.isFinite(publicActivityAt.getTime())
    ) {
      throw new Error("invalid")
    }
    return { publicActivityAt, id: value.id }
  } catch {
    throw new BadRequestException("Invalid ticket cursor")
  }
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
    @Optional() private readonly communications?: CommunicationsService,
  ) {}

  // ── createTicket ────────────────────────────────────────────────────────
  // Customer tickets may be general Platform-support requests or order-linked.
  // Publisher tickets must be linked to a PUBLISHER-channel order currently
  // owned by the actor's active publisher. All tenant/routing facts are derived
  // from the locked Order row; clients never nominate a tenant or assignee.
  async createTicket(
    actor: SupportActor,
    data: {
      subject: string
      description: string
      orderId?: string
      clientRequestId: string
    },
  ) {
    const subject = normalizeSupportText(data.subject, "Subject", 200)
    if (subject.length < 3) {
      throw new BadRequestException("Subject must be at least 3 characters")
    }
    const description = normalizeSupportText(
      data.description,
      "Description",
      10_000,
    )
    if (description.length < 10) {
      throw new BadRequestException(
        "Description must be at least 10 characters",
      )
    }
    assertClientUuid(data.clientRequestId, "clientRequestId")
    const ticketId = deterministicTicketId(actor.userId, data.clientRequestId)

    if (actor.kind === "STAFF") {
      throw new ForbiddenException("Staff cannot open tickets on this route")
    }
    if (actor.kind === "PUBLISHER" && !data.orderId) {
      throw new BadRequestException(
        "Publisher support tickets must reference an authorized order",
      )
    }

    const committed = await runSerializableTransactionWithRetry(
      this.prisma,
      async (tx: any) => {
        await this.assertActorAuthorityInTransaction(tx, actor)
        // Serialize actor-bound request-key replays before checking the
        // deterministic primary key. Catching a unique violation is unsafe in
        // PostgreSQL because it aborts the surrounding transaction.
        await tx.$queryRaw`SELECT "id" FROM public."User" WHERE "id" = ${actor.userId} FOR UPDATE`

        let organizationId: string
        let fulfillmentChannel: "PUBLISHER" | "PLATFORM"
        let assignedToUserId: string | null = null
        let assignedPublisherId: string | null = null

        if (data.orderId) {
          await tx.$queryRaw`SELECT "id" FROM public."Order" WHERE "id" = ${data.orderId} FOR UPDATE`
          const order = await tx.order.findUnique({
            where: { id: data.orderId },
            include: {
              website: {
                select: { publisherId: true, ownershipType: true },
              },
            },
          })
          if (!order) throw new NotFoundException("Order not found")

          const channel =
            order.fulfillmentChannel ??
            (order.website?.ownershipType === "PLATFORM"
              ? "PLATFORM"
              : "PUBLISHER")

          if (actor.kind === "CUSTOMER") {
            if (
              !actor.organizationId ||
              order.organizationId !== actor.organizationId
            ) {
              throw new NotFoundException("Order not found")
            }
          } else if (
            channel !== "PUBLISHER" ||
            !actor.publisherId ||
            order.website?.publisherId !== actor.publisherId
          ) {
            throw new NotFoundException("Order not found")
          }

          organizationId = order.organizationId
          fulfillmentChannel = channel
          if (channel === "PLATFORM") {
            assignedToUserId = await this.resolveOrderSupportOwner(tx, order.id)
          } else {
            assignedPublisherId = order.website?.publisherId ?? null
            if (!assignedPublisherId) {
              throw new ConflictException(
                "Order publisher routing is unavailable; contact support",
              )
            }
          }
        } else {
          if (actor.kind !== "CUSTOMER" || !actor.organizationId) {
            throw new ForbiddenException(
              "Missing customer organization context",
            )
          }
          organizationId = actor.organizationId
          fulfillmentChannel = "PLATFORM"
        }

        const replay = await tx.ticket.findUnique({ where: { id: ticketId } })
        if (replay) {
          if (
            replay.userId !== actor.userId ||
            replay.organizationId !== organizationId ||
            replay.orderId !== (data.orderId ?? null) ||
            replay.subject !== subject ||
            replay.description !== description
          ) {
            throw new ConflictException(
              "clientRequestId was already used with different ticket data",
            )
          }
          return { ticket: replay, fanOut: null }
        }

        const ticket = await tx.ticket.create({
          data: {
            id: ticketId,
            subject,
            description,
            userId: actor.userId,
            organizationId,
            orderId: data.orderId,
            fulfillmentChannel,
            assignedToUserId,
            assignedPublisherId,
          },
        })

        await this.audit.log(
          {
            action: "TICKET_OPENED",
            entityType: "Ticket",
            entityId: ticket.id,
            metadata: {
              orderId: data.orderId ?? null,
              fulfillmentChannel,
              assignedToUserId,
              assignedPublisherId,
              requesterKind: actor.kind,
            },
            userId: actor.userId,
            organizationId,
          },
          tx,
        )

        const fanOut = await this.fanOutTicketEvent(
          tx,
          ticket.id,
          "TICKET_OPENED",
          `New ticket: ${ticket.subject}`,
          actor.userId,
          "PUBLIC",
          ticket.id,
        )
        return { ticket, fanOut }
      },
    )
    if (committed.fanOut) {
      await this.dispatchTicketFanOut(committed.fanOut)
    }

    return {
      id: committed.ticket.id,
      status: committed.ticket.status,
      createdAt: committed.ticket.createdAt,
    }
  }

  // ── listTickets ─────────────────────────────────────────────────────────
  // External inbox keyset. Activity is latest PUBLIC message time (or ticket
  // creation), computed and filtered in SQL so INTERNAL work cannot reorder or
  // perturb a customer/publisher cursor.
  async listTickets(
    actor: SupportActor,
    opts: {
      status?: string
      orderId?: string
      cursor?: string
      limit?: number
    } = {},
  ) {
    this.assertValidStatusFilter(opts.status)
    const limit = opts.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException("limit must be an integer from 1 to 100")
    }
    const cursor = decodeTicketCursor(opts.cursor)
    const conditions: Prisma.Sql[] = []
    if (actor.kind === "CUSTOMER") {
      if (!actor.organizationId) {
        throw new ForbiddenException("Missing organization context")
      }
      conditions.push(
        Prisma.sql`ticket."organizationId" = ${actor.organizationId}`,
      )
    } else if (actor.kind === "PUBLISHER") {
      if (!actor.publisherId) {
        throw new ForbiddenException("Missing publisher context")
      }
      conditions.push(
        Prisma.sql`ticket."assignedPublisherId" = ${actor.publisherId}`,
        Prisma.sql`ticket."fulfillmentChannel" = 'PUBLISHER'::"FulfillmentChannel"`,
      )
    } else {
      throw new ForbiddenException("Use the staff support inbox")
    }
    if (opts.status) {
      conditions.push(
        Prisma.sql`ticket."status" = ${opts.status}::"TicketStatus"`,
      )
    }
    if (opts.orderId) {
      if (!/^[a-z0-9_-]{1,50}$/iu.test(opts.orderId)) {
        throw new BadRequestException("Invalid orderId filter")
      }
      conditions.push(Prisma.sql`ticket."orderId" = ${opts.orderId}`)
    }
    if (cursor) {
      conditions.push(Prisma.sql`(
        COALESCE(public_message."createdAt", ticket."createdAt") < ${cursor.publicActivityAt}
        OR (
          COALESCE(public_message."createdAt", ticket."createdAt") = ${cursor.publicActivityAt}
          AND ticket."id" > ${cursor.id}
        )
      )`)
    }

    return this.prisma.$transaction(
      async (tx: any) => {
        // Authority and every projected row share one MVCC snapshot. A
        // membership revocation therefore linearizes entirely before or after
        // this read instead of interleaving between the check and hydration.
        await this.assertActorAuthorityInTransaction(tx, actor)
        const activityRows = (await tx.$queryRaw(Prisma.sql`
          SELECT
            ticket."id",
            COALESCE(public_message."createdAt", ticket."createdAt") AS "publicActivityAt"
          FROM public."Ticket" AS ticket
          LEFT JOIN LATERAL (
            SELECT message."createdAt"
            FROM public."TicketMessage" AS message
            WHERE message."ticketId" = ticket."id"
              AND message."visibility" = 'PUBLIC'::"TicketMessageVisibility"
            ORDER BY message."createdAt" DESC, message."id" DESC
            LIMIT 1
          ) AS public_message ON TRUE
          WHERE ${Prisma.join(conditions, " AND ")}
          ORDER BY
            COALESCE(public_message."createdAt", ticket."createdAt") DESC,
            ticket."id" ASC
          LIMIT ${limit + 1}
        `)) as Array<{ id: string; publicActivityAt: Date }>
        const hasMore = activityRows.length > limit
        const pageRows = activityRows.slice(0, limit).map((row) => ({
          ...row,
          publicActivityAt: new Date(row.publicActivityAt),
        }))
        if (pageRows.length === 0) {
          return { items: [], nextCursor: null, limit }
        }
        const hydrateScope = this.scopeWhere(actor, opts.status)
        if (opts.orderId) hydrateScope.orderId = opts.orderId
        const tickets = await tx.ticket.findMany({
          // Reapply scope during hydration as defense in depth and to keep the
          // typed projector contract aligned with the raw keyset predicate.
          where: {
            AND: [{ id: { in: pageRows.map((row) => row.id) } }, hydrateScope],
          },
          include: {
            order: {
              select: {
                id: true,
                title: true,
                status: true,
                type: true,
                fulfillmentChannel: true,
              },
            },
          },
        })
        const ticketsById = new Map(tickets.map((row: any) => [row.id, row]))
        const items = pageRows.flatMap((row) => {
          const hydrated = ticketsById.get(row.id)
          return hydrated
            ? [
                this.projectTicketListItem(
                  hydrated,
                  actor,
                  row.publicActivityAt,
                ),
              ]
            : []
        })
        return {
          items,
          nextCursor: hasMore
            ? encodeTicketCursor(pageRows[pageRows.length - 1])
            : null,
          limit,
        }
      },
      { isolationLevel: "RepeatableRead" },
    )
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
      orderId?: string
      page?: number
      limit?: number
    } = {},
  ) {
    this.assertValidStatusFilter(params.status)
    const page = Math.max(params.page ?? 1, 1)
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)

    const where: any = this.scopeWhere(actor, params.status)
    if (params.search) {
      const search = normalizeSupportText(params.search, "Search", 200)
      where.subject = { contains: search, mode: "insensitive" }
    }
    if (params.channel) {
      // Intersect with the role scope instead of overwriting its authoritative
      // channel predicate. In particular, an Operations `channel=PUBLISHER`
      // filter must yield no rows rather than widening into publisher history.
      // PLATFORM also includes only the unambiguous legacy-general shape;
      // contradictory rows stay visible solely in the unfiltered Super Admin
      // audit view.
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        params.channel === "PLATFORM"
          ? operationsPlatformSupportWhere()
          : { fulfillmentChannel: "PUBLISHER" },
      ]
    }
    if (params.orderId) {
      if (!/^[a-z0-9_-]{1,50}$/iu.test(params.orderId)) {
        throw new BadRequestException("Invalid orderId filter")
      }
      where.orderId = params.orderId
    }
    if (params.assignedToUserId === "UNASSIGNED") {
      // Only valid for staff (the OR clause for OPS already includes the
      // unassigned-platform pool; SUPER_ADMIN sees every ticket).
      where.assignedToUserId = null
    } else if (params.assignedToUserId) {
      where.assignedToUserId = params.assignedToUserId
    }

    // Staff can see INTERNAL message count; customers/publishers see only
    // their PUBLIC slice.
    const messageCountWhere = this.isStaff(actor)
      ? undefined
      : { visibility: "PUBLIC" as const }

    return this.prisma.$transaction(
      async (tx: any) => {
        await this.assertActorAuthorityInTransaction(tx, actor)
        const [rows, total] = await Promise.all([
          tx.ticket.findMany({
            where,
            include: {
              user: {
                select: { id: true, name: true, email: true, userType: true },
              },
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
                  website: { select: { ownershipType: true } },
                  dispute: {
                    select: { status: true, previousStatus: true },
                  },
                  fulfillmentAssignments: {
                    where: {
                      status: {
                        in: [...ACTIVE_FULFILLMENT_ASSIGNMENT_STATUSES],
                      },
                    },
                    select: { id: true },
                    take: 1,
                  },
                },
              },
              _count: {
                select: {
                  messages: messageCountWhere
                    ? { where: messageCountWhere }
                    : true,
                },
              },
            },
            orderBy: { updatedAt: "desc" },
            take: limit,
            skip: (page - 1) * limit,
          }),
          tx.ticket.count({ where }),
        ])

        return {
          items: rows.map((ticket: any) =>
            this.projectStaffTicketListItem(ticket, actor),
          ),
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit) || 1,
        }
      },
      { isolationLevel: "RepeatableRead" },
    )
  }

  // ── getTicket ───────────────────────────────────────────────────────────
  // Filters INTERNAL messages from the response for non-staff actors. Staff
  // see every message regardless of visibility.
  async getTicket(
    id: string,
    actor: SupportActor,
    opts: { messageCursor?: string } = {},
  ) {
    const scope = this.scopeWhere(actor)
    const cursor = decodeMessageCursor(opts.messageCursor)
    const messageWhere: any = {
      ...(this.isStaff(actor) ? {} : { visibility: "PUBLIC" }),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    }
    return this.prisma.$transaction(
      async (tx: any) => {
        await this.assertActorAuthorityInTransaction(tx, actor)
        const ticket = await tx.ticket.findFirst({
          where: { AND: [{ id }, scope] },
          include: {
            user: {
              select: { id: true, name: true, email: true, userType: true },
            },
            organization: { select: { id: true, name: true } },
            messages: {
              // Visibility is applied in the same predicate as the keyset
              // cursor, so an INTERNAL row never consumes or perturbs an
              // external page.
              where: messageWhere,
              include: {
                user: {
                  select: { id: true, name: true, email: true, userType: true },
                },
              },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: MESSAGE_PAGE_LIMIT + 1,
            },
            order: {
              select: {
                id: true,
                title: true,
                status: true,
                type: true,
                fulfillmentChannel: true,
                website: { select: { ownershipType: true } },
                dispute: { select: { status: true, previousStatus: true } },
                fulfillmentAssignments: {
                  where: {
                    status: {
                      in: [...ACTIVE_FULFILLMENT_ASSIGNMENT_STATUSES],
                    },
                  },
                  select: { id: true },
                  take: 1,
                },
              },
            },
            assignedTo: { select: { id: true, name: true } },
            assignedPublisher: { select: { id: true, name: true } },
          },
        })
        if (!ticket) throw new NotFoundException("Ticket not found")
        await this.assertVisible(actor, ticket)
        const hasMore = ticket.messages.length > MESSAGE_PAGE_LIMIT
        const pageDescending = ticket.messages.slice(0, MESSAGE_PAGE_LIMIT)
        const nextCursor = hasMore
          ? encodeMessageCursor(pageDescending[pageDescending.length - 1])
          : null
        const publicActivity =
          actor.kind === "STAFF"
            ? null
            : await tx.ticketMessage.findFirst({
                where: { ticketId: ticket.id, visibility: "PUBLIC" },
                select: { createdAt: true },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              })
        return this.projectTicketDetail(
          { ...ticket, messages: pageDescending },
          actor,
          nextCursor,
          publicActivity?.createdAt ?? ticket.createdAt,
        )
      },
      { isolationLevel: "RepeatableRead" },
    )
  }

  // ── addMessage ──────────────────────────────────────────────────────────
  // Visibility defaults to PUBLIC for backwards compatibility. The reply
  // matrix is enforced per channel + role + visibility. Phase 6.6.1:
  // participantRole + messageType are derived server-side from the actor and
  // snapshotted onto the row — never derived dynamically at render time.
  async addMessage(
    ticketId: string,
    actor: SupportActor,
    data: {
      content: string
      visibility?: Visibility
      clientMessageId: string
    },
  ) {
    const visibility: Visibility = data.visibility ?? "PUBLIC"
    const content = normalizeSupportText(
      data.content,
      "Message content",
      10_000,
    )
    assertClientUuid(data.clientMessageId, "clientMessageId")
    const messageId = deterministicMessageId(
      actor.userId,
      ticketId,
      data.clientMessageId,
    )

    const { message, fanOut } = await runSerializableTransactionWithRetry(
      this.prisma,
      async (tx: any) => {
        const ticket = await this.lockTicket(tx, ticketId)
        if (!ticket) throw new NotFoundException("Ticket not found")
        await this.assertActorAuthorityInTransaction(tx, actor)
        await this.assertCanReply(actor, ticket, visibility)

        const replay = await tx.ticketMessage.findUnique({
          where: { id: messageId },
          include: {
            user: {
              select: { id: true, name: true, email: true, userType: true },
            },
          },
        })
        if (replay) {
          if (
            replay.ticketId !== ticketId ||
            replay.userId !== actor.userId ||
            replay.content !== content ||
            replay.visibility !== visibility
          ) {
            throw new ConflictException(
              "clientMessageId was already used with different message data",
            )
          }
          return { message: replay, fanOut: null }
        }

        if (
          visibility === "PUBLIC" &&
          TERMINAL_PUBLIC_REPLY_STATUSES.includes(ticket.status)
        ) {
          throw new ConflictException(
            `Ticket must be reopened before posting a public reply from ${ticket.status}`,
          )
        }

        const participantRole = resolveParticipantRole(actor)
        const messageType: MessageType =
          visibility === "INTERNAL" ? "INTERNAL_NOTE" : "MESSAGE"
        const actorSnapshot = buildActorSnapshot(actor)
        const message = await tx.ticketMessage.create({
          data: {
            id: messageId,
            content,
            userId: actor.userId,
            ticketId,
            visibility,
            participantRole,
            messageType,
            actorSnapshot: actorSnapshot as any,
          },
          include: {
            user: {
              select: { id: true, name: true, email: true, userType: true },
            },
          },
        })

        // Every staff-visible activity updates Ticket.updatedAt for inbox
        // ordering. External list/detail timestamps are independently derived
        // from PUBLIC messages, so INTERNAL work remains invisible there.
        await tx.ticket.update({
          where: { id: ticketId },
          data: { updatedAt: new Date() },
        })

        await this.audit.log(
          {
            action:
              visibility === "INTERNAL"
                ? "TICKET_INTERNAL_NOTE_ADDED"
                : "TICKET_MESSAGE_ADDED",
            entityType: "TicketMessage",
            entityId: message.id,
            metadata: {
              ticketId,
              orderId: ticket.orderId,
              fulfillmentChannel: ticket.fulfillmentChannel,
              actorKind: actor.kind,
              actorStaffRole: actor.staffRole ?? null,
              participantRole,
              messageType,
              visibility,
              actorSnapshot,
            },
            userId: actor.userId,
            organizationId: ticket.organizationId,
          },
          tx,
        )

        const fanOut = await this.fanOutTicketEvent(
          tx,
          ticketId,
          visibility === "INTERNAL" ? "SUPPORT_INTERNAL_NOTE" : "SUPPORT_REPLY",
          visibility === "INTERNAL"
            ? `Internal note added on: ${ticket.subject}`
            : `New reply on ticket: ${ticket.subject}`,
          actor.userId,
          visibility,
          message.id,
        )
        return { message, fanOut }
      },
    )
    if (fanOut) await this.dispatchTicketFanOut(fanOut)

    return this.projectMessage(message, actor)
  }

  // Staff status command. External callers use updateExternalStatus below and
  // can only close or reopen; they never control operational workflow states.
  async updateStatus(ticketId: string, status: string, actor: SupportActor) {
    if (!VALID_TICKET_STATUSES.includes(status as TicketStatus)) {
      throw new BadRequestException(
        `Invalid status — must be one of ${VALID_TICKET_STATUSES.join(", ")}`,
      )
    }
    if (actor.kind !== "STAFF") {
      throw new ForbiddenException("Staff authority required")
    }
    return this.transitionStatus(ticketId, status as TicketStatus, actor, false)
  }

  async updateExternalStatus(
    ticketId: string,
    status: "OPEN" | "CLOSED",
    actor: SupportActor,
  ) {
    if (actor.kind === "STAFF") {
      throw new ForbiddenException("External participant authority required")
    }
    return this.transitionStatus(ticketId, status, actor, true)
  }

  // ── Admin reassignment of a Platform-support ticket ─────────────────────
  // Active/claimable order ownership remains authoritative on
  // FulfillmentAssignment. Once fulfillment is irreversibly past that stage,
  // Super Admin may reassign only the support conversation so Operations
  // offboarding cannot dead-end. This command never mutates fulfillment.
  async reassignTicket(
    ticketId: string,
    body: {
      assignedToUserId: string | null
      expectedAssignedToUserId: string | null
      reason: string
    },
    staff: SupportActor,
  ) {
    if (staff.kind !== "STAFF" || staff.staffRole !== "SUPER_ADMIN") {
      throw new ForbiddenException("Only SUPER_ADMIN can reassign tickets")
    }
    const reason = normalizeSupportText(body.reason, "Reason", 2_000)
    if (reason.length < 10) {
      throw new BadRequestException("Reason must be at least 10 characters")
    }

    const committed = await runSerializableTransactionWithRetry(
      this.prisma,
      async (tx: any) => {
        const { ticket, order } = await this.lockTicketOwnershipContext(
          tx,
          ticketId,
        )
        await this.assertActorAuthorityInTransaction(tx, staff)
        if (!isOperationsPlatformSupportTicket(ticket)) {
          throw new ConflictException(
            "Only clean Platform-support tickets can be reassigned here",
          )
        }
        if (!this.canManageOrderTicketIndependently(ticket, order)) {
          throw new ConflictException(
            "Active or claimable order-linked tickets must be reassigned through fulfillment assignment",
          )
        }
        if (ticket.assignedToUserId !== body.expectedAssignedToUserId) {
          throw new ConflictException({
            code: "TICKET_ASSIGNMENT_CHANGED",
            message:
              "Ticket assignment changed. Refresh the ticket before reassigning it.",
          })
        }
        if (ticket.assignedToUserId === body.assignedToUserId) {
          throw new ConflictException("Ticket already has that assignment")
        }

        let targetName = "Unassigned Operations queue"
        if (body.assignedToUserId) {
          const target = await tx.staffMembership.findUnique({
            where: { userId: body.assignedToUserId },
            select: {
              role: true,
              user: {
                select: { name: true, banned: true, userType: true },
              },
            },
          })
          if (
            target?.role !== "OPERATIONS" ||
            target.user.banned ||
            target.user.userType !== "STAFF"
          ) {
            throw new BadRequestException({
              code: "INVALID_OWNER",
              message:
                "assignedToUserId must reference an active Operations staff member",
            })
          }
          targetName = target.user.name ?? "Operations staff"
        }

        const updated = await tx.ticket.update({
          where: { id: ticketId },
          data: { assignedToUserId: body.assignedToUserId },
        })
        const systemEvent = await this.createSystemEvent(
          tx,
          ticket,
          staff,
          "INTERNAL",
          body.assignedToUserId
            ? `Ticket assigned to ${targetName}.`
            : "Ticket returned to the unassigned Operations queue.",
        )

        await this.audit.log(
          {
            action: "TICKET_REASSIGNED",
            entityType: "Ticket",
            entityId: ticketId,
            metadata: {
              fromAssignedToUserId: ticket.assignedToUserId,
              toAssignedToUserId: body.assignedToUserId,
              ownershipMode: ticket.orderId
                ? "POST_FULFILLMENT_TICKET_ONLY"
                : "GENERAL_SUPPORT",
              orderId: ticket.orderId,
              orderStatus: order?.status ?? null,
              effectiveOrderStatus:
                order?.status === "DISPUTED"
                  ? (order.dispute?.previousStatus ?? null)
                  : (order?.status ?? null),
              disputeStatus: order?.dispute?.status ?? null,
              disputePreviousStatus: order?.dispute?.previousStatus ?? null,
              reason,
              systemEventId: systemEvent.id,
            },
            userId: staff.userId,
            organizationId: ticket.organizationId,
          },
          tx,
        )
        const fanOut = await this.fanOutTicketEvent(
          tx,
          ticketId,
          "SUPPORT_INTERNAL_NOTE",
          `Support ticket assignment changed: ${ticket.subject}`,
          staff.userId,
          "INTERNAL",
          systemEvent.id,
        )
        return { updated, fanOut, targetName, order }
      },
    )
    await this.dispatchTicketFanOut(committed.fanOut)
    return {
      id: committed.updated.id,
      assignedTo: body.assignedToUserId
        ? {
            displayName: committed.targetName,
            userId: body.assignedToUserId,
          }
        : null,
      capabilities: this.buildCapabilities(staff, {
        ...committed.updated,
        order: committed.order,
      }),
    }
  }

  // Operations may self-claim a general unassigned ticket. An order-linked
  // ticket is claimable independently only after fulfillment is no longer
  // claimable and no active order assignment exists. This is a ticket-only
  // ownership command; it never creates or mutates FulfillmentAssignment.
  async claimTicket(ticketId: string, actor: SupportActor) {
    if (actor.kind !== "STAFF" || actor.staffRole !== "OPERATIONS") {
      throw new ForbiddenException("Operations authority required")
    }
    const committed = await runSerializableTransactionWithRetry(
      this.prisma,
      async (tx: any) => {
        const { ticket, order } = await this.lockTicketOwnershipContext(
          tx,
          ticketId,
        )
        await this.assertActorAuthorityInTransaction(tx, actor)
        if (!isOperationsPlatformSupportTicket(ticket)) {
          throw new ConflictException(
            "Only Platform-support tickets can be claimed by Operations",
          )
        }
        if (ticket.assignedToUserId) {
          throw new ConflictException("Ticket is already assigned")
        }
        if (!this.canManageOrderTicketIndependently(ticket, order)) {
          throw new ConflictException(
            "Claim the linked order before replying to this ticket",
          )
        }

        const updated = await tx.ticket.update({
          where: { id: ticketId },
          data: { assignedToUserId: actor.userId },
        })
        const systemEvent = await this.createSystemEvent(
          tx,
          ticket,
          actor,
          "INTERNAL",
          "Ticket claimed by Operations.",
        )
        await this.audit.log(
          {
            action: "TICKET_CLAIMED",
            entityType: "Ticket",
            entityId: ticketId,
            metadata: { systemEventId: systemEvent.id },
            userId: actor.userId,
            organizationId: ticket.organizationId,
          },
          tx,
        )
        const fanOut = await this.fanOutTicketEvent(
          tx,
          ticketId,
          "SUPPORT_INTERNAL_NOTE",
          `Support ticket claimed: ${ticket.subject}`,
          actor.userId,
          "INTERNAL",
          systemEvent.id,
        )
        return { updated, fanOut }
      },
    )
    await this.dispatchTicketFanOut(committed.fanOut)
    return {
      id: committed.updated.id,
      assignedTo: { displayName: "You" },
      capabilities: this.buildCapabilities(actor, committed.updated),
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────────────────────────────────

  private isStaff(actor: SupportActor): boolean {
    return actor.kind === "STAFF"
  }

  private assertValidStatusFilter(status?: string): void {
    if (status && !VALID_TICKET_STATUSES.includes(status as TicketStatus)) {
      throw new BadRequestException("Invalid ticket status filter")
    }
  }

  private async lockTicket(tx: any, ticketId: string) {
    await tx.$queryRaw`SELECT "id" FROM public."Ticket" WHERE "id" = ${ticketId} FOR UPDATE`
    return tx.ticket.findUnique({ where: { id: ticketId } })
  }

  /**
   * Lock a ticket for an ownership command using the repository-wide
   * Order -> Ticket order. The initial ticket read discovers the immutable
   * order link only; every routing fact is re-read after the locks are held.
   */
  private async lockTicketOwnershipContext(tx: any, ticketId: string) {
    const ticketHint = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: { orderId: true },
    })
    if (!ticketHint) throw new NotFoundException("Ticket not found")

    let order: any = null
    if (ticketHint.orderId) {
      await tx.$queryRaw`SELECT "id" FROM public."Order" WHERE "id" = ${ticketHint.orderId} FOR UPDATE`
      order = await tx.order.findUnique({
        where: { id: ticketHint.orderId },
        select: {
          id: true,
          status: true,
          fulfillmentChannel: true,
          website: { select: { ownershipType: true } },
          dispute: { select: { status: true, previousStatus: true } },
          fulfillmentAssignments: {
            where: {
              status: { in: [...ACTIVE_FULFILLMENT_ASSIGNMENT_STATUSES] },
            },
            select: { id: true },
            take: 1,
          },
        },
      })
      if (!order) throw new NotFoundException("Ticket not found")
    }

    const ticket = await this.lockTicket(tx, ticketId)
    if (!ticket) throw new NotFoundException("Ticket not found")
    if (ticket.orderId !== ticketHint.orderId) {
      throw new ConflictException(
        "Ticket routing changed during the ownership command. Refresh and retry.",
      )
    }
    return { ticket, order }
  }

  private canManageOrderTicketIndependently(ticket: any, order: any): boolean {
    if (!ticket.orderId) return true
    if (!order) return false
    const authoritativeChannel =
      order.fulfillmentChannel ??
      (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
    if (
      authoritativeChannel !== "PLATFORM" ||
      !Array.isArray(order.fulfillmentAssignments) ||
      order.fulfillmentAssignments.length > 0
    ) {
      return false
    }
    if (order.status === "DISPUTED") {
      return (
        ["OPEN", "UNDER_REVIEW"].includes(order.dispute?.status) &&
        POST_FULFILLMENT_DISPUTE_PREVIOUS_STATUSES.includes(
          order.dispute
            ?.previousStatus as (typeof POST_FULFILLMENT_DISPUTE_PREVIOUS_STATUSES)[number],
        )
      )
    }
    return POST_FULFILLMENT_SUPPORT_ORDER_STATUSES.includes(
      order.status as (typeof POST_FULFILLMENT_SUPPORT_ORDER_STATUSES)[number],
    )
  }

  /**
   * Resolve the order-derived support owner while the caller holds the Order
   * row lock. An active assignment is always authoritative. After fulfillment,
   * the latest DELIVERED assignment remains the safest continuity owner.
   * A user who is no longer active Operations is not routed new support work;
   * active-order tickets then remain read-only until the order is reassigned,
   * while post-fulfillment tickets may be claimed independently.
   */
  private async resolveOrderSupportOwner(
    tx: any,
    orderId: string,
  ): Promise<string | null> {
    const active = await tx.fulfillmentAssignment.findFirst({
      where: {
        orderId,
        status: { in: [...ACTIVE_FULFILLMENT_ASSIGNMENT_STATUSES] },
      },
      select: { assignedToUserId: true },
      orderBy: [{ assignedAt: "desc" }, { id: "desc" }],
    })
    const candidate =
      active ??
      (await tx.fulfillmentAssignment.findFirst({
        where: { orderId, status: "DELIVERED" },
        select: { assignedToUserId: true },
        orderBy: [{ assignedAt: "desc" }, { id: "desc" }],
      }))
    if (!candidate) return null

    const owner = await tx.staffMembership.findUnique({
      where: { userId: candidate.assignedToUserId },
      select: {
        role: true,
        user: { select: { banned: true, userType: true } },
      },
    })
    return owner?.role === "OPERATIONS" &&
      !owner.user.banned &&
      owner.user.userType === "STAFF"
      ? candidate.assignedToUserId
      : null
  }

  private async assertActorAuthorityInTransaction(
    tx: any,
    actor: SupportActor,
  ): Promise<void> {
    const user = await tx.user.findUnique({
      where: { id: actor.userId },
      select: { userType: true, banned: true },
    })
    if (!user || user.banned || user.userType !== actor.kind) {
      throw new ForbiddenException(
        "Current support authority is no longer valid",
      )
    }

    if (actor.kind === "CUSTOMER") {
      if (!actor.organizationId) {
        throw new ForbiddenException("Missing organization context")
      }
      const membership = await tx.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: actor.userId,
            organizationId: actor.organizationId,
          },
        },
        select: { role: true, status: true },
      })
      if (
        membership?.status !== "ACTIVE" ||
        membership.role !== actor.customerRole
      ) {
        throw new ForbiddenException(
          "Current organization membership is no longer valid",
        )
      }
      return
    }

    if (actor.kind === "PUBLISHER") {
      if (!actor.publisherId) {
        throw new ForbiddenException("Missing publisher context")
      }
      const membership = await tx.publisherMembership.findUnique({
        where: {
          userId_publisherId: {
            userId: actor.userId,
            publisherId: actor.publisherId,
          },
        },
        select: { role: true },
      })
      if (!membership || membership.role !== actor.publisherRole) {
        throw new ForbiddenException(
          "Current publisher membership is no longer valid",
        )
      }
      return
    }

    const membership = await tx.staffMembership.findUnique({
      where: { userId: actor.userId },
      select: { role: true },
    })
    if (
      !membership ||
      membership.role !== actor.staffRole ||
      !["SUPER_ADMIN", "OPERATIONS"].includes(membership.role)
    ) {
      throw new ForbiddenException("Current staff role cannot access support")
    }
  }

  private messageParty(message: any): SenderParty {
    if (message.messageType === "SYSTEM_EVENT") return "SYSTEM"
    if (message.participantRole === "CUSTOMER") return "CUSTOMER"
    if (message.participantRole === "PUBLISHER") return "PUBLISHER"
    return "SUPPORT"
  }

  private partyLabel(party: SenderParty): string {
    switch (party) {
      case "CUSTOMER":
        return "Customer"
      case "PUBLISHER":
        return "Publisher"
      case "SUPPORT":
        return "GuestPost Support"
      case "SYSTEM":
        return "System"
    }
  }

  private projectActorSnapshot(value: unknown): ActorSnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const snapshot = value as Record<string, unknown>
    if (
      !(["CUSTOMER", "PUBLISHER", "STAFF"] as unknown[]).includes(snapshot.kind)
    ) {
      return null
    }
    return {
      kind: snapshot.kind as ActorKind,
      staffRole: (
        ["SUPER_ADMIN", "OPERATIONS", "FINANCE"] as unknown[]
      ).includes(snapshot.staffRole)
        ? (snapshot.staffRole as StaffRole)
        : null,
      organizationRole: (["OWNER", "MEMBER"] as unknown[]).includes(
        snapshot.organizationRole,
      )
        ? (snapshot.organizationRole as CustomerRole)
        : null,
      publisherRole: (
        ["PUBLISHER_OWNER", "PUBLISHER_MEMBER"] as unknown[]
      ).includes(snapshot.publisherRole)
        ? (snapshot.publisherRole as PublisherRole)
        : null,
    }
  }

  private projectMessage(message: any, actor: SupportActor): TicketMessageDto {
    const party = this.messageParty(message)
    const isSelf =
      party !== "SYSTEM" &&
      message.userId != null &&
      message.userId === actor.userId
    const staffView = actor.kind === "STAFF"
    const sameExternalParty =
      !staffView &&
      ((actor.kind === "CUSTOMER" && party === "CUSTOMER") ||
        (actor.kind === "PUBLISHER" && party === "PUBLISHER"))
    const displayName =
      party === "SYSTEM"
        ? "System"
        : isSelf
          ? "You"
          : sameExternalParty
            ? "Your team"
            : staffView
              ? (message.user?.name ?? this.partyLabel(party))
              : this.partyLabel(party)
    const projected: TicketMessageDto = {
      id: message.id,
      content: message.content,
      visibility: message.visibility,
      messageType: message.messageType,
      createdAt: message.createdAt,
      sender: { party, displayName, isSelf },
    }

    if (staffView) {
      projected.participantRole = message.participantRole
      projected.actorSnapshot = this.projectActorSnapshot(message.actorSnapshot)
      projected.authorEvidence = message.user
        ? {
            displayName: message.user.name ?? this.partyLabel(party),
            ...(actor.staffRole === "SUPER_ADMIN"
              ? {
                  userId: message.user.id,
                  email: message.user.email,
                }
              : {}),
          }
        : null
    }
    return projected
  }

  private projectOpeningMessage(ticket: any, actor: SupportActor) {
    if (!ticket.description?.trim()) return null
    const participantRole: ParticipantRole =
      ticket.user?.userType === "PUBLISHER" ? "PUBLISHER" : "CUSTOMER"
    return this.projectMessage(
      {
        id: `${ticket.id}:opening`,
        content: ticket.description,
        visibility: "PUBLIC",
        participantRole,
        messageType: "MESSAGE",
        actorSnapshot: null,
        userId: ticket.userId,
        user: ticket.user,
        createdAt: ticket.createdAt,
      },
      actor,
    )
  }

  private projectTicketListItem(
    ticket: any,
    actor: SupportActor,
    publicActivityAt: Date,
  ) {
    return {
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      fulfillmentChannel: ticket.fulfillmentChannel,
      order: this.projectOrder(ticket.order),
      createdAt: ticket.createdAt,
      updatedAt: publicActivityAt,
      capabilities: this.buildCapabilities(actor, ticket),
    }
  }

  private superAdminIdentity(actor: SupportActor): boolean {
    return actor.kind === "STAFF" && actor.staffRole === "SUPER_ADMIN"
  }

  private projectOrder(order: any) {
    if (!order) return null
    return {
      id: order.id,
      title: order.title,
      status: order.status,
      type: order.type,
      fulfillmentChannel: order.fulfillmentChannel,
    }
  }

  private projectStaffTicketListItem(ticket: any, actor: SupportActor) {
    const revealIdentity = this.superAdminIdentity(actor)
    return {
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      fulfillmentChannel: ticket.fulfillmentChannel,
      requester: {
        displayName:
          ticket.user.name ??
          (ticket.user.userType === "PUBLISHER" ? "Publisher" : "Customer"),
        ...(revealIdentity
          ? { userId: ticket.user.id, email: ticket.user.email }
          : {}),
      },
      organization: ticket.organization
        ? { name: ticket.organization.name }
        : null,
      assignedTo: ticket.assignedTo
        ? {
            displayName: ticket.assignedTo.name ?? "Operations staff",
            ...(revealIdentity ? { userId: ticket.assignedTo.id } : {}),
          }
        : null,
      assignedPublisher: ticket.assignedPublisher
        ? {
            displayName: ticket.assignedPublisher.name ?? "Publisher",
            ...(revealIdentity
              ? { publisherId: ticket.assignedPublisher.id }
              : {}),
          }
        : null,
      order: this.projectOrder(ticket.order),
      // The required opening description is projected as a synthetic first
      // message, so staff inbox counts must include it as well.
      messageCount:
        ticket._count.messages + (ticket.description?.trim() ? 1 : 0),
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      capabilities: this.buildCapabilities(actor, ticket),
    }
  }

  private projectTicketDetail(
    ticket: any,
    actor: SupportActor,
    nextCursor: string | null,
    publicActivityAt: Date,
  ) {
    const messages = ticket.messages
      .reverse()
      .map((message: any) => this.projectMessage(message, actor))
    const projected: any = {
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      fulfillmentChannel: ticket.fulfillmentChannel,
      order: this.projectOrder(ticket.order),
      openingMessage: this.projectOpeningMessage(ticket, actor),
      messages,
      messagePage: { nextCursor, limit: MESSAGE_PAGE_LIMIT },
      createdAt: ticket.createdAt,
      updatedAt: actor.kind === "STAFF" ? ticket.updatedAt : publicActivityAt,
      capabilities: this.buildCapabilities(actor, ticket),
    }
    if (actor.kind === "STAFF") {
      const revealIdentity = this.superAdminIdentity(actor)
      projected.requester = {
        displayName:
          ticket.user.name ??
          (ticket.user.userType === "PUBLISHER" ? "Publisher" : "Customer"),
        ...(revealIdentity
          ? { userId: ticket.user.id, email: ticket.user.email }
          : {}),
      }
      projected.organization = ticket.organization
        ? { name: ticket.organization.name }
        : null
      projected.assignedTo = ticket.assignedTo
        ? {
            displayName: ticket.assignedTo.name ?? "Operations staff",
            ...(revealIdentity ? { userId: ticket.assignedTo.id } : {}),
          }
        : null
      projected.assignedPublisher = ticket.assignedPublisher
        ? {
            displayName: ticket.assignedPublisher.name ?? "Publisher",
            ...(revealIdentity
              ? { publisherId: ticket.assignedPublisher.id }
              : {}),
          }
        : null
    }
    return projected
  }

  private buildCapabilities(
    actor: SupportActor,
    ticket: any,
  ): TicketCapabilitiesDto {
    const terminal = TERMINAL_PUBLIC_REPLY_STATUSES.includes(ticket.status)
    const customerParticipant =
      actor.kind === "CUSTOMER" &&
      !!actor.organizationId &&
      ticket.organizationId === actor.organizationId
    const publisherParticipant =
      actor.kind === "PUBLISHER" &&
      ticket.fulfillmentChannel === "PUBLISHER" &&
      !!actor.publisherId &&
      ticket.assignedPublisherId === actor.publisherId
    const superAdmin =
      actor.kind === "STAFF" && actor.staffRole === "SUPER_ADMIN"
    const cleanPlatformRouting = isOperationsPlatformSupportTicket(ticket)
    const assignedOperations =
      actor.kind === "STAFF" &&
      actor.staffRole === "OPERATIONS" &&
      cleanPlatformRouting &&
      ticket.assignedToUserId === actor.userId
    const orderSupportClaimable = this.canManageOrderTicketIndependently(
      ticket,
      ticket.order,
    )
    const canClaim =
      actor.kind === "STAFF" &&
      actor.staffRole === "OPERATIONS" &&
      cleanPlatformRouting &&
      ticket.assignedToUserId === null &&
      orderSupportClaimable
    const canReassign =
      superAdmin && cleanPlatformRouting && orderSupportClaimable
    const publicAuthority =
      customerParticipant ||
      publisherParticipant ||
      superAdmin ||
      assignedOperations
    const canReply = publicAuthority && !terminal
    const canPostInternal = superAdmin || assignedOperations

    let allowedStatuses: TicketStatus[] = []
    if (actor.kind === "CUSTOMER" || actor.kind === "PUBLISHER") {
      if (customerParticipant || publisherParticipant) {
        allowedStatuses =
          ticket.status === "CLOSED"
            ? ["OPEN"]
            : ticket.status === "RESOLVED"
              ? ["OPEN", "CLOSED"]
              : ["CLOSED"]
      }
    } else if (superAdmin || assignedOperations) {
      allowedStatuses = VALID_TICKET_STATUSES.filter(
        (status) => status !== ticket.status,
      ) as TicketStatus[]
    }

    let readOnlyReason: string | null = null
    if (canClaim) {
      readOnlyReason = "Claim this ticket before replying."
    } else if (
      actor.kind === "STAFF" &&
      actor.staffRole === "OPERATIONS" &&
      !assignedOperations
    ) {
      readOnlyReason = ticket.orderId
        ? "Claim the linked order before replying to this ticket."
        : "This ticket is assigned to another Operations user."
    } else if (terminal && publicAuthority) {
      readOnlyReason = "Reopen this ticket before posting a public reply."
    } else if (!publicAuthority) {
      readOnlyReason = "You do not have reply access to this ticket."
    }

    return {
      canReply,
      canClose: allowedStatuses.includes("CLOSED"),
      canReopen: allowedStatuses.includes("OPEN") && terminal,
      canPostInternal,
      canClaim,
      canReassign,
      allowedVisibilities: [
        ...(canReply ? (["PUBLIC"] as Visibility[]) : []),
        ...(canPostInternal ? (["INTERNAL"] as Visibility[]) : []),
      ],
      allowedStatuses,
      readOnlyReason,
    }
  }

  private async createSystemEvent(
    tx: any,
    ticket: any,
    actor: SupportActor,
    visibility: Visibility,
    content: string,
  ) {
    return tx.ticketMessage.create({
      data: {
        content,
        userId: actor.userId,
        ticketId: ticket.id,
        visibility,
        participantRole: resolveParticipantRole(actor),
        messageType: "SYSTEM_EVENT",
        actorSnapshot: buildActorSnapshot(actor) as any,
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, userType: true },
        },
      },
    })
  }

  private async transitionStatus(
    ticketId: string,
    status: TicketStatus,
    actor: SupportActor,
    external: boolean,
  ) {
    const committed = await runSerializableTransactionWithRetry(
      this.prisma,
      async (tx: any) => {
        const ticket = await this.lockTicket(tx, ticketId)
        if (!ticket) throw new NotFoundException("Ticket not found")
        await this.assertActorAuthorityInTransaction(tx, actor)
        await this.assertCanReply(actor, ticket, "PUBLIC")
        if (ticket.status === status) {
          return { updated: ticket, fanOut: null }
        }
        if (external) {
          if (status === "OPEN") {
            if (!TERMINAL_PUBLIC_REPLY_STATUSES.includes(ticket.status)) {
              throw new ConflictException(
                "Only resolved or closed tickets can be reopened",
              )
            }
          } else if (status !== "CLOSED" || ticket.status === "CLOSED") {
            throw new ForbiddenException(
              "External participants may only close or reopen tickets",
            )
          }
        }

        const updated = await tx.ticket.update({
          where: { id: ticketId },
          data: { status },
        })
        const systemEvent = await this.createSystemEvent(
          tx,
          ticket,
          actor,
          "PUBLIC",
          `Ticket status changed from ${ticket.status.replaceAll("_", " ")} to ${status.replaceAll("_", " ")}.`,
        )
        await this.audit.log(
          {
            action: "SUPPORT_TICKET_STATUS_CHANGED",
            entityType: "Ticket",
            entityId: ticketId,
            metadata: {
              from: ticket.status,
              to: status,
              actorKind: actor.kind,
              actorStaffRole: actor.staffRole ?? null,
              systemEventId: systemEvent.id,
            },
            userId: actor.userId,
            organizationId: ticket.organizationId,
          },
          tx,
        )
        const fanOut = await this.fanOutTicketEvent(
          tx,
          ticketId,
          "SUPPORT_STATUS_CHANGED",
          `Support ticket "${ticket.subject}" is now ${status.replaceAll("_", " ").toLowerCase()}.`,
          actor.userId,
          "PUBLIC",
          systemEvent.id,
        )
        return { updated, fanOut }
      },
    )
    if (committed.fanOut) {
      await this.dispatchTicketFanOut(committed.fanOut)
    }
    return {
      id: committed.updated.id,
      status: committed.updated.status,
      updatedAt: committed.updated.updatedAt,
      capabilities: this.buildCapabilities(actor, committed.updated),
    }
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
        where.fulfillmentChannel = "PUBLISHER"
        break
      case "STAFF":
        switch (actor.staffRole) {
          case "OPERATIONS":
            Object.assign(where, operationsPlatformSupportWhere())
            where.AND = [
              {
                OR: [
                  { assignedToUserId: actor.userId },
                  { assignedToUserId: null },
                ],
              },
            ]
            break
          case "SUPER_ADMIN":
            break
          default:
            throw new ForbiddenException("Staff role cannot access support")
        }
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
        if (
          ticket.fulfillmentChannel !== "PUBLISHER" ||
          ticket.assignedPublisherId !== actor.publisherId
        ) {
          throw new NotFoundException("Ticket not found")
        }
        return
      case "STAFF":
        switch (actor.staffRole) {
          case "OPERATIONS": {
            const hasCleanPlatformRouting =
              isOperationsPlatformSupportTicket(ticket)
            const isOwn =
              hasCleanPlatformRouting &&
              ticket.assignedToUserId === actor.userId
            const isUnassignedPlatform =
              hasCleanPlatformRouting && ticket.assignedToUserId === null
            if (!isOwn && !isUnassignedPlatform)
              throw new NotFoundException("Ticket not found")
            return
          }
          case "SUPER_ADMIN":
            return
          default:
            throw new ForbiddenException("Staff role cannot access support")
        }
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
      switch (actor.staffRole) {
        case "SUPER_ADMIN":
          // Universal participant — can write PUBLIC and INTERNAL anywhere.
          return
        case "OPERATIONS":
          // Only on tickets they actually own. Unassigned-platform pool is
          // read-only until an Operations user explicitly claims it (or a
          // Super Admin assigns a general ticket).
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
    tx: any,
    ticketId: string,
    type: string,
    message: string,
    excludeUserId: string,
    visibility: Visibility,
    sourceId: string,
  ): Promise<TicketFanOut> {
    const ticket = await tx.ticket.findUnique({
      where: { id: ticketId },
      include: {
        organization: {
          include: {
            memberships: {
              where: { status: "ACTIVE", user: { banned: false } },
            },
          },
        },
        assignedPublisher: {
          include: {
            publisherMemberships: {
              where: { user: { banned: false } },
            },
          },
        },
      },
    })
    if (!ticket) {
      return {
        communicationEventId: null,
        legacyRecipients: [],
        legacyType: type,
        message,
      }
    }

    // userId -> organizationId (for the notification's tenant scope).
    const recipients = new Map<string, string | null>()
    const add = (userId: string, organizationId: string | null) => {
      if (userId === excludeUserId) return
      if (recipients.has(userId)) return
      recipients.set(userId, organizationId)
    }

    const channel = ticket.fulfillmentChannel as "PUBLISHER" | "PLATFORM" | null
    const isInternal = visibility === "INTERNAL"
    const operationsPlatformTicket = isOperationsPlatformSupportTicket(ticket)

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
    if (operationsPlatformTicket && ticket.assignedToUserId) {
      const assignmentOwner = await tx.staffMembership.findUnique({
        where: { userId: ticket.assignedToUserId },
        select: { role: true, user: { select: { banned: true } } },
      })
      if (
        assignmentOwner?.role === "OPERATIONS" &&
        !assignmentOwner.user.banned
      ) {
        add(ticket.assignedToUserId, null)
      }
    }

    // SUPER_ADMIN — universal participant. Notified on every event.
    const superAdmins = await tx.staffMembership.findMany({
      where: { role: "SUPER_ADMIN", user: { banned: false } },
      select: { userId: true },
    })
    for (const sm of superAdmins) add(sm.userId, null)

    if (this.communications) {
      const eventType =
        type === "SUPPORT_STATUS_CHANGED"
          ? "SUPPORT_STATUS_CHANGED"
          : isInternal
            ? "SUPPORT_INTERNAL_NOTE"
            : "SUPPORT_PUBLIC_REPLY"
      const event = await this.communications.record(
        {
          type: eventType,
          aggregateType: type === "TICKET_OPENED" ? "Ticket" : "TicketMessage",
          aggregateId: sourceId,
          organizationId: ticket.organizationId,
          title:
            type === "TICKET_OPENED"
              ? "New support ticket"
              : type === "SUPPORT_STATUS_CHANGED"
                ? "Support ticket status updated"
                : isInternal
                  ? "Internal support note"
                  : "New support reply",
          message,
          actionPath: `/dashboard/support/${ticketId}`,
          dedupKey: `support:${ticketId}:${sourceId}:${type.toLowerCase()}`,
          recipientUserIds: [...recipients.keys()],
          actorUserId: excludeUserId,
        },
        tx,
      )
      return {
        communicationEventId: event.eventId,
        legacyRecipients: [],
        legacyType: type,
        message,
      }
    }

    return {
      communicationEventId: null,
      legacyRecipients: [...recipients].map(([userId, organizationId]) => ({
        userId,
        organizationId,
      })),
      legacyType: type,
      message,
    }
  }

  private async dispatchTicketFanOut(fanOut: TicketFanOut): Promise<void> {
    if (fanOut.communicationEventId) {
      this.communications?.dispatchBestEffort(fanOut.communicationEventId)
      return
    }
    for (const { userId, organizationId } of fanOut.legacyRecipients) {
      await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
        userId,
        organizationId,
        type: fanOut.legacyType,
        message: fanOut.message,
      })
    }
  }
}
