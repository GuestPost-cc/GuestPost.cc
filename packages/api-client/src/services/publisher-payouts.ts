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

// Prisma Decimal columns serialize as STRINGS over JSON. Every money field
// must be coerced here, once — page-level arithmetic on raw responses turns
// `0 + "200"` into "0200" (string concat) and `.toFixed` crashes.
function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function normalizeBalance(raw: any): PublisherBalanceResponse {
  return {
    publisherId: raw.publisherId,
    pendingBalance: num(raw.pendingBalance),
    approvedBalance: num(raw.approvedBalance),
    withdrawableBalance: num(raw.withdrawableBalance),
    debtBalance: num(raw.debtBalance),
    lifetimeEarnings: num(raw.lifetimeEarnings),
    lifetimePaid: num(raw.lifetimePaid),
  }
}

function normalizeWithdrawal(raw: any): WithdrawalResponse {
  return { ...raw, amount: num(raw.amount) }
}

export class PublisherPayoutsService {
  constructor(private client: HttpClient) {}

  // Balance/withdrawals resolve the publisher from the session — no IDs in the path.
  async getBalance() {
    const raw = await this.client.get<any>("/publisher-payouts/balance")
    return normalizeBalance(raw)
  }

  async requestWithdrawal(data: { amount: number; method?: string; payoutMethodId?: string; idempotencyKey?: string }) {
    const raw = await this.client.post<any>("/publisher-payouts/withdrawals", {
      json: data as unknown as Record<string, unknown>,
    })
    return normalizeWithdrawal(raw)
  }

  async listWithdrawals(take?: number, skip?: number) {
    const raw = await this.client.get<PaginatedResponse<any>>("/publisher-payouts/withdrawals", {
      params: { take, skip },
    } as RequestOptions)
    return { ...raw, items: (raw.items ?? []).map(normalizeWithdrawal) }
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
