import type { OrderStatus, ServiceType } from "@guestpost/shared"
import { HttpClient } from "../client"

export type Campaign = {
  id: string
  name: string
  description?: string
  status: string
  organizationId: string
  createdAt: string
  updatedAt?: string
  orderCount?: number
}

export interface Paginated<T> {
  items: T[]
  total: number
  take: number
  skip: number
}

export interface PaginationParams {
  take?: number
  skip?: number
  [key: string]: string | number | boolean | undefined
}

export class CampaignsService {
  constructor(private client: HttpClient) {}

  createCampaign(data: { name: string; description?: string; organizationId: string }) {
    return this.client.post<{ id: string; name: string }>("/campaigns", { json: data })
  }

  // Returns the items array; use listCampaignsPaginated for totals
  async listCampaigns(params?: PaginationParams) {
    const res = await this.listCampaignsPaginated(params)
    return res.items
  }

  listCampaignsPaginated(params?: PaginationParams) {
    return this.client.get<Paginated<Campaign>>("/campaigns", { params })
  }

  getCampaign(id: string) {
    return this.client.get<Campaign>(`/campaigns/${id}`)
  }

  async listCampaignOrders(id: string, params?: PaginationParams) {
    const res = await this.client.get<Paginated<any>>(`/campaigns/${id}/orders`, { params })
    return res.items
  }

  deleteCampaign(id: string) {
    return this.client.delete(`/campaigns/${id}`)
  }

  createOrder(data: {
    type: ServiceType
    title?: string
    instructions?: string
    targetUrl?: string
    anchorText?: string
    websiteId?: string
    campaignId?: string
    idempotencyKey?: string
  }) {
    return this.client.post<{ id: string; status: string }>("/campaigns/orders", { json: data })
  }

  async listOrders(params?: PaginationParams) {
    const res = await this.client.get<Paginated<{ id: string; type: ServiceType; status: OrderStatus; createdAt: string }>>(
      "/campaigns/orders",
      { params },
    )
    return res.items
  }

  getOrder(id: string) {
    return this.client.get<{
      id: string
      status: OrderStatus
      type: ServiceType
      title?: string
      instructions?: string
      amount?: string | number
      createdAt: string
    }>(`/campaigns/orders/${id}`)
  }

  requestRevision(orderId: string, data: { notes: string }) {
    return this.client.post(`/campaigns/orders/${orderId}/revisions`, { json: data })
  }
}
