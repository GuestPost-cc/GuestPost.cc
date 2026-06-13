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

  listTickets() {
    return this.client.get<Array<{ id: string; subject: string; status: TicketStatus; createdAt: string; order?: { id: string; title: string | null; status: string } | null }>>(
      "/support/tickets",
    )
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
