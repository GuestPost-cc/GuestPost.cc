import type { OrderStatus, ServiceType, TicketStatus } from "@guestpost/shared"
import type { HttpClient } from "../client"

export type TicketMessageVisibility = "PUBLIC" | "INTERNAL"

export type TicketParticipantRole =
  | "CUSTOMER"
  | "PUBLISHER"
  | "OPS"
  | "ADMIN"
  | "FINANCE"

export type TicketMessageType = "MESSAGE" | "INTERNAL_NOTE" | "SYSTEM_EVENT"

/** The stable party used for alignment and labels in every support client. */
export type SupportParty = "CUSTOMER" | "PUBLISHER" | "SUPPORT" | "SYSTEM"

export interface TicketMessageActorSnapshot {
  kind: "CUSTOMER" | "PUBLISHER" | "STAFF"
  staffRole: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE" | null
  organizationRole: "OWNER" | "MEMBER" | null
  publisherRole: "PUBLISHER_OWNER" | "PUBLISHER_MEMBER" | null
}

export interface SupportMessageSender {
  party: SupportParty
  displayName: string
  isSelf: boolean
}

export interface TicketMessageAuthorEvidence {
  displayName: string
  /** Present only for SUPER_ADMIN responses. */
  userId?: string
  /** Present only for SUPER_ADMIN responses. */
  email?: string
}

/**
 * Public messages contain only the base properties. The optional forensic
 * properties are included solely on staff projections and are omitted (not
 * serialized as null) from customer and publisher responses.
 */
export interface TicketMessageDto {
  id: string
  content: string
  visibility: TicketMessageVisibility
  messageType: TicketMessageType
  createdAt: string
  sender: SupportMessageSender
  participantRole?: TicketParticipantRole
  actorSnapshot?: TicketMessageActorSnapshot | null
  authorEvidence?: TicketMessageAuthorEvidence | null
}

export interface TicketCapabilities {
  canReply: boolean
  canClose: boolean
  canReopen: boolean
  canPostInternal: boolean
  canClaim: boolean
  /** Server-authorized ticket-only Operations assignment management. */
  canReassign: boolean
  allowedVisibilities: TicketMessageVisibility[]
  allowedStatuses: TicketStatus[]
  readOnlyReason: string | null
}

export interface TicketOrderSummary {
  id: string
  title: string | null
  status: OrderStatus
  type: ServiceType
  fulfillmentChannel: "PUBLISHER" | "PLATFORM" | null
}

export interface TicketListItem {
  id: string
  subject: string
  status: TicketStatus
  fulfillmentChannel: "PUBLISHER" | "PLATFORM" | null
  order: TicketOrderSummary | null
  messageCount?: number
  createdAt: string
  updatedAt: string
  capabilities: TicketCapabilities
}

export interface TicketDetail extends TicketListItem {
  openingMessage: TicketMessageDto | null
  messages: TicketMessageDto[]
  messagePage: TicketMessagePage
}

export interface TicketMessagePage {
  /** Opaque cursor for the next, older page; null when history is exhausted. */
  nextCursor: string | null
  limit: number
}

export interface TicketDetailQuery {
  messageCursor?: string
}

export interface StaffTicketIdentity {
  displayName: string
  /** Present only for SUPER_ADMIN responses. */
  userId?: string
}

export interface StaffTicketRequester extends StaffTicketIdentity {
  /** Present only for SUPER_ADMIN responses. */
  email?: string
}

export interface StaffTicketPublisherIdentity {
  displayName: string
  /** Present only for SUPER_ADMIN responses. */
  publisherId?: string
}

export interface StaffTicketListItem extends TicketListItem {
  requester: StaffTicketRequester
  organization: { name: string } | null
  assignedTo: StaffTicketIdentity | null
  assignedPublisher: StaffTicketPublisherIdentity | null
  messageCount: number
}

export interface StaffTicketDetail extends TicketDetail {
  requester: StaffTicketRequester
  organization: { name: string } | null
  assignedTo: StaffTicketIdentity | null
  assignedPublisher: StaffTicketPublisherIdentity | null
}

export interface StaffTicketListResponse {
  items: StaffTicketListItem[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface TicketListPage {
  items: TicketListItem[]
  /** Opaque cursor for the next, older public-activity page. */
  nextCursor: string | null
  limit: number
}

export interface CreateSupportTicketInput {
  subject: string
  message: string
  /** Stable per user intent; retry the same command with the same value. */
  clientRequestId: string
  /** Required by policy when the authenticated actor is a publisher. */
  orderId?: string
}

export interface CreateSupportTicketResponse {
  id: string
  status: TicketStatus
  createdAt: string
}

export interface AddTicketMessageInput {
  content: string
  /** Stable per composed reply; retry the same command with the same value. */
  clientMessageId: string
  visibility?: TicketMessageVisibility
}

export type PublicTicketStatusMutation = Extract<
  TicketStatus,
  "OPEN" | "CLOSED"
>

export interface TicketStatusMutationResponse {
  id: string
  status: TicketStatus
  updatedAt: string
  capabilities: TicketCapabilities
}

export interface ReassignTicketInput {
  assignedToUserId: string | null
  expectedAssignedToUserId: string | null
  reason: string
}

export interface TicketAssignmentMutationResponse {
  id: string
  assignedTo: StaffTicketIdentity | null
  capabilities: TicketCapabilities
}

export interface PublicSupportListFilters
  extends Record<string, string | number | undefined> {
  status?: TicketStatus
  orderId?: string
  cursor?: string
  limit?: number
}

export interface StaffSupportListFilters
  extends Record<string, string | number | undefined> {
  status?: TicketStatus
  orderId?: string
  search?: string
  channel?: "PLATFORM" | "PUBLISHER"
  assignedToUserId?: string | "UNASSIGNED"
  page?: number
  limit?: number
}

export type SupportListFilters =
  | PublicSupportListFilters
  | StaffSupportListFilters

export type SupportQueryScope = "customer" | "publisher" | "admin"

/** Shared hierarchy so list/detail invalidation is consistent in every app. */
export const supportKeys = {
  all: ["support"] as const,
  scope: (scope: SupportQueryScope) => [...supportKeys.all, scope] as const,
  lists: (scope: SupportQueryScope) =>
    [...supportKeys.scope(scope), "list"] as const,
  list: (scope: SupportQueryScope, filters?: SupportListFilters) =>
    [...supportKeys.lists(scope), filters ?? {}] as const,
  details: (scope: SupportQueryScope) =>
    [...supportKeys.scope(scope), "detail"] as const,
  detail: (scope: SupportQueryScope, ticketId: string) =>
    [...supportKeys.details(scope), ticketId] as const,
  order: (scope: Exclude<SupportQueryScope, "admin">, orderId: string) =>
    [...supportKeys.scope(scope), "order", orderId] as const,
}

export class SupportService {
  constructor(private client: HttpClient) {}

  createTicket(data: CreateSupportTicketInput) {
    return this.client.post<CreateSupportTicketResponse>("/support/tickets", {
      json: {
        subject: data.subject,
        description: data.message,
        clientRequestId: data.clientRequestId,
        orderId: data.orderId,
      },
    })
  }

  listTickets(params?: PublicSupportListFilters) {
    return this.client.get<TicketListPage>("/support/tickets", { params })
  }

  getTicket(id: string, params?: TicketDetailQuery) {
    return this.client.get<TicketDetail>(`/support/tickets/${id}`, {
      params: params ? { messageCursor: params.messageCursor } : undefined,
    })
  }

  addMessage(ticketId: string, data: AddTicketMessageInput) {
    return this.client.post<TicketMessageDto>(
      `/support/tickets/${ticketId}/messages`,
      {
        json: {
          content: data.content,
          clientMessageId: data.clientMessageId,
          visibility: data.visibility,
        },
      },
    )
  }

  updateTicketStatus(ticketId: string, status: PublicTicketStatusMutation) {
    return this.client.patch<TicketStatusMutationResponse>(
      `/support/tickets/${ticketId}/status`,
      { json: { status } },
    )
  }

  closeTicket(ticketId: string) {
    return this.updateTicketStatus(ticketId, "CLOSED")
  }

  reopenTicket(ticketId: string) {
    return this.updateTicketStatus(ticketId, "OPEN")
  }
}
