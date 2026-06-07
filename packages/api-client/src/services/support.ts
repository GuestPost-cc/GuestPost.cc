import type { TicketStatus } from "@guestpost/shared"
import { HttpClient } from "../client"

export class SupportService {
  constructor(private client: HttpClient) {}

  createTicket(data: { subject: string; message: string; priority?: string }) {
    return this.client.post<{ id: string; status: string }>("/support/tickets", { json: data })
  }

  listTickets() {
    return this.client.get<Array<{ id: string; subject: string; status: TicketStatus; createdAt: string }>>(
      "/support/tickets",
    )
  }

  getTicket(id: string) {
    return this.client.get<{ id: string; subject: string; status: TicketStatus; messages: Array<{ content: string; createdAt: string; author: string }> }>(
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
