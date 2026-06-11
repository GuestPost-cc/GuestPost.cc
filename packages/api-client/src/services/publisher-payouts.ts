import type { WithdrawalStatus } from "@guestpost/shared"
import { HttpClient, type RequestOptions } from "../client"

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  take: number
  skip: number
}

export interface PublisherBalanceResponse {
  publisherId: string
  pendingBalance: number
  approvedBalance: number
  withdrawableBalance: number
  debtBalance: number
  lifetimeEarnings: number
  lifetimePaid: number
}

export interface WithdrawalResponse {
  id: string
  amount: number
  currency: string
  status: WithdrawalStatus
  availableAt: string | null
  payoutMethodId: string | null
  payoutMethod?: { id: string; type: string; label: string } | null
  createdAt: string
}

export interface PayoutMethodResponse {
  id: string
  type: string
  label: string
  isDefault: boolean
  displayDetails: Record<string, unknown>
}

export class PublisherPayoutsService {
  constructor(private client: HttpClient) {}

  // Balance/withdrawals resolve the publisher from the session — no IDs in the path.
  getBalance() {
    return this.client.get<PublisherBalanceResponse>("/publisher-payouts/balance")
  }

  requestWithdrawal(data: { amount: number; method?: string; payoutMethodId?: string; idempotencyKey?: string }) {
    return this.client.post<WithdrawalResponse>("/publisher-payouts/withdrawals", {
      json: data as unknown as Record<string, unknown>,
    })
  }

  listWithdrawals(take?: number, skip?: number) {
    return this.client.get<PaginatedResponse<WithdrawalResponse>>("/publisher-payouts/withdrawals", {
      params: { take, skip },
    } as RequestOptions)
  }

  listPayoutMethods() {
    return this.client.get<PayoutMethodResponse[]>("/publisher-payouts/payout-methods")
  }

  createPayoutMethod(data: { type: string; label: string; details: Record<string, unknown>; isDefault?: boolean }) {
    return this.client.post<PayoutMethodResponse>("/publisher-payouts/payout-methods", {
      json: data as unknown as Record<string, unknown>,
    })
  }

  deactivatePayoutMethod(id: string) {
    return this.client.post<{ id: string; isActive: boolean }>(`/publisher-payouts/payout-methods/${id}/deactivate`)
  }
}
