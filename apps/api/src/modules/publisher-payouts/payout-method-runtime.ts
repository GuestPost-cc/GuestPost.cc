import {
  isFinanceOperationAllowed,
  type PayoutMethodRuntimeCapabilities,
  resolveFinanceRuntimeMode,
} from "@guestpost/shared"
import { isStripeFeatureEnabled } from "../../common/stripe-client"

export function areManualBankPayoutsEnabled(): boolean {
  return (
    process.env.PAYOUT_LEGACY_METHODS_ENABLED === "true" ||
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test"
  )
}

export function currentPayoutMethodRuntime(): PayoutMethodRuntimeCapabilities {
  const finance = resolveFinanceRuntimeMode(
    process.env.FINANCE_RUNTIME_MODE,
    process.env.NODE_ENV,
  )
  return {
    newLiabilityOperationsEnabled: isFinanceOperationAllowed(
      finance.mode,
      "new_liability",
    ),
    manualBankPayoutsEnabled: areManualBankPayoutsEnabled(),
    stripeConnectPayoutsEnabled: isStripeFeatureEnabled("connect"),
  }
}
