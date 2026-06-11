import type { OrderStatus, SettlementStatus, WithdrawalStatus, TicketStatus } from "@guestpost/shared"
import { HttpClient, type RequestOptions } from "../client"

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
  note: string | null
  createdAt: string
  publisher: { id: string; name: string | null; email: string }
}

export class AdminService {
  constructor(private client: HttpClient) {}

  listUsers() {
    return this.client.get<AdminUserResponse[]>("/admin/users")
  }

  updateUserRole(userId: string, role: string) {
    return this.client.patch(`/admin/users/${userId}/role`, { json: { role } })
  }

  updateStaffRole(userId: string, role: string) {
    return this.client.patch(`/admin/users/${userId}/staff-role`, { json: { role } })
  }

  listOrganizations() {
    return this.client.get<Array<{
      id: string
      name: string
      slug: string
      plan: string | null
      createdAt: string
      _count: { memberships: number; campaigns: number; orders: number }
    }>>("/admin/organizations")
  }

  listOrders() {
    return this.client.get<AdminOrderResponse[]>("/admin/orders")
  }

  getOrderById(id: string) {
    return this.client.get(`/admin/orders/${id}`)
  }

  listSettlements(take?: number, skip?: number) {
    return this.client.get<PaginatedResponse<AdminSettlementResponse>>("/admin/settlements", {
      params: { take, skip },
    } as RequestOptions)
  }

  approveSettlement(id: string) {
    return this.client.post(`/admin/settlements/${id}/admin-approve`)
  }

  listWithdrawals(take?: number, skip?: number) {
    return this.client.get<PaginatedResponse<AdminWithdrawalResponse>>("/admin/withdrawals", {
      params: { take, skip },
    } as RequestOptions)
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
    return this.client.post<{ executionId: string; status: string; providerExecutionId: string | null }>(
      `/admin/withdrawals/${withdrawalId}/execute`,
      { json: { providerName } },
    )
  }

  getWithdrawalExecutions(withdrawalId: string) {
    return this.client.get<Array<{
      id: string
      status: string
      amount: number
      fee: number
      errorMessage: string | null
      providerExecutionId: string | null
      createdAt: string
      provider: { id: string; name: string; displayName: string }
    }>>(`/admin/withdrawals/${withdrawalId}/executions`)
  }

  retryPayoutExecution(executionId: string) {
    return this.client.post(`/admin/payout-executions/${executionId}/retry`)
  }

  cancelPayoutExecution(executionId: string) {
    return this.client.post(`/admin/payout-executions/${executionId}/cancel`)
  }

  getReconciliation() {
    return this.client.get<{
      ranAt: string
      ok: boolean
      walletDrift: any[]
      publisherDrift: any[]
      stuckOrders: any[]
      stuckPayouts: any[]
    }>("/admin/reconciliation")
  }

  decryptPayoutMethod(payoutMethodId: string, reason: string) {
    return this.client.post<{ details: Record<string, unknown>; methodId: string; publisherId: string }>(
      `/admin/payout-methods/${payoutMethodId}/decrypt`,
      { json: { reason } },
    )
  }

  getMarketplaceStats() {
    return this.client.get<{
      totalListings: number
      activeListings: number
      totalReviews: number
      avgRating: number
      topCategories: Array<{ category: any; count: number }>
    }>("/marketplace/stats")
  }

  listMarketplaceListings(params?: {
    status?: string
    type?: string
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
        currency: string
        domainRating?: number
        traffic?: number
        featured: boolean
        verified: boolean
        category?: { name: string }
        organization?: { name: string }
        publisher?: { name: string }
        createdAt: string
      }>
      pagination: { page: number; limit: number; total: number; totalPages: number }
    }>("/admin/marketplace/listings", { params: params as Record<string, string | number | undefined> })
  }

  updateListingStatus(listingId: string, status: string) {
    return this.client.patch(`/admin/marketplace/listings/${listingId}/status`, { json: { status } })
  }

  toggleListingFeatured(listingId: string, featured: boolean) {
    return this.client.patch(`/admin/marketplace/listings/${listingId}/featured`, { json: { featured } })
  }

  toggleListingVerified(listingId: string, verified: boolean) {
    return this.client.patch(`/admin/marketplace/listings/${listingId}/verified`, { json: { verified } })
  }

  deleteListing(listingId: string) {
    return this.client.delete(`/admin/marketplace/listings/${listingId}`)
  }

  getListingReviews(listingId: string) {
    return this.client.get(`/admin/marketplace/listings/${listingId}/reviews`)
  }

  moderateReview(reviewId: string, status: "APPROVED" | "REJECTED") {
    return this.client.patch(`/admin/marketplace/reviews/${reviewId}/moderate`, { json: { status } })
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
    }>("/admin/publishers", { params: params as Record<string, string | number | undefined> })
  }

  updatePublisherTier(publisherId: string, tier: "NEW" | "TRUSTED" | "VERIFIED") {
    return this.client.patch(`/admin/publishers/${publisherId}/tier`, { json: { tier } })
  }

  // -- Support --
  // Real Ticket model: subject/status/org/customer/messages. No priority or
  // assignee fields exist in the backend — the previous types invented them.
  listTickets(params?: { status?: string; search?: string; page?: number; limit?: number }) {
    return this.client.get<{
      items: Array<{
        id: string
        subject: string
        status: TicketStatus
        customer: { id: string; name: string | null; email: string }
        organization: { id: string; name: string } | null
        messageCount: number
        createdAt: string
        updatedAt: string
      }>
      total: number
      page: number
      limit: number
      totalPages: number
    }>("/admin/support/tickets", { params: params as Record<string, string | number | undefined> })
  }

  getTicketDetail(id: string) {
    return this.client.get<{
      id: string
      subject: string
      description: string | null
      status: TicketStatus
      customer: { id: string; name: string | null; email: string }
      organization: { id: string; name: string } | null
      messages: Array<{ id: string; content: string; author: string; authorType: string; createdAt: string }>
      createdAt: string
      updatedAt: string
    }>(`/admin/support/tickets/${id}`)
  }

  updateTicketStatus(ticketId: string, status: TicketStatus) {
    return this.client.patch(`/admin/support/tickets/${ticketId}/status`, { json: { status } })
  }

  addTicketMessage(ticketId: string, data: { content: string }) {
    return this.client.post(`/admin/support/tickets/${ticketId}/messages`, { json: data })
  }

  // -- Audit Logs --
  listAuditLogs(params?: { actorId?: string; action?: string; entity?: string; entityId?: string; startDate?: string; endDate?: string; page?: number; limit?: number }) {
    return this.client.get<{
      items: Array<{
        id: string
        action: string
        entity: string
        entityId: string
        actorId: string
        actorName: string | null
        metadata: Record<string, unknown> | null
        ipAddress: string | null
        createdAt: string
      }>
      total: number
      page: number
      limit: number
      totalPages: number
    }>("/admin/audit-logs", { params: params as Record<string, string | number | undefined> })
  }
}
