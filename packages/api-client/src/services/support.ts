import type { TicketStatus } from "@guestpost/shared"
import type { HttpClient } from "../client"

// Phase 6.6: visibility scope for a ticket reply.
//   PUBLIC   — customer-visible message (default).
//   INTERNAL — staff-only note. Customer-side clients never see these
//              messages and never send this visibility; staff frontends use
//              it for cross-role coordination.
export type TicketMessageVisibility = "PUBLIC" | "INTERNAL"

// Phase 6.6.1: role-at-write-time, snapshotted on every message. UI keys
// the role badge off this; reports key audit filters off this. Never
// derived dynamically — a role change later does NOT mutate historical
// messages.
export type TicketParticipantRole =
  | "CUSTOMER"
  | "PUBLISHER"
  | "OPS"
  | "ADMIN"
  | "FINANCE"

// Phase 6.6.1: how to classify this row in the thread render.
//   MESSAGE       — human reply.
//   INTERNAL_NOTE — staff-only note (visibility is always INTERNAL).
//   SYSTEM_EVENT  — machine-emitted thread entry (reassignment, status
//                   transition). Schema-ready; no service emits yet.
export type TicketMessageType = "MESSAGE" | "INTERNAL_NOTE" | "SYSTEM_EVENT"

// Phase 6.6.2: uncollapsed role context snapshot. Companion to
// participantRole — preserves the raw schema-level roles (StaffRole /
// CustomerRole / PublisherRole) so investigations can answer "OWNER vs
// MEMBER?" / "SUPER_ADMIN vs FINANCE?" without joining memberships at
// query time. Nullable on pre-migration rows.
export interface TicketMessageActorSnapshot {
  kind: "CUSTOMER" | "PUBLISHER" | "STAFF"
  staffRole: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE" | null
  organizationRole: "OWNER" | "MEMBER" | null
  publisherRole: "PUBLISHER_OWNER" | "PUBLISHER_MEMBER" | null
}

export interface TicketMessageDto {
  id: string
  content: string
  visibility: TicketMessageVisibility
  participantRole: TicketParticipantRole
  messageType: TicketMessageType
  actorSnapshot: TicketMessageActorSnapshot | null
  createdAt: string
  user: {
    id: string
    name: string | null
    email?: string
    userType?: string
  } | null
}

export interface TicketListItem {
  id: string
  subject: string
  status: TicketStatus
  createdAt: string
  updatedAt: string
  fulfillmentChannel?: "PUBLISHER" | "PLATFORM" | null
  assignedTo?: { id: string; name: string | null } | null
  assignedPublisher?: { id: string; name: string | null } | null
  order?: {
    id: string
    title: string | null
    status: string
    type: string
    fulfillmentChannel: string | null
  } | null
}

export interface TicketDetail extends TicketListItem {
  description: string | null
  user: { id: string; name: string | null; email: string; userType?: string }
  organization?: { id: string; name: string } | null
  messages: TicketMessageDto[]
}

export class SupportService {
  constructor(private client: HttpClient) {}

  // Backend stores the body as `description` — the previous `message`/`priority`
  // keys were silently dropped, so tickets were created with no detail. Map
  // explicitly and allow linking an order.
  createTicket(data: { subject: string; message: string; orderId?: string }) {
    return this.client.post<{ id: string; status: string }>(
      "/support/tickets",
      {
        json: {
          subject: data.subject,
          description: data.message,
          orderId: data.orderId,
        },
      },
    )
  }

  // Phase 6.5: actor-aware. Customer sees their org; publisher sees their
  // assigned tickets; staff sees the slice per role (see SupportService).
  // Optional status filter.
  listTickets(params?: { status?: string }) {
    return this.client.get<TicketListItem[]>("/support/tickets", {
      params: params as Record<string, any>,
    })
  }

  // Phase 6.5 admin-only reassignment.
  reassignTicket(
    ticketId: string,
    body: {
      assignedToUserId?: string | null
      assignedPublisherId?: string | null
      reason?: string
    },
  ) {
    return this.client.patch(`/support/tickets/${ticketId}/reassign`, {
      json: body,
    })
  }

  getTicket(id: string) {
    return this.client.get<TicketDetail>(`/support/tickets/${id}`)
  }

  // Phase 6.6: optional visibility on replies. Customer/publisher clients
  // should not pass INTERNAL — the server enforces this and returns 403 if
  // they try. Default visibility is PUBLIC.
  addMessage(
    ticketId: string,
    data: { content: string; visibility?: TicketMessageVisibility },
  ) {
    return this.client.post(`/support/tickets/${ticketId}/messages`, {
      json: data,
    })
  }

  updateTicketStatus(ticketId: string, status: TicketStatus) {
    return this.client.patch(`/support/tickets/${ticketId}/status`, {
      json: { status },
    })
  }
}
