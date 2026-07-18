import type {
  OrderEventType,
  OrderStatus,
  ServiceType,
} from "@guestpost/shared"
import type { HttpClient } from "../client"

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
  // Phase 2 preferred: the customer's locked pick from the listing detail
  // page. When present, the server snapshots price/TAT/serviceType/channel
  // from this row and ignores any drift. Required in Phase 4.
  listingServiceId?: string
  // Phase 6: per-service structured brief. The server validates this against
  // the @guestpost/shared registry for the resolved serviceType — clients
  // should just JSON-stringify the form state.
  briefData?: Record<string, unknown>
  items?: OrderItemData[]
}

// Raw API shape: Order rows carry type/title/amount at the ORDER level and
// items carry price/targetUrl/anchorText. Decimal columns serialize as
// strings over JSON.
interface RawPublication {
  id: string
  publishedUrl: string | null
  targetUrl: string | null
  anchorText: string | null
  screenshotUrl: string | null
  publicationDate: string | null
  verificationStatus: string
}

interface RawOrderItem {
  id: string
  websiteId: string | null
  targetUrl: string | null
  anchorText: string | null
  price: string | number | null
  status: OrderStatus
  website?: { id: string; url: string } | null
  publications?: RawPublication[]
}

interface RawOrder {
  id: string
  version: number
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
  autoAcceptAt: string | null
  verifyMethod: string | null
  deliveryAcceptedMethod: string | null
  turnaroundDays: number | null
  submittedAt: string | null
  acceptedAt: string | null
  fulfillmentDueAt: string | null
  warrantyEndsAt: string | null
  briefData: Record<string, unknown> | null
  website?: { id: string; url: string; name?: string | null } | null
  items?: RawOrderItem[]
  events?: Array<{
    id: string
    eventType: OrderEventType
    message?: string | null
    metadata: Record<string, unknown> | null
    createdAt: string
  }>
  contentOrder?: {
    id: string
    title: string | null
    brief: string | null
    deliverable: string | null
    status: string
  } | null
  revisions?: Array<{
    id: string
    notes: string | null
    files: unknown
    status: string
    createdAt: string
  }>
  settlements?: unknown[]
  dispute?: unknown
  fulfillmentChannel?: "PUBLISHER" | "PLATFORM" | null
  cancellationRequests?: CancellationRequestResponse[]
  createdAt: string
  updatedAt: string
}

export interface OrderResponse {
  id: string
  version: number
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
    publications: Array<{
      id: string
      publishedUrl: string | null
      targetUrl: string | null
      anchorText: string | null
      screenshotUrl: string | null
      publicationDate: string | null
      verificationStatus: string
    }>
  }>
  // Content the publisher/operations submitted for this order.
  submittedContent: {
    title: string | null
    brief: string | null
    deliverable: string | null
    status: string
  } | null
  revisions: Array<{
    id: string
    notes: string | null
    files: unknown
    status: string
    createdAt: string
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
  autoAcceptAt: string | null
  verifyMethod: string | null
  deliveryAcceptedMethod: string | null
  turnaroundDays: number | null
  submittedAt: string | null
  acceptedAt: string | null
  fulfillmentDueAt: string | null
  warrantyEndsAt: string | null
  briefData: Record<string, unknown> | null
  settlements?: unknown[]
  dispute?: unknown
  fulfillmentChannel: "PUBLISHER" | "PLATFORM" | null
  cancellationRequests: CancellationRequestResponse[]
}

export type CancellationReasonCode =
  | "CUSTOMER_CHANGED_MIND"
  | "CAMPAIGN_CHANGED"
  | "DUPLICATE_ORDER"
  | "CAPACITY_UNAVAILABLE"
  | "TOPIC_UNSUITABLE"
  | "WEBSITE_UNAVAILABLE"
  | "PRICING_ERROR"
  | "POLICY_CONFLICT"
  | "MISSED_DEADLINE"
  | "QUALITY_FAILURE"
  | "PLATFORM_ERROR"
  | "LEGAL_OR_SECURITY_EMERGENCY"
  | "OTHER"

export interface CancellationMutationData {
  reasonCode: CancellationReasonCode
  note?: string
  expectedVersion: number
  idempotencyKey?: string
}

export type CancellationRequestStatus =
  | "REQUESTED"
  | "UNDER_REVIEW"
  | "PENDING_FINANCE"
  | "ESCALATED"
  | "APPROVED"
  | "REJECTED"
  | "DISPUTED"

export interface CancellationRequestResponse {
  id: string
  orderId: string
  requesterType: "CUSTOMER" | "PUBLISHER" | "STAFF" | "SYSTEM"
  reasonCode: CancellationReasonCode
  note: string | null
  status: CancellationRequestStatus
  responsibility: string
  responseDeadlineAt: string | null
  responseNote: string | null
  createdAt: string
}

export interface CancellationPreviewResponse {
  orderId: string
  status: OrderStatus
  expectedVersion: number
  actorCanMutate: boolean
  fulfillmentChannel: "PUBLISHER" | "PLATFORM"
  action:
    | "CANCEL_NOW"
    | "DECLINE_NOW"
    | "REQUEST_CANCELLATION"
    | "OPEN_DISPUTE"
    | "NOT_ALLOWED"
  refundRequired: boolean
  requiresCounterpartyResponse: boolean
  requiresStaffReview: boolean
  message: string
  refund: {
    type: "FULL" | "NONE"
    amount: number
    currency: string
    destination: "WALLET" | null
  }
  activeRequest: CancellationRequestResponse | null
  deadlines: {
    fulfillmentDueAt: string | null
    warrantyEndsAt: string | null
    fulfillmentOverdue: boolean
  }
}

// Single mapping from the real API payload to the client contract — the type
// above previously declared fields the backend never returned (serviceType/
// topic/budget on items, totalAmount) and every consumer rendered "—".
function normalizeOrder(raw: RawOrder): OrderResponse {
  const orderWebsite = raw.website ?? null
  return {
    id: raw.id,
    version: raw.version,
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
      publications: (item.publications ?? []).map((p) => ({
        id: p.id,
        publishedUrl: p.publishedUrl ?? null,
        targetUrl: p.targetUrl ?? null,
        anchorText: p.anchorText ?? null,
        screenshotUrl: p.screenshotUrl ?? null,
        publicationDate: p.publicationDate ?? null,
        verificationStatus: p.verificationStatus,
      })),
    })),
    submittedContent: raw.contentOrder
      ? {
          title: raw.contentOrder.title ?? null,
          brief: raw.contentOrder.brief ?? null,
          deliverable: raw.contentOrder.deliverable ?? null,
          status: raw.contentOrder.status,
        }
      : null,
    revisions: (raw.revisions ?? []).map((r) => ({
      id: r.id,
      notes: r.notes ?? null,
      files: r.files ?? null,
      status: r.status,
      createdAt: r.createdAt,
    })),
    totalAmount: raw.amount != null ? Number(raw.amount) : null,
    currency: raw.currency,
    autoAcceptAt: raw.autoAcceptAt ?? null,
    verifyMethod: raw.verifyMethod ?? null,
    deliveryAcceptedMethod: raw.deliveryAcceptedMethod ?? null,
    turnaroundDays: raw.turnaroundDays ?? null,
    submittedAt: raw.submittedAt ?? null,
    acceptedAt: raw.acceptedAt ?? null,
    fulfillmentDueAt: raw.fulfillmentDueAt ?? null,
    warrantyEndsAt: raw.warrantyEndsAt ?? null,
    briefData: raw.briefData ?? null,
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
    fulfillmentChannel: raw.fulfillmentChannel ?? null,
    cancellationRequests: raw.cancellationRequests ?? [],
  }
}

export class OrdersService {
  constructor(private client: HttpClient) {}

  async create(data: CreateOrderData) {
    const raw = await this.client.post<RawOrder>("/orders", {
      json: data as unknown as Record<string, unknown>,
    })
    return normalizeOrder(raw)
  }

  // GET /orders returns a paginated envelope { items, total, take, skip };
  // unwrap to the array all callers expect.
  async list(params?: {
    status?: OrderStatus
    campaignId?: string
  }): Promise<OrderResponse[]> {
    const res = await this.client.get<{ items: RawOrder[] } | RawOrder[]>(
      "/orders",
      { params },
    )
    const rows = Array.isArray(res) ? res : (res?.items ?? [])
    return rows.map(normalizeOrder)
  }

  async getById(id: string) {
    const raw = await this.client.get<RawOrder>(`/orders/${id}`)
    return normalizeOrder(raw)
  }

  getEvents(id: string) {
    return this.client.get<
      Array<{ id: string; eventType: OrderEventType; createdAt: string }>
    >(`/orders/${id}/events`)
  }

  openDispute(id: string, reason: string) {
    return this.client.post<{ id: string; status: string }>(
      `/orders/${id}/dispute`,
      { json: { reason } },
    )
  }

  async submitPayment(id: string) {
    const raw = await this.client.post<RawOrder>(`/orders/${id}/submit-payment`)
    return normalizeOrder(raw)
  }

  cancellationPreview(id: string) {
    return this.client.get<CancellationPreviewResponse>(
      `/orders/${id}/cancellation-preview`,
    )
  }

  async cancel(id: string, data: CancellationMutationData) {
    const raw = await this.client.post<RawOrder>(`/orders/${id}/cancel`, {
      json: data as unknown as Record<string, unknown>,
    })
    return normalizeOrder(raw)
  }

  requestCancellation(id: string, data: CancellationMutationData) {
    return this.client.post<CancellationRequestResponse>(
      `/orders/${id}/cancellation-requests`,
      { json: data as unknown as Record<string, unknown> },
    )
  }

  respondToCancellation(
    orderId: string,
    requestId: string,
    action: "ACCEPT" | "CONTEST",
    note?: string,
  ) {
    return this.client.post<CancellationRequestResponse>(
      `/orders/${orderId}/cancellation-requests/${requestId}/respond`,
      { json: { action, note } },
    )
  }

  // ─── Publisher fulfillment actions ───────────────────────

  async accept(id: string) {
    const raw = await this.client.post<RawOrder>(`/orders/${id}/accept`)
    return normalizeOrder(raw)
  }

  async decline(id: string, data: CancellationMutationData) {
    const raw = await this.client.post<RawOrder>(`/orders/${id}/decline`, {
      json: data as unknown as Record<string, unknown>,
    })
    return normalizeOrder(raw)
  }

  async submitContent(id: string, content?: string) {
    const raw = await this.client.post<RawOrder>(
      `/orders/${id}/submit-content`,
      { json: { content } },
    )
    return normalizeOrder(raw)
  }

  async markContentReady(id: string) {
    const raw = await this.client.post<RawOrder>(
      `/orders/${id}/mark-content-ready`,
    )
    return normalizeOrder(raw)
  }

  async submitForReview(id: string) {
    const raw = await this.client.post<RawOrder>(
      `/orders/${id}/submit-for-review`,
    )
    return normalizeOrder(raw)
  }

  async markPublished(id: string, url: string) {
    const raw = await this.client.post<RawOrder>(
      `/orders/${id}/mark-published`,
      { json: { url } },
    )
    return normalizeOrder(raw)
  }

  // Customer-facing delivery proof (verification checklist + status).
  deliveryProof(id: string) {
    return this.client.get<any>(`/orders/${id}/delivery-proof`)
  }

  // ── Customer review flow ──────────────────────────────────────────────────
  async approveContent(id: string) {
    const raw = await this.client.post<RawOrder>(
      `/orders/${id}/approve-content`,
    )
    return normalizeOrder(raw)
  }
  async requestRevision(id: string, notes: string) {
    const raw = await this.client.post<RawOrder>(
      `/orders/${id}/request-revision`,
      { json: { notes } },
    )
    return normalizeOrder(raw)
  }
  async confirmDelivery(id: string) {
    const raw = await this.client.post<RawOrder>(
      `/orders/${id}/confirm-delivery`,
    )
    return normalizeOrder(raw)
  }
  // Manual fallback acceptance (only valid when auto-verification FAILED/MANUAL_REVIEW).
  acceptDelivery(id: string) {
    return this.client.post<{ status: string; acceptedBy: string }>(
      `/orders/${id}/accept-delivery`,
    )
  }
  submitReview(id: string, rating: number, comment?: string) {
    return this.client.post<any>(`/orders/${id}/review`, {
      json: { rating, comment },
    })
  }
  getReview(id: string) {
    return this.client.get<{
      id: string
      rating: number
      comment: string | null
      createdAt: string
    } | null>(`/orders/${id}/review`)
  }
}
