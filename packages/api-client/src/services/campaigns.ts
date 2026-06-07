import type { OrderStatus, ServiceType } from "@guestpost/shared"
import { HttpClient } from "../client"

export class CampaignsService {
  constructor(private client: HttpClient) {}

  createCampaign(data: { name: string; organizationId: string }) {
    return this.client.post<{ id: string; name: string }>("/campaigns", { json: data })
  }

  listCampaigns() {
    return this.client.get<Array<{ id: string; name: string; status: string }>>("/campaigns")
  }

  createOrder(data: {
    campaignId: string
    serviceType: ServiceType
    websiteId: string
    topic?: string
    instructions?: string
    budget?: number
  }) {
    return this.client.post<{ id: string; status: string }>("/campaigns/orders", { json: data })
  }

  listOrders() {
    return this.client.get<Array<{ id: string; serviceType: ServiceType; status: OrderStatus; createdAt: string }>>(
      "/campaigns/orders",
    )
  }

  getOrder(id: string) {
    return this.client.get<{
      id: string
      status: OrderStatus
      serviceType: ServiceType
      topic?: string
      instructions?: string
      price?: number
      createdAt: string
    }>(`/campaigns/orders/${id}`)
  }

  updateOrderStatus(id: string, status: OrderStatus) {
    return this.client.patch(`/campaigns/orders/${id}/status`, { json: { status } })
  }

  requestRevision(orderId: string, data: { message: string }) {
    return this.client.post(`/campaigns/orders/${orderId}/revisions`, { json: data })
  }
}
