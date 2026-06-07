import { HttpClient } from "../client"

export class BillingService {
  constructor(private client: HttpClient) {}

  getWallet() {
    return this.client.get<{ id: string; balance: number; currency: string }>("/billing/wallet")
  }

  deposit(data: { amount: number; paymentMethodId?: string }) {
    return this.client.post<{ transactionId: string; newBalance: number }>("/billing/wallet/deposit", { json: data })
  }

  withdraw(data: { amount: number }) {
    return this.client.post<{ transactionId: string; newBalance: number }>("/billing/wallet/withdraw", { json: data })
  }

  listTransactions() {
    return this.client.get<Array<{ id: string; type: string; amount: number; status: string; createdAt: string }>>(
      "/billing/transactions",
    )
  }
}
