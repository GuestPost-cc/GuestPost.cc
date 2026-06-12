import type { OrderStatus, ServiceType, OrderEventType } from "@guestpost/shared"
import { HttpClient } from "../client"

// Mirrors CreateOrderDto exactly — the API whitelists properties, so any
// extra field is a 400. Service type/title/instructions live on the ORDER;
// items carry only website + link targeting. Prices come from the listing
// server-side and are never client-supplied.
export interface OrderItemData {
  websiteId?: string
  targetUrl?: string
  anchorText?: string
}

export interface CreateOrderData {
  type: ServiceType
  title?: string
  instructions?: string
  campaignId?: string
  idempotencyKey?: string
  items?: OrderItemData[]
}

// Raw API shape: Order rows carry type/title/amount at the ORDER level and
// items carry price/targetUrl/anchorText. Decimal columns serialize as
// strings over JSON.
interface RawOrderItem {
  id: string
  websiteId: string | null
  targetUrl: string | null
  anchorText: string | null
  price: string | number | null
  status: OrderStatus
  website?: { id: string; url: string } | null
}

interface RawOrder {
  id: string
  type: ServiceType
  status: OrderStatus
  amount: string | number | null
  currency: string
  paymentStatus: string
  title: string | null
  instructions: string | null
  targetUrl: string | null
  anchorText: string | null
  publishedUrl: string | null
  campaignId: string | null
  website?: { id: string; url: string; name?: string | null } | null
  items?: RawOrderItem[]
  events?: Array<{ id: string; eventType: OrderEventType; message?: string | null; metadata: Record<string, unknown> | null; createdAt: string }>
  settlements?: unknown[]
  dispute?: unknown
  createdAt: string
  updatedAt: string
}

export interface OrderResponse {
  id: string
  type: ServiceType
  status: OrderStatus
  paymentStatus: string
  title: string | null
  instructions: string | null
  publishedUrl: string | null
  campaignId: string | null
  website: { id: string; url: string; name?: string | null } | null
  items: Array<{
    id: string
    // Derived from the order row — service type/topic live on the Order,
    // not OrderItem. Kept on items for existing consumers.
    serviceType: ServiceType
    topic: string | null
    instructions: string | null
    budget: number | null
    targetUrl: string | null
    anchorText: string | null
    status: OrderStatus
    website: { id: string; url: string } | null
  }>
  totalAmount: number | null
  currency: string
  createdAt: string
  updatedAt: string
  events: Array<{
    id: string
    eventType: OrderEventType
    message?: string | null
    metadata: Record<string, unknown> | null
    createdAt: string
  }>
  settlements?: unknown[]
  dispute?: unknown
}

// Single mapping from the real API payload to the client contract — the type
// above previously declared fields the backend never returned (serviceType/
// topic/budget on items, totalAmount) and every consumer rendered "—".
function normalizeOrder(raw: RawOrder): OrderResponse {
  const orderWebsite = raw.website ?? null
  return {
    id: raw.id,
    type: raw.type,
    status: raw.status,
    paymentStatus: raw.paymentStatus,
    title: raw.title ?? null,
    instructions: raw.instructions ?? null,
    publishedUrl: raw.publishedUrl ?? null,
    campaignId: raw.campaignId ?? null,
    website: orderWebsite,
    items: (raw.items ?? []).map((item) => ({
      id: item.id,
      serviceType: raw.type,
      topic: raw.title ?? null,
      instructions: raw.instructions ?? null,
      budget: item.price != null ? Number(item.price) : null,
      targetUrl: item.targetUrl ?? null,
      anchorText: item.anchorText ?? null,
      status: item.status,
      website: item.website ?? orderWebsite,
    })),
    totalAmount: raw.amount != null ? Number(raw.amount) : null,
    currency: raw.currency,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    events: (raw.events ?? []).map((e) => ({
      id: e.id,
      eventType: e.eventType,
      message: e.message ?? null,
      metadata: e.metadata ?? null,
      createdAt: e.createdAt,
    })),
    settlements: raw.settlements,
    dispute: raw.dispute,
  }
}

export class OrdersService {
  constructor(private client: HttpClient) {}

  async create(data: CreateOrderData) {
    const raw = await this.client.post<RawOrder>("/orders", { json: data as unknown as Record<string, unknown> })
    return normalizeOrder(raw)
  }

  // GET /orders returns a paginated envelope { items, total, take, skip };
  // unwrap to the array all callers expect.
  async list(params?: { status?: OrderStatus; campaignId?: string }): Promise<OrderResponse[]> {
    const res = await this.client.get<{ items: RawOrder[] } | RawOrder[]>("/orders", { params })
    const rows = Array.isArray(res) ? res : (res?.items ?? [])
    return rows.map(normalizeOrder)
  }

  async getById(id: string) {
    const raw = await this.client.get<RawOrder>(`/orders/${id}`)
    return normalizeOrder(raw)
  }

  updateStatus(id: string, status: OrderStatus, metadata?: Record<string, unknown>) {
    return this.transitionStatus(id, status, metadata)
  }

  async transitionStatus(id: string, status: OrderStatus, metadata?: Record<string, unknown>) {
    const raw = await this.client.patch<RawOrder>(`/orders/${id}/status`, {
      json: { status, ...(metadata ? { metadata } : {}) } as Record<string, unknown>,
    })
    return normalizeOrder(raw)
  }

  getEvents(id: string) {
    return this.client.get<Array<{ id: string; eventType: OrderEventType; createdAt: string }>>(`/orders/${id}/events`)
  }

  openDispute(id: string, reason: string) {
    return this.client.post<{ id: string; status: string }>(`/orders/${id}/dispute`, { json: { reason } })
  }

  async submitPayment(id: string) {
    const raw = await this.client.post<RawOrder>(`/orders/${id}/submit-payment`)
    return normalizeOrder(raw)
  }

  async cancel(id: string) {
    const raw = await this.client.post<RawOrder>(`/orders/${id}/cancel`)
    return normalizeOrder(raw)
  }

  // ─── Publisher fulfillment actions ───────────────────────

  async accept(id: string) {
    const raw = await this.client.post<RawOrder>(`/orders/${id}/accept`)
    return normalizeOrder(raw)
  }

  async submitContent(id: string, content?: string) {
    const raw = await this.client.post<RawOrder>(`/orders/${id}/submit-content`, { json: { content } })
    return normalizeOrder(raw)
  }

  async markContentReady(id: string) {
    const raw = await this.client.post<RawOrder>(`/orders/${id}/mark-content-ready`)
    return normalizeOrder(raw)
  }

  async submitForReview(id: string) {
    const raw = await this.client.post<RawOrder>(`/orders/${id}/submit-for-review`)
    return normalizeOrder(raw)
  }

  async markPublished(id: string, url: string) {
    const raw = await this.client.post<RawOrder>(`/orders/${id}/mark-published`, { json: { url } })
    return normalizeOrder(raw)
  }

  // Customer-facing delivery proof (verification checklist + status).
  deliveryProof(id: string) {
    return this.client.get<any>(`/orders/${id}/delivery-proof`)
  }
}
