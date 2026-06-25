import type { HttpClient } from "../client"

export interface TransactionResponse {
  id: string
  amount: string | number
  currency: string
  type: string
  reference: string | null
  description: string | null
  walletId: string | null
  orderId: string | null
  createdAt: string
}

export interface WalletResponse {
  id: string
  availableBalance: string | number
  reservedBalance: string | number
  currency: string
  organizationId: string | null
  userId: string | null
  version: number
  createdAt: string
  updatedAt: string
  transactions: TransactionResponse[]
}

export class BillingService {
  constructor(private client: HttpClient) {}

  getWallet() {
    return this.client.get<WalletResponse>("/billing/wallet")
  }

  deposit(data: { walletId: string; amount: number; reference?: string }) {
    return this.client.post<WalletResponse>(
      `/billing/wallet/${data.walletId}/deposit`,
      {
        json: {
          amount: data.amount,
          ...(data.reference ? { reference: data.reference } : {}),
        },
      },
    )
  }

  createCheckoutSession(data: { walletId: string; amount: number }) {
    return this.client.post<{ url: string }>(
      `/billing/wallet/${data.walletId}/checkout`,
      {
        json: { amount: data.amount },
      },
    )
  }

  withdraw(data: {
    walletId: string
    amount: number
    idempotencyKey?: string
  }) {
    return this.client.post<WalletResponse>(
      `/billing/wallet/${data.walletId}/withdraw`,
      {
        json: {
          amount: data.amount,
          ...(data.idempotencyKey
            ? { idempotencyKey: data.idempotencyKey }
            : {}),
        },
      },
    )
  }

  listTransactions() {
    return this.client.get<TransactionResponse[]>("/billing/transactions")
  }
}
