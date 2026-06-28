import type {
  OrderStatus,
  ReconciliationReport,
  SettlementStatus,
  TicketStatus,
  WithdrawalStatus,
} from "@guestpost/shared"
import type { HttpClient, RequestOptions } from "../client"

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  take: number
  skip: number
}

export interface AdminUserResponse {
  id: string
  email: string
  name: string | null
  userType: string
  customerRole: string | null
  publisherRole: string | null
  staffRole: string | null
  banned: boolean
  createdAt: string
}

export interface AdminOrderResponse {
  id: string
  type: string
  status: OrderStatus
  amount: number | null
  currency: string
  createdAt: string
  customer: { id: string; name: string | null; email: string } | null
  website: { id: string; url: string } | null
  items?: Array<{
    website: { id: string; url: string } | null
  }>
}

export interface AdminSettlementResponse {
  id: string
  orderId: string
  publisherId: string
  amount: number
  currency: string
  status: SettlementStatus
  reviewWindowEndsAt: string | null
  createdAt: string
  publisher: { id: string; name: string | null; email: string }
}

export interface AdminWithdrawalResponse {
  id: string
  publisherId: string
  amount: number
  currency: string
  status: WithdrawalStatus
  availableAt: string | null
  note: string | null
  createdAt: string
  publisher: { id: string; name: string | null; email: string }
}

export class AdminService {
  constructor(private client: HttpClient) {}

  listUsers(params?: {
    search?: string
    userType?: string
    role?: string
    status?: string
    take?: number
    skip?: number
  }) {
    return this.client.get<PaginatedResponse<AdminUserResponse>>(
      "/admin/users",
      {
        params: params as Record<string, string | number | undefined>,
      } as RequestOptions,
    )
  }

  banUser(userId: string, banned: boolean) {
    return this.client.patch(`/admin/users/${userId}/ban`, {
      json: { banned },
    })
  }

  updateUserRole(userId: string, role: string) {
    return this.client.patch(`/admin/users/${userId}/role`, { json: { role } })
  }

  updateStaffRole(userId: string, role: string) {
    return this.client.patch(`/admin/users/${userId}/staff-role`, {
      json: { role },
    })
  }

  listOrganizations() {
    return this.client.get<
      Array<{
        id: string
        name: string
        slug: string
        plan: string | null
        createdAt: string
        _count: { memberships: number; campaigns: number; orders: number }
      }>
    >("/admin/organizations")
  }

  listOrders() {
    return this.client.get<AdminOrderResponse[]>("/admin/orders")
  }

  getOrderById(id: string) {
    return this.client.get(`/admin/orders/${id}`)
  }
  // Order interventions — verification/advancement is automated; staff only
  // force-cancel (SUPER_ADMIN) or refund (SUPER_ADMIN/FINANCE), reason required.
  forceCancelOrder(id: string, reason: string) {
    return this.client.post<any>(`/admin/orders/${id}/force-cancel`, {
      json: { reason },
    })
  }
  refundOrder(id: string, reason: string) {
    return this.client.post<any>(`/admin/orders/${id}/refund`, {
      json: { reason },
    })
  }

  listSettlements(take?: number, skip?: number) {
    return this.client.get<PaginatedResponse<AdminSettlementResponse>>(
      "/admin/settlements",
      {
        params: { take, skip },
      } as RequestOptions,
    )
  }

  approveSettlement(id: string) {
    return this.client.post(`/admin/settlements/${id}/admin-approve`)
  }

  listWithdrawals(take?: number, skip?: number) {
    return this.client.get<PaginatedResponse<AdminWithdrawalResponse>>(
      "/admin/withdrawals",
      {
        params: { take, skip },
      } as RequestOptions,
    )
  }

  approveWithdrawal(id: string) {
    return this.client.patch(`/admin/withdrawals/${id}/approve`)
  }

  markWithdrawalPaid(id: string) {
    return this.client.patch(`/admin/withdrawals/${id}/mark-paid`)
  }

  rejectWithdrawal(id: string, note?: string) {
    return this.client.patch(`/admin/withdrawals/${id}/reject`, {
      json: note ? { note } : {},
    })
  }

  // FAILED -> REVERSED: restore trapped funds after a hard provider failure.
  // Reason (min 10 chars) is required and audited.
  reverseFailedWithdrawal(id: string, reason: string) {
    return this.client.post(`/admin/withdrawals/${id}/reverse`, {
      json: { reason },
    })
  }

  executePayout(withdrawalId: string, providerName: string) {
    return this.client.post<{
      executionId: string
      status: string
      providerExecutionId: string | null
    }>(`/admin/withdrawals/${withdrawalId}/execute`, { json: { providerName } })
  }

  getWithdrawalExecutions(withdrawalId: string) {
    return this.client.get<
      Array<{
        id: string
        status: string
        amount: number
        fee: number
        errorMessage: string | null
        providerExecutionId: string | null
        createdAt: string
        provider: { id: string; name: string; displayName: string }
      }>
    >(`/admin/withdrawals/${withdrawalId}/executions`)
  }

  retryPayoutExecution(executionId: string) {
    return this.client.post(`/admin/payout-executions/${executionId}/retry`)
  }

  cancelPayoutExecution(executionId: string) {
    return this.client.post(`/admin/payout-executions/${executionId}/cancel`)
  }

  getReconciliation() {
    return this.client.get<ReconciliationReport>("/admin/reconciliation")
  }

  decryptPayoutMethod(payoutMethodId: string, reason: string) {
    return this.client.post<{
      details: Record<string, unknown>
      methodId: string
      publisherId: string
    }>(`/admin/payout-methods/${payoutMethodId}/decrypt`, { json: { reason } })
  }

  getMarketplaceStats() {
    return this.client.get<{
      totalListings: number
      activeListings: number
      totalReviews: number
      avgRating: number
    }>("/admin/marketplace/stats")
  }

  listMarketplaceListings(params?: {
    status?: string
    type?: string
    search?: string
    page?: number
    limit?: number
  }) {
    return this.client.get<{
      listings: Array<{
        id: string
        title: string
        slug: string
        type: string
        status: string
        price: number
        priceFrom: number | null
        currency: string
        domainRating?: number
        traffic?: number
        featured: boolean
        verified: boolean
        category?: { name: string }
        organization?: { name: string }
        publisher?: { name: string }
        serviceTypes: string[]
        websiteVerificationStatus: string | null
        websiteVerifiedAt: string | null
        websiteDomain: string | null
        services: Array<{
          id: string
          serviceType: string
          name: string | null
          price: number
          turnaroundDays: number
          revisionRounds: number
          warrantyDays?: number | null
          availability: string
          currency: string
          version: number
          createdAt: string
          updatedAt: string
        }>
        createdAt: string
      }>
      pagination: {
        page: number
        limit: number
        total: number
        totalPages: number
      }
    }>("/admin/marketplace/listings", {
      params: params as Record<string, string | number | undefined>,
    })
  }

  // Platform-owned websites (for attaching platform listings + ownership
  // management). Phase 6.5: response carries managedByUserId + managedBy
  // for the ownership picker.
  async listPlatformWebsites() {
    const res = await this.client.get<{
      websites: Array<{
        id: string
        url: string
        name: string | null
        domain?: string | null
        ownershipType: "PLATFORM" | "PUBLISHER"
        managedByUserId?: string | null
        managedBy?: { id: string; name: string | null } | null
      }>
    }>("/admin/websites", {
      params: { ownershipType: "PLATFORM" } as Record<string, string>,
    })
    return res.websites ?? []
  }

  // Create a PLATFORM-owned marketplace listing (no publisher, INTERNAL
  // fulfillment). websiteId must be a platform-owned website or omitted.
  // Phase 2: accepts an optional services[] for the multi-service shape;
  // legacy clients pass type+price and the API shims a single service row.
  // Phase 6.5: site-ownership reassignment + OPS staff picker.
  assignWebsite(
    websiteId: string,
    data: { managedByUserId: string | null; reason?: string },
  ) {
    return this.client.patch(`/admin/websites/${websiteId}/assign`, {
      json: data,
    })
  }
  listOpsStaff() {
    return this.client.get<
      Array<{ id: string; name: string | null; email: string }>
    >("/admin/users/ops")
  }

  createPlatformListing(data: {
    title: string
    description: string
    type: string
    price: number
    turnaroundDays?: number
    websiteId?: string
    status?: string
    services?: Array<{
      serviceType: string
      price: number
      turnaroundDays: number
      currency?: string
      revisionRounds?: number
      warrantyDays?: number
      availability?: "AVAILABLE" | "PAUSED" | "WAITLIST"
    }>
  }) {
    return this.client.post<{ id: string; slug: string; status: string }>(
      "/admin/marketplace/listings",
      { json: data },
    )
  }

  updateListingStatus(listingId: string, status: string, force?: boolean) {
    return this.client.patch(
      `/admin/marketplace/listings/${listingId}/status`,
      { json: { status, force } },
    )
  }

  toggleListingFeatured(listingId: string, featured: boolean) {
    return this.client.patch(
      `/admin/marketplace/listings/${listingId}/featured`,
      { json: { featured } },
    )
  }

  toggleListingVerified(listingId: string, verified: boolean) {
    return this.client.patch(
      `/admin/marketplace/listings/${listingId}/verified`,
      { json: { verified } },
    )
  }

  deleteListing(listingId: string) {
    return this.client.delete(`/admin/marketplace/listings/${listingId}`)
  }

  getListingReviews(listingId: string) {
    return this.client.get(`/admin/marketplace/listings/${listingId}/reviews`)
  }

  // Staff listing preview by slug — returns the listing in any status.
  getListingBySlug(slug: string) {
    return this.client.get<any>(`/admin/marketplace/listings/by-slug/${slug}`)
  }

  // Admin service management (routes through marketplace service with staff flag)
  addPlatformListingService(
    listingId: string,
    data: {
      serviceType: string
      price: number
      turnaroundDays: number
      revisionRounds?: number
      warrantyDays?: number
      currency?: string
    },
  ) {
    return this.client.post(
      `/admin/marketplace/listings/${listingId}/services`,
      { json: data },
    )
  }

  updatePlatformListingService(
    listingId: string,
    serviceId: string,
    data: {
      version: number
      price?: number
      turnaroundDays?: number
      revisionRounds?: number
      availability?: string
      warrantyDays?: number
      currency?: string
    },
  ) {
    return this.client.put(
      `/admin/marketplace/listings/${listingId}/services/${serviceId}`,
      { json: data },
    )
  }

  pausePlatformListingService(listingId: string, serviceId: string) {
    return this.client.delete(
      `/admin/marketplace/listings/${listingId}/services/${serviceId}`,
    )
  }

  // -- Website verification governance + review center --
  verificationReviewCenter(
    filters: {
      publisherId?: string
      domain?: string
      status?: string
      from?: string
      to?: string
    } = {},
  ) {
    const q = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v) as [string, string][],
    ).toString()
    return this.client.get<any>(
      `/admin/websites/verification${q ? `?${q}` : ""}`,
    )
  }
  forceApprovedReport() {
    return this.client.get<any>("/admin/websites/force-approved")
  }
  bulkRetryVerification(websiteIds: string[]) {
    return this.client.post<any>("/admin/websites/verification/bulk-retry", {
      json: { websiteIds },
    })
  }
  recomputeTrust(websiteId: string) {
    return this.client.post<any>(`/admin/websites/${websiteId}/recompute-trust`)
  }

  // -- Delivery verification + fulfillment --
  fulfillmentQueue() {
    return this.client.get<any[]>("/operations/fulfillment-queue")
  }
  claimOrder(orderId: string) {
    return this.client.post(`/orders/${orderId}/claim`)
  }
  assignOrder(orderId: string, assignedToUserId: string) {
    return this.client.post(`/orders/${orderId}/assign`, {
      json: { assignedToUserId },
    })
  }
  reassignOrder(orderId: string, assignedToUserId: string) {
    return this.client.post(`/orders/${orderId}/reassign`, {
      json: { assignedToUserId },
    })
  }
  submitPlatformDelivery(
    orderId: string,
    data: { publishedUrl: string; articleTitle?: string; notes?: string },
  ) {
    return this.client.post(`/orders/${orderId}/deliveries`, { json: data })
  }
  listDeliveries(orderId: string) {
    return this.client.get<any[]>(`/orders/${orderId}/deliveries`)
  }
  getDelivery(deliveryId: string) {
    return this.client.get<any>(`/deliveries/${deliveryId}`)
  }
  orderEvidence(orderId: string) {
    return this.client.get<any[]>(`/orders/${orderId}/evidence`)
  }
  orderSnapshots(orderId: string) {
    return this.client.get<any[]>(`/orders/${orderId}/snapshots`)
  }
  orderDeliveryAudit(orderId: string) {
    return this.client.get<any[]>(`/orders/${orderId}/audit`)
  }
  disputeEvidence(disputeId: string) {
    return this.client.get<any>(`/disputes/${disputeId}/evidence`)
  }
  listDisputes(params?: { status?: string; page?: number; limit?: number }) {
    const q = new URLSearchParams()
    if (params?.status) q.set("status", params.status)
    if (params?.page) q.set("page", String(params.page))
    if (params?.limit) q.set("limit", String(params.limit))
    const qs = q.toString()
    return this.client.get<any>(`/admin/disputes${qs ? `?${qs}` : ""}`)
  }
  reviewDispute(disputeId: string) {
    return this.client.post<any>(`/admin/disputes/${disputeId}/review`)
  }
  resolveDispute(
    disputeId: string,
    action: "RESTORE" | "REFUND" | "REJECT",
    resolution: string,
  ) {
    return this.client.post<any>(`/admin/disputes/${disputeId}/resolve`, {
      json: { action, resolution },
    })
  }
  reverifyDelivery(deliveryId: string) {
    return this.client.post(`/deliveries/${deliveryId}/reverify`)
  }
  manualApproveDelivery(deliveryId: string, reason: string) {
    return this.client.post(`/deliveries/${deliveryId}/manual-approve`, {
      json: { reason },
    })
  }
  manualRejectDelivery(deliveryId: string, reason: string) {
    return this.client.post(`/deliveries/${deliveryId}/manual-reject`, {
      json: { reason },
    })
  }
  overrideDelivery(
    deliveryId: string,
    targetStatus: "VERIFIED" | "FAILED",
    reason: string,
  ) {
    return this.client.post(`/deliveries/${deliveryId}/override`, {
      json: { targetStatus, reason },
    })
  }

  moderateReview(reviewId: string, status: "APPROVED" | "REJECTED") {
    return this.client.patch(
      `/admin/marketplace/reviews/${reviewId}/moderate`,
      { json: { status } },
    )
  }

  // -- Publishers --
  // Backed by GET /admin/publishers. The backend's trust lever is the tier
  // (NEW/TRUSTED/VERIFIED — drives withdrawal holds); there is no separate
  // approve/suspend workflow, so none is exposed here.
  listPublishers(params?: { search?: string; page?: number; limit?: number }) {
    return this.client.get<{
      items: Array<{
        id: string
        name: string | null
        email: string | null
        tier: "NEW" | "TRUSTED" | "VERIFIED"
        trustScore: number | null
        rating: number | null
        totalReviews: number
        completionRate: number | null
        websiteCount: number
        listingCount: number
        settlementCount: number
        withdrawableBalance: number
        lifetimeEarnings: number
        debtBalance: number
        ownerBanned: boolean
        createdAt: string
      }>
      total: number
      page: number
      limit: number
      totalPages: number
    }>("/admin/publishers", {
      params: params as Record<string, string | number | undefined>,
    })
  }

  updatePublisherTier(
    publisherId: string,
    tier: "NEW" | "TRUSTED" | "VERIFIED",
  ) {
    return this.client.patch(`/admin/publishers/${publisherId}/tier`, {
      json: { tier },
    })
  }
  recomputePublisherTrust(publisherId: string) {
    return this.client.post<{ score: number; band: string; tier: string }>(
      `/admin/publishers/${publisherId}/recompute-trust`,
    )
  }

  // -- Support --
  // Phase 6.6: admin endpoints delegate to the channel-aware SupportService.
  // The participant matrix (Finance read-only on PLATFORM, INTERNAL notes
  // staff-only, OPS limited to their assigned tickets) is enforced server-side.
  listTickets(params?: {
    status?: string
    search?: string
    channel?: "PLATFORM" | "PUBLISHER"
    assignedToUserId?: string | "UNASSIGNED"
    page?: number
    limit?: number
  }) {
    return this.client.get<{
      items: Array<{
        id: string
        subject: string
        status: TicketStatus
        fulfillmentChannel: "PUBLISHER" | "PLATFORM" | null
        assignedTo: { id: string; name: string | null } | null
        assignedPublisher: { id: string; name: string | null } | null
        customer: { id: string; name: string | null; email: string }
        organization: { id: string; name: string } | null
        order: {
          id: string
          title: string | null
          status: string
          type: string
          fulfillmentChannel: string | null
        } | null
        messageCount: number
        createdAt: string
        updatedAt: string
      }>
      total: number
      page: number
      limit: number
      totalPages: number
    }>("/admin/support/tickets", {
      params: params as Record<string, string | number | undefined>,
    })
  }

  getTicketDetail(id: string) {
    return this.client.get<{
      id: string
      subject: string
      description: string | null
      status: TicketStatus
      fulfillmentChannel: "PUBLISHER" | "PLATFORM" | null
      assignedTo: { id: string; name: string | null } | null
      assignedPublisher: { id: string; name: string | null } | null
      user: { id: string; name: string | null; email: string; userType: string }
      organization: { id: string; name: string } | null
      order: {
        id: string
        title: string | null
        status: string
        type: string
        fulfillmentChannel: string | null
      } | null
      messages: Array<{
        id: string
        content: string
        visibility: "PUBLIC" | "INTERNAL"
        // Phase 6.6.1: role-at-write-time + message classification snapshot.
        participantRole: "CUSTOMER" | "PUBLISHER" | "OPS" | "ADMIN" | "FINANCE"
        messageType: "MESSAGE" | "INTERNAL_NOTE" | "SYSTEM_EVENT"
        // Phase 6.6.2: uncollapsed role snapshot for forensic queries.
        // Nullable on pre-migration rows.
        actorSnapshot: {
          kind: "CUSTOMER" | "PUBLISHER" | "STAFF"
          staffRole: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE" | null
          organizationRole: "OWNER" | "MEMBER" | null
          publisherRole: "PUBLISHER_OWNER" | "PUBLISHER_MEMBER" | null
        } | null
        createdAt: string
        user: {
          id: string
          name: string | null
          email: string
          userType: string
        } | null
      }>
      createdAt: string
      updatedAt: string
    }>(`/admin/support/tickets/${id}`)
  }

  updateTicketStatus(ticketId: string, status: TicketStatus) {
    return this.client.patch(`/admin/support/tickets/${ticketId}/status`, {
      json: { status },
    })
  }

  // Phase 6.6: visibility is optional; defaults to PUBLIC. Staff frontends
  // pass "INTERNAL" to leave a note that's invisible to the customer and
  // publisher.
  addTicketMessage(
    ticketId: string,
    data: { content: string; visibility?: "PUBLIC" | "INTERNAL" },
  ) {
    return this.client.post(`/admin/support/tickets/${ticketId}/messages`, {
      json: data,
    })
  }

  reassignTicket(
    ticketId: string,
    body: {
      assignedToUserId?: string | null
      assignedPublisherId?: string | null
      reason?: string
    },
  ) {
    return this.client.patch(`/support/tickets/${ticketId}/reassign`, {
      json: body,
    })
  }

  // -- Audit Logs --
  // Phase 7.7 A2: requestId filter is EXACT-MATCH only (identifier, not text);
  // backend rejects fuzzy operators. The returned `requestId` field carries
  // the indexed column value (Phase 7.7 A1) with fallback to legacy
  // metadata.requestId for pre-backfill rows.
  listAuditLogs(params?: {
    actorId?: string
    action?: string
    entity?: string
    entityId?: string
    requestId?: string
    startDate?: string
    endDate?: string
    page?: number
    limit?: number
  }) {
    return this.client.get<{
      items: Array<{
        id: string
        action: string
        entity: string
        entityId: string
        actorId: string
        actorName: string | null
        metadata: Record<string, unknown> | null
        requestId: string | null
        ipAddress: string | null
        createdAt: string
      }>
      total: number
      page: number
      limit: number
      totalPages: number
    }>("/admin/audit-logs", {
      params: params as Record<string, string | number | undefined>,
    })
  }

  // ── Phase 7.1 — PlatformRevenue dashboard (GET /admin/finance/revenue) ──

  /**
   * Aggregated platform revenue. Buckets grouped per `groupBy`. Totals carry
   * a same-duration previous-period comparison and `deltaPct` (null when the
   * previous window has zero gross — UI hides the delta cap instead of
   * showing "+∞%" / "NaN%"). `meta.currencyMismatch` is populated when any
   * Order in the range was non-USD (PlatformRevenue itself has no currency
   * column today; the safety check lives at the Order layer).
   */
  getRevenue(params: {
    from?: string
    to?: string
    groupBy: "channel" | "month" | "serviceType" | "listing"
  }) {
    return this.client.get<RevenueResponse>("/admin/finance/revenue", {
      params: params as Record<string, string | number | undefined>,
    })
  }

  /**
   * CSV export — same filters/grouping; returns the raw CSV text. Caller is
   * responsible for triggering a download (e.g. `Blob` + `URL.createObjectURL`).
   *
   * Use this for in-memory exports. For large date ranges, prefer hitting
   * `/api/v1/admin/finance/revenue?format=csv&...` directly via a link so the
   * browser streams it without ever materializing the full body in JS.
   */
  exportRevenueCsv(params: {
    from?: string
    to?: string
    groupBy: "channel" | "month" | "serviceType" | "listing"
  }) {
    return this.client.get<string>("/admin/finance/revenue", {
      params: { ...params, format: "csv" } as Record<
        string,
        string | number | undefined
      >,
    })
  }
}

// Response shape — kept in sync with apps/api/src/modules/admin/finance/revenue.service.ts
export interface RevenueBucket {
  bucket: string
  bucketKey: string
  // Populated only when groupBy="listing"
  listingServiceId?: string | null
  listingId?: string | null
  listingTitle?: string | null
  grossAmount: string
  platformFee: string
  netRevenue: string
  rowCount: number
  reversedCount: number
  currency: string
}

export interface RevenueTotalsSlice {
  grossAmount: string
  platformFee: string
  netRevenue: string
  rowCount: number
  reversedCount: number
  currency: string
}

export interface RevenueDeltaPct {
  grossAmount: number
  platformFee: number
  netRevenue: number
}

export interface RevenueCurrencyMismatch {
  rowCount: number
  distinctCurrencies: string[]
}

export interface RevenueResponse {
  buckets: RevenueBucket[]
  totals: {
    current: RevenueTotalsSlice
    previous: RevenueTotalsSlice | null
    deltaPct: RevenueDeltaPct | null
  }
  meta: {
    from: string | null
    to: string | null
    groupBy: "channel" | "month" | "serviceType" | "listing"
    timezone: "UTC"
    currencyMismatch: RevenueCurrencyMismatch | null
  }
}
