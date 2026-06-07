import type { WithdrawalStatus } from "@guestpost/shared"
import { HttpClient, type RequestOptions } from "../client"

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  take: number
  skip: number
}

export interface PublisherBalanceResponse {
  id: string
  publisherId: string
  pendingAmount: number
  approvedAmount: number
  withdrawableAmount: number
  lifetimeEarned: number
  currency: string
}

export interface WithdrawalResponse {
  id: string
  amount: number
  currency: string
  status: WithdrawalStatus
  note: string | null
  createdAt: string
  processedAt: string | null
}

export class PublisherPayoutsService {
  constructor(private client: HttpClient) {}

  getBalance(publisherId: string) {
    return this.client.get<PublisherBalanceResponse>(`/publisher-payouts/balance/${publisherId}`)
  }

  requestWithdrawal(data: { amount: number; note?: string }) {
    return this.client.post<WithdrawalResponse>("/publishers/withdrawals", {
      json: data as unknown as Record<string, unknown>,
    })
  }

  listWithdrawals(take?: number, skip?: number) {
    return this.client.get<PaginatedResponse<WithdrawalResponse>>("/publishers/withdrawals", {
      params: { take, skip },
    } as RequestOptions)
  }
}
