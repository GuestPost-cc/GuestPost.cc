import type { TicketStatus } from "@guestpost/shared"
import { HttpClient } from "../client"

export class SupportService {
  constructor(private client: HttpClient) {}

  // Backend stores the body as `description` — the previous `message`/`priority`
  // keys were silently dropped, so tickets were created with no detail. Map
  // explicitly and allow linking an order.
  createTicket(data: { subject: string; message: string; priority?: string; orderId?: string }) {
    return this.client.post<{ id: string; status: string }>("/support/tickets", {
      json: { subject: data.subject, description: data.message, orderId: data.orderId },
    })
  }

  // Phase 6.5: actor-aware. Customer sees their org; publisher sees their
  // assigned tickets; staff sees the slice per role (see SupportService).
  // Optional status filter.
  listTickets(params?: { status?: string }) {
    return this.client.get<Array<{
      id: string
      subject: string
      status: TicketStatus
      createdAt: string
      updatedAt: string
      fulfillmentChannel?: "PUBLISHER" | "PLATFORM" | null
      assignedTo?: { id: string; name: string | null } | null
      assignedPublisher?: { id: string; name: string | null } | null
      order?: { id: string; title: string | null; status: string; type: string; fulfillmentChannel: string | null } | null
    }>>(
      "/support/tickets", { params: params as Record<string, any> },
    )
  }

  // Phase 6.5 admin-only reassignment.
  reassignTicket(ticketId: string, body: { assignedToUserId?: string | null; assignedPublisherId?: string | null; reason?: string }) {
    return this.client.patch(`/support/tickets/${ticketId}/reassign`, { json: body })
  }

  getTicket(id: string) {
    return this.client.get<{ id: string; subject: string; description?: string; status: TicketStatus; order?: { id: string; title: string | null; status: string } | null; messages: Array<{ content: string; createdAt: string; author: string }> }>(
      `/support/tickets/${id}`,
    )
  }

  addMessage(ticketId: string, data: { content: string }) {
    return this.client.post(`/support/tickets/${ticketId}/messages`, { json: data })
  }

  updateTicketStatus(ticketId: string, status: TicketStatus) {
    return this.client.patch(`/support/tickets/${ticketId}/status`, { json: { status } })
  }
}
