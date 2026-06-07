import type { OrderStatus, SettlementStatus, WithdrawalStatus } from "@guestpost/shared"
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
  serviceType: string
  status: OrderStatus
  amount: number | null
  currency: string
  createdAt: string
  customer: { id: string; name: string | null; email: string }
  items: Array<{
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
    return this.client.post(`/admin/settlements/${id}/approve`)
  }

  listWithdrawals(take?: number, skip?: number) {
    return this.client.get<PaginatedResponse<AdminWithdrawalResponse>>("/admin/withdrawals", {
      params: { take, skip },
    } as RequestOptions)
  }

  approveWithdrawal(id: string) {
    return this.client.post(`/admin/withdrawals/${id}/approve`)
  }

  rejectWithdrawal(id: string, note?: string) {
    return this.client.post(`/admin/withdrawals/${id}/reject`, {
      json: note ? { note } : {},
    })
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

  listFlags(params?: { status?: string; severity?: string }) {
    return this.client.get("/admin/marketplace/flags", { params: params as Record<string, string | undefined> })
  }

  resolveFlag(flagId: string, resolution: string) {
    return this.client.post(`/admin/marketplace/flags/${flagId}/resolve`, { json: { resolution } })
  }
}
