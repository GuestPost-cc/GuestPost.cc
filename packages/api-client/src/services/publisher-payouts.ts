import type { WithdrawalStatus } from "@guestpost/shared"
import type { HttpClient, RequestOptions } from "../client"

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
  publicReference: string | null
  payoutFee: number
  netAmount: number
  feePolicyVersion: string | null
  status: WithdrawalStatus
  availableAt: string | null
  payoutMethodId: string | null
  payoutMethod?: { id: string; type: string; label: string } | null
  createdAt: string
  allocations?: Array<{
    amount: number
    currency: string
    sourceType: string
    serviceType: string | null
    orderId: string | null
  }>
}

export interface PayoutMethodResponse {
  id: string
  type: string
  label: string
  isDefault: boolean
  displayDetails: Record<string, unknown>
}

export interface StripeConnectStatusResponse {
  available: boolean
  connected: boolean
  status:
    | "NOT_CONNECTED"
    | "PENDING_ONBOARDING"
    | "RESTRICTED"
    | "ENABLED"
    | "DISABLED"
  country: string | null
  defaultCurrency: string | null
  transfersEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  requirementsDue: string[]
  lastSyncedAt: string | null
  feePolicy: {
    version: string
    publisherFee: number
    providerFeesPaidBy: "platform"
  }
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
  return {
    ...raw,
    amount: num(raw.amount),
    payoutFee: num(raw.payoutFee),
    netAmount: num(raw.netAmount ?? raw.amount),
    allocations: raw.allocations?.map((allocation: any) => ({
      ...allocation,
      amount: num(allocation.amount),
    })),
  }
}

export class PublisherPayoutsService {
  constructor(private client: HttpClient) {}

  // Balance/withdrawals resolve the publisher from the session — no IDs in the path.
  async getBalance() {
    const raw = await this.client.get<any>("/publisher-payouts/balance")
    return normalizeBalance(raw)
  }

  async requestWithdrawal(data: {
    amount: number
    method: string
    payoutMethodId?: string
    idempotencyKey: string
  }) {
    const raw = await this.client.post<any>("/publisher-payouts/withdrawals", {
      json: data as unknown as Record<string, unknown>,
    })
    return normalizeWithdrawal(raw)
  }

  async listWithdrawals(take?: number, skip?: number) {
    const raw = await this.client.get<PaginatedResponse<any>>(
      "/publisher-payouts/withdrawals",
      {
        params: { take, skip },
      } as RequestOptions,
    )
    return { ...raw, items: (raw.items ?? []).map(normalizeWithdrawal) }
  }

  listPayoutMethods() {
    return this.client.get<PayoutMethodResponse[]>(
      "/publisher-payouts/payout-methods",
    )
  }

  getStripeConnectStatus() {
    return this.client.get<StripeConnectStatusResponse>(
      "/publisher-payouts/stripe-connect/status",
    )
  }

  createStripeConnectOnboardingLink() {
    return this.client.post<{ url: string; expiresAt: string }>(
      "/publisher-payouts/stripe-connect/onboarding-link",
    )
  }

  refreshStripeConnectStatus() {
    return this.client.post<StripeConnectStatusResponse>(
      "/publisher-payouts/stripe-connect/refresh",
    )
  }

  createPayoutMethod(data: {
    type: string
    label: string
    details: Record<string, unknown>
    isDefault?: boolean
  }) {
    return this.client.post<PayoutMethodResponse>(
      "/publisher-payouts/payout-methods",
      {
        json: data as unknown as Record<string, unknown>,
      },
    )
  }

  deactivatePayoutMethod(id: string) {
    return this.client.post<{ id: string; isActive: boolean }>(
      `/publisher-payouts/payout-methods/${id}/deactivate`,
    )
  }
}
