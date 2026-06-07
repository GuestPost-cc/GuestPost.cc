import type { OrderStatus, ServiceType, OrderEventType } from "@guestpost/shared"
import { HttpClient } from "../client"

export interface OrderItemData {
  websiteId: string
  serviceType: ServiceType
  topic?: string
  instructions?: string
  budget?: number
}

export interface CreateOrderData {
  campaignId?: string
  items: OrderItemData[]
}

export interface OrderResponse {
  id: string
  status: OrderStatus
  items: Array<{
    id: string
    serviceType: ServiceType
    topic: string | null
    instructions: string | null
    budget: number | null
    website: { id: string; url: string } | null
    assignedTo: { id: string; name: string | null } | null
  }>
  totalAmount: number | null
  currency: string
  createdAt: string
  updatedAt: string
  events: Array<{
    id: string
    eventType: OrderEventType
    metadata: Record<string, unknown> | null
    createdAt: string
  }>
}

export class OrdersService {
  constructor(private client: HttpClient) {}

  create(data: CreateOrderData) {
    return this.client.post<OrderResponse>("/orders", { json: data as unknown as Record<string, unknown> })
  }

  list(params?: { status?: OrderStatus; campaignId?: string }) {
    return this.client.get<OrderResponse[]>("/orders", { params })
  }

  getById(id: string) {
    return this.client.get<OrderResponse>(`/orders/${id}`)
  }

  updateStatus(id: string, status: OrderStatus, metadata?: Record<string, unknown>) {
    return this.transitionStatus(id, status, metadata)
  }

  transitionStatus(id: string, status: OrderStatus, metadata?: Record<string, unknown>) {
    return this.client.patch<OrderResponse>(`/orders/${id}/status`, {
      json: { status, ...(metadata ? { metadata } : {}) } as Record<string, unknown>,
    })
  }

  getEvents(id: string) {
    return this.client.get<Array<{ id: string; eventType: OrderEventType; createdAt: string }>>(`/orders/${id}/events`)
  }

  submitPayment(id: string) {
    return this.client.post<OrderResponse>(`/orders/${id}/submit-payment`)
  }
}
