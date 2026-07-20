import { Injectable } from "@nestjs/common"
import type { DepositProviderAdapter } from "./deposit-provider.interface"
import { StripeDepositAdapter } from "./stripe-deposit.adapter"

/**
 * Provider registry for customer funding. Billing owns ledger mutation; this
 * registry only selects an adapter that can create/inspect provider objects.
 */
@Injectable()
export class DepositProviderService {
  private readonly adapters = new Map<string, DepositProviderAdapter>()

  constructor(stripe: StripeDepositAdapter) {
    this.register(stripe)
  }

  register(adapter: DepositProviderAdapter) {
    if (this.adapters.has(adapter.providerName)) {
      throw new Error(
        `Deposit provider already registered: ${adapter.providerName}`,
      )
    }
    this.adapters.set(adapter.providerName, adapter)
  }

  getAdapter(providerName: string): DepositProviderAdapter {
    const adapter = this.adapters.get(providerName)
    if (!adapter) {
      throw new Error(
        `No deposit adapter registered for provider: ${providerName}`,
      )
    }
    return adapter
  }
}
