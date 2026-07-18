import type {
  OrderStatus,
  ReconciliationReport,
  ServiceType,
  SettlementStatus,
  TicketStatus,
  WithdrawalStatus,
} from "@guestpost/shared"
import type { HttpClient, RequestOptions } from "../client"
import type {
  CancellationMutationData,
  CancellationPreviewResponse,
  CancellationRequestResponse,
  CancellationRequestStatus,
} from "./orders"

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

export type MoneyByCurrency = Record<string, number>

export interface AdminStaffPerformanceItem {
  id: string
  email: string
  name: string | null
  banned: boolean
  createdAt: string
  staffRole: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE" | null
  permissions: unknown
  metrics: {
    activeAssigned: number
    totalAssigned: number
    claimed: number
    completed: number
    salesByCurrency: MoneyByCurrency
    financeApprovals: number
    financeVolumeByCurrency: MoneyByCurrency
    withdrawalsApproved: number
    auditActions: number
    lastActivityAt: string | null
  }
}

export interface AdminStaffPerformanceResponse {
  summary: {
    totalStaff: number
    superAdmins: number
    operations: number
    finance: number
    activeAssignments: number
    totalClaimed: number
    salesByCurrency: MoneyByCurrency
  }
  items: AdminStaffPerformanceItem[]
}

export type OperationsInboxView =
  | "active"
  | "available"
  | "waiting"
  | "ready"
  | "verification"
  | "history"

export type OperationsNextAction =
  | "CLAIM"
  | "ACCEPT"
  | "CONTENT"
  | "WAITING_CUSTOMER"
  | "PUBLISH"
  | "VERIFICATION"
  | "CANCELLATION"
  | "VIEW"

export interface OperationsAssignmentResponse {
  id: string
  orderId: string
  assignedToUserId: string
  assignedByUserId: string
  assignedAt: string
  completedAt: string | null
  status: "ASSIGNED" | "IN_PROGRESS" | "DELIVERED" | "CANCELLED"
  version: number
  createdAt: string
  updatedAt: string
}

export interface OperationsInboxOrder {
  id: string
  type: ServiceType
  title: string | null
  status: OrderStatus
  amount: string | number | null
  currency: string
  version: number
  turnaroundDays: number | null
  fulfillmentDueAt: string | null
  createdAt: string
  updatedAt: string
  website: {
    id: string
    name: string | null
    url: string
    domain: string
  } | null
  customer: { id: string; name: string | null } | null
  organization: { id: string; name: string } | null
  fulfillmentAssignments: OperationsAssignmentResponse[]
  activeDeliveryVersion: {
    id: string
    verificationStatus: string
    verificationFailureReason: string | null
    publishedUrl: string
  } | null
  cancellationRequests: CancellationRequestResponse[]
  claimable: boolean
  canProgress: boolean
  nextAction: OperationsNextAction
}

export interface OperationsInboxResponse
  extends PaginatedResponse<OperationsInboxOrder> {
  summary: {
    myActive: number
    available: number
    waitingCustomer: number
    readyToPublish: number
    overdue: number
    verificationTotal: number
    verificationIssues: number
    totalAssigned: number
    claimed: number
    completed: number
    salesByCurrency: MoneyByCurrency
  } | null
}

export interface OperationsOrderDetail extends OperationsInboxOrder {
  instructions: string | null
  targetUrl: string | null
  anchorText: string | null
  publishedUrl: string | null
  acceptedAt: string | null
  briefData: Record<string, unknown> | null
  items: Array<{
    id: string
    targetUrl: string | null
    anchorText: string | null
    website: { id: string; url: string; domain: string } | null
  }>
  contentOrder: {
    id: string
    title: string | null
    brief: string | null
    deliverable: string | null
    status: string
  } | null
  revisions: Array<{
    id: string
    notes: string | null
    status: string
    createdAt: string
  }>
  events: AdminOrderTimelineEvent[]
  activeDeliveryVersion:
    | (OperationsInboxOrder["activeDeliveryVersion"] & {
        evidence: Array<{
          id: string
          httpStatus: number
          anchorFound: boolean
          linkFound: boolean
          targetUrlMatched: boolean
          checkedAt: string
        }>
        fraudFlags: Array<{
          id: string
          type: string
          details: unknown
          createdAt: string
        }>
      })
    | null
  access: {
    claimable: boolean
    canProgress: boolean
    readOnly: boolean
  }
}

export interface AdminDeliveryVerificationQueueItem {
  orderId: string
  status: OrderStatus
  title: string | null
  amount: string | number | null
  targetUrl: string | null
  anchorText: string | null
  createdAt: string
  customer: { id: string; name: string | null; email: string } | null
  website: {
    id: string
    name: string | null
    url: string
    domain: string | null
    ownershipType: "PUBLISHER" | "PLATFORM"
  } | null
  publisher: {
    id: string
    name: string
    email: string | null
    tier: string
  } | null
  deliveryVersion: {
    id: string
    version: number
    verificationStatus:
      | "PENDING"
      | "VERIFIED"
      | "FAILED"
      | "MANUAL_REVIEW"
      | "RETRYING"
    verificationFailureReason: string | null
    publishedUrl: string
    submittedAt: string
    verificationVersion: number
    adminOverrideReason: string | null
    adminVerifiedNotes: string | null
    evidence: {
      httpStatus: number
      resolvedUrl: string | null
      anchorFound: boolean
      linkFound: boolean
      targetUrlMatched: boolean
      redirectChain: unknown
      checkedAt: string
    } | null
    fraudFlags: Array<{ type: string; details: unknown }>
  } | null
  priority: {
    score: number
    label: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
  }
}

export interface AdminOrderTimelineEvent {
  id: string
  eventType: string
  message?: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export interface AdminOrderDetailResponse {
  id: string
  type: string
  title: string | null
  instructions: string | null
  status: OrderStatus
  paymentStatus: string
  amount: string | number | null
  currency: string
  createdAt: string
  updatedAt: string
  version: number
  autoAcceptAt: string | null
  verifyMethod: string | null
  deliveryAcceptedMethod: string | null
  organization?: { id: string; name: string; slug: string } | null
  events: AdminOrderTimelineEvent[]
  customer?: {
    id: string
    name: string | null
    email: string
    userType: string
  } | null
  website?: {
    id: string
    url: string
    ownershipType?: string
    managedBy?: {
      id: string
      name: string | null
      email: string
    } | null
    publisher?: {
      id: string
      name: string | null
      email: string | null
      tier?: string
      profile?: { trustScore: number | null } | null
    } | null
  } | null
  items?: Array<{
    id: string
    targetUrl: string | null
    anchorText: string | null
    website: { id: string; url: string } | null
  }>
  activeDeliveryVersion?: {
    id: string
    publishedUrl: string
    verificationStatus: string
    adminVerifiedBy?: { id: string; name: string | null } | null
    adminOverrideReason: string | null
    adminVerifiedNotes: string | null
    fraudFlags: Array<{
      id: string
      type: string
      details: unknown
      createdAt: string
    }>
    screenshotUrl: string | null
    evidence: Array<{
      id: string
      httpStatus: number
      anchorFound: boolean
      linkFound: boolean
      targetUrlMatched: boolean
      checkedAt: string
    }>
  } | null
  settlements?: Array<{
    id: string
    status: SettlementStatus
    grossAmount: string | number
    platformFee: string | number
    publisherAmount: string | number
    releasePolicy: string
    reviewEndsAt: string | null
    approvals?: Array<{
      id: string
      type: string
      approvedBy: string
      approvedByUser: {
        id: string
        name: string | null
        email: string
      } | null
      roleAtTime: string
      approvedAt: string
    }>
  }>
  dispute?: { id: string; status: string } | null
}

export interface AdminCancellationRequestResponse
  extends CancellationRequestResponse {
  order: {
    id: string
    title: string | null
    status: OrderStatus
    amount: string | number | null
    currency: string
    fulfillmentChannel: "PUBLISHER" | "PLATFORM" | null
    customer: { id: string; name: string | null; email: string }
    website: { id: string; domain: string; publisherId: string | null } | null
  }
}

export interface AdminOrderResponse {
  id: string
  type: string
  status: OrderStatus
  paymentStatus: string
  amount: number | null
  currency: string
  createdAt: string
  customer: { id: string; name: string | null; email: string } | null
  website: { id: string; url: string } | null
  items?: Array<{
    website: { id: string; url: string } | null
  }>
}

export interface AdminOpsStaffResponse {
  id: string
  name: string | null
  email: string
}

export interface AdminPlatformListingServiceResponse {
  id: string
  serviceType: string
  price: number
  currency: string
  turnaroundDays: number
  revisionRounds: number
  warrantyDays: number | null
  availability: string
  version: number
}

export interface AdminPlatformWebsiteResponse {
  id: string
  url: string
  name: string | null
  domain: string | null
  category: string | null
  language: string | null
  country: string | null
  isActive: boolean
  ownershipType: "PLATFORM" | "PUBLISHER"
  managedByUserId: string | null
  managedBy: { id: string; name: string | null; email: string } | null
  listing: {
    id: string
    title: string
    slug: string
    description: string
    status: string
    categories: Array<{ id: string; name: string; slug: string }>
    category?: { id: string; name: string; slug: string } | null
    language?: string | null
    sportsGamingAllowed?: boolean | null
    pharmacyAllowed?: boolean | null
    cryptoAllowed?: boolean | null
    backlinkCount?: number | null
    linkType?: "DOFOLLOW" | "NOFOLLOW" | "SPONSORED" | "UGC" | null
    linkValidity?:
      | "PERMANENT"
      | "FIVE_YEARS"
      | "ONE_YEAR"
      | "SIX_MONTHS"
      | "THREE_MONTHS"
      | null
    googleNews?: boolean | null
    markedSponsored?: boolean | null
    foreignLanguageAllowed?: boolean | null
    services: AdminPlatformListingServiceResponse[]
  } | null
  integrations: Array<{
    id: string
    integrationId: string
    provider: string
    integrationStatus: string
    status: string
    externalResourceId: string
    externalResourceName: string | null
    syncedAt: string | null
  }>
  createdAt: string
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

  createStaff(data: {
    email: string
    name: string
    role: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE"
    password: string
  }) {
    return this.client.post<AdminUserResponse>("/admin/staff", { json: data })
  }

  staffPerformance() {
    return this.client.get<AdminStaffPerformanceResponse>(
      "/admin/staff/performance",
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
    return this.client.get<AdminOrderDetailResponse>(`/admin/orders/${id}`)
  }
  // Emergency order intervention. Normal refunds must resolve through a
  // cancellation request or dispute so approval and responsibility are retained.
  forceCancelOrder(
    id: string,
    data: CancellationMutationData & {
      confirmationOrderId: string
      responsibility: string
    },
  ) {
    return this.client.post<any>(`/admin/orders/${id}/force-cancel`, {
      json: data as unknown as Record<string, unknown>,
    })
  }

  previewPlatformCancellation(id: string) {
    return this.client.get<CancellationPreviewResponse>(
      `/admin/orders/${id}/cancellation-preview`,
    )
  }

  listCancellationRequests(params?: {
    status?: CancellationRequestStatus
    take?: number
    skip?: number
  }) {
    return this.client.get<PaginatedResponse<AdminCancellationRequestResponse>>(
      "/admin/cancellation-requests",
      {
        params,
      } as RequestOptions,
    )
  }

  reviewCancellationRequest(
    id: string,
    data: {
      resolution: "FULL_REFUND" | "CONTINUE_ORDER" | "ESCALATE_TO_DISPUTE"
      responsibility: string
      reason: string
    },
  ) {
    return this.client.post(`/admin/cancellation-requests/${id}/review`, {
      json: data,
    })
  }

  financeApproveCancellation(id: string, reason: string) {
    return this.client.post(
      `/admin/cancellation-requests/${id}/finance-approve`,
      { json: { reason } },
    )
  }

  respondToPlatformCancellation(
    orderId: string,
    requestId: string,
    action: "ACCEPT" | "CONTEST",
    note?: string,
  ) {
    return this.client.post(
      `/admin/orders/${orderId}/cancellation-requests/${requestId}/respond`,
      { json: { action, note } },
    )
  }

  declinePlatformOrder(id: string, data: CancellationMutationData) {
    return this.client.post(`/admin/orders/${id}/decline`, {
      json: data as unknown as Record<string, unknown>,
    })
  }

  requestPlatformCancellation(id: string, data: CancellationMutationData) {
    return this.client.post(`/admin/orders/${id}/cancellation-requests`, {
      json: data as unknown as Record<string, unknown>,
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

  approveSettlement(id: string, reason: string) {
    return this.client.post(`/admin/settlements/${id}/admin-approve`, {
      json: { reason },
    })
  }

  forceApproveSettlement(id: string, reason: string) {
    return this.client.post(`/admin/settlements/${id}/force-approve`, {
      json: { reason },
    })
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
    ownerType?: string
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
        ownerType: "PUBLISHER" | "PLATFORM"
        fulfillmentType: "INTERNAL" | "PUBLISHER" | "HYBRID"
        featured: boolean
        verified: boolean
        category?: { name: string }
        organization?: { name: string }
        publisher?: { name: string }
        serviceTypes: string[]
        websiteVerificationStatus: string | null
        websiteVerifiedAt: string | null
        websiteDomain: string | null
        websiteUrl: string | null
        websiteManagedBy: {
          id: string
          name: string | null
          email: string
        } | null
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

  // Platform website aggregates include their single listing, service menu,
  // Google-link health, and Operations routing owner.
  async listPlatformWebsites() {
    const res = await this.client.get<{
      websites: AdminPlatformWebsiteResponse[]
    }>("/admin/websites", {
      params: { ownershipType: "PLATFORM" } as Record<string, string>,
    })
    return res.websites ?? []
  }

  // Site-ownership reassignment remains separate from listing/service edits.
  assignWebsite(
    websiteId: string,
    data: { managedByUserId: string | null; reason?: string },
  ) {
    return this.client.patch(`/admin/websites/${websiteId}/assign`, {
      json: data,
    })
  }
  createPlatformWebsite(data: {
    url: string
    name?: string
    listingTitle: string
    description: string
    categoryIds: string[]
    language: string
    country?: string
    sportsGamingAllowed: boolean
    pharmacyAllowed: boolean
    cryptoAllowed: boolean
    backlinkCount: number
    linkType: "DOFOLLOW" | "NOFOLLOW" | "SPONSORED" | "UGC"
    linkValidity:
      | "PERMANENT"
      | "FIVE_YEARS"
      | "ONE_YEAR"
      | "SIX_MONTHS"
      | "THREE_MONTHS"
    googleNews: boolean
    markedSponsored: boolean
    foreignLanguageAllowed: boolean
    managedByUserId?: string
  }) {
    return this.client.post<any>("/admin/websites", { json: data })
  }
  getPlatformWebsite(websiteId: string) {
    return this.client.get<AdminPlatformWebsiteResponse>(
      `/admin/websites/${websiteId}`,
    )
  }
  updatePlatformWebsite(
    websiteId: string,
    data: {
      name?: string
      listingTitle?: string
      description?: string
      categoryIds?: string[]
      language?: string
      country?: string
      sportsGamingAllowed?: boolean
      pharmacyAllowed?: boolean
      cryptoAllowed?: boolean
      backlinkCount?: number
      linkType?: "DOFOLLOW" | "NOFOLLOW" | "SPONSORED" | "UGC"
      linkValidity?:
        | "PERMANENT"
        | "FIVE_YEARS"
        | "ONE_YEAR"
        | "SIX_MONTHS"
        | "THREE_MONTHS"
      googleNews?: boolean
      markedSponsored?: boolean
      foreignLanguageAllowed?: boolean
    },
  ) {
    return this.client.put<AdminPlatformWebsiteResponse>(
      `/admin/websites/${websiteId}`,
      { json: data },
    )
  }
  listOpsStaff() {
    return this.client.get<AdminOpsStaffResponse[]>("/admin/staff/operations")
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
  operationsInbox(params?: {
    view?: OperationsInboxView
    take?: number
    skip?: number
    search?: string
    includeSummary?: boolean
  }) {
    return this.client.get<OperationsInboxResponse>("/operations/fulfillment", {
      params: params as Record<string, string | number | boolean | undefined>,
    } as RequestOptions)
  }
  operationsOrder(orderId: string) {
    return this.client.get<OperationsOrderDetail>(
      `/operations/fulfillment/${orderId}`,
    )
  }
  fulfillmentQueue() {
    return this.client.get<any[]>("/operations/fulfillment-queue")
  }
  claimOrder(orderId: string) {
    return this.client.post(`/orders/${orderId}/claim`)
  }
  acceptPlatformOrder(orderId: string) {
    return this.client.post(`/admin/orders/${orderId}/accept`)
  }
  savePlatformContent(orderId: string, content: string) {
    return this.client.post(`/admin/orders/${orderId}/submit-content`, {
      json: { content },
    })
  }
  submitPlatformContentForReview(orderId: string, content: string) {
    return this.client.post(
      `/admin/orders/${orderId}/submit-content-for-review`,
      { json: { content } },
    )
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
    responsibility?: string,
  ) {
    return this.client.post<any>(`/admin/disputes/${disputeId}/resolve`, {
      json: { action, resolution, responsibility },
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

  // ── Phase 8 — Delivery verification queue (admin) ──

  listVerificationQueue() {
    return this.client.get<AdminDeliveryVerificationQueueItem[]>(
      "/admin/verification-queue",
    )
  }

  retryVerification(id: string) {
    return this.client.post<any>(`/admin/verification-queue/${id}/retry`)
  }

  markVerified(id: string, body: { reason: string; notes?: string }) {
    return this.client.post<any>(
      `/admin/verification-queue/${id}/mark-verified`,
      { json: body },
    )
  }

  rejectVerification(id: string, body: { reason: string }) {
    return this.client.post<any>(`/admin/verification-queue/${id}/reject`, {
      json: body,
    })
  }

  requestReverify(id: string, body: { ticketId: string }) {
    return this.client.post<any>(
      `/admin/verification-queue/${id}/request-reverify`,
      { json: body },
    )
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
