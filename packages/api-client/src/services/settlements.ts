import type { SettlementStatus } from "@guestpost/shared"
import { HttpClient } from "../client"

export interface SettlementResponse {
  id: string
  orderId: string
  publisherId: string
  amount: number
  currency: string
  status: SettlementStatus
  reviewWindowEndsAt: string | null
  approvedAt: string | null
  paidAt: string | null
  createdAt: string
}

export class SettlementsService {
  constructor(private client: HttpClient) {}

  list() {
    return this.client.get<SettlementResponse[]>("/settlements")
  }

  getById(id: string) {
    return this.client.get<SettlementResponse>(`/settlements/${id}`)
  }

  approve(id: string) {
    return this.client.post<SettlementResponse>(`/settlements/${id}/approve`)
  }
}
