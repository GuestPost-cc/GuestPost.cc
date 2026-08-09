import { USD_CURRENCY } from "./money"

export const CERTIFIED_WITHDRAWAL_METHOD_TYPES = [
  "bank_transfer",
  "stripe_connect",
] as const

export type CertifiedWithdrawalMethodType =
  (typeof CERTIFIED_WITHDRAWAL_METHOD_TYPES)[number]

export type PayoutMethodEligibilityCode =
  | "READY"
  | "INACTIVE"
  | "FINANCE_OPERATIONS_PAUSED"
  | "METHOD_NOT_CERTIFIED"
  | "MANUAL_BANK_DISABLED"
  | "STRIPE_CONNECT_DISABLED"
  | "PROVIDER_BINDING_INVALID"
  | "STRIPE_ACCOUNT_NOT_READY"

export interface PayoutMethodEligibility {
  executable: boolean
  canReactivate: boolean
  code: PayoutMethodEligibilityCode
  message: string
}

export interface PayoutMethodRuntimeCapabilities {
  newLiabilityOperationsEnabled: boolean
  manualBankPayoutsEnabled: boolean
  stripeConnectPayoutsEnabled: boolean
}

export interface PayoutMethodEligibilityInput {
  publisherId: string
  type: unknown
  isActive: boolean
  providerAccountId?: string | null
  providerAccount?: {
    publisherId?: unknown
    provider?: unknown
    isActive?: unknown
    status?: unknown
    transfersEnabled?: unknown
    payoutsEnabled?: unknown
    detailsSubmitted?: unknown
    payoutScheduleConfigured?: unknown
    defaultCurrency?: unknown
  } | null
}

export function isCertifiedWithdrawalMethodType(
  value: unknown,
): value is CertifiedWithdrawalMethodType {
  return (
    typeof value === "string" &&
    CERTIFIED_WITHDRAWAL_METHOD_TYPES.includes(
      value as CertifiedWithdrawalMethodType,
    )
  )
}

function ineligible(
  code: Exclude<PayoutMethodEligibilityCode, "READY" | "INACTIVE">,
  message: string,
): PayoutMethodEligibility {
  return { executable: false, canReactivate: false, code, message }
}

/**
 * The code-owned payout routing contract used before a publisher can reserve
 * liability. Feature flags may pause a certified route, but they never make a
 * new provider executable. Callers must still lock and re-read the method and
 * provider account before committing a withdrawal.
 */
export function evaluatePayoutMethodEligibility(
  method: PayoutMethodEligibilityInput,
  runtime: PayoutMethodRuntimeCapabilities,
): PayoutMethodEligibility {
  if (!isCertifiedWithdrawalMethodType(method.type)) {
    return ineligible(
      "METHOD_NOT_CERTIFIED",
      "This legacy payout method is not certified for new withdrawals. Disable it and connect a supported payout method.",
    )
  }

  if (!runtime.newLiabilityOperationsEnabled) {
    return ineligible(
      "FINANCE_OPERATIONS_PAUSED",
      "New withdrawals are temporarily paused by operations. Retry later or contact support.",
    )
  }

  if (method.type === "bank_transfer") {
    if (method.providerAccountId) {
      return ineligible(
        "PROVIDER_BINDING_INVALID",
        "This manual bank method has an invalid provider binding and requires support review.",
      )
    }
    if (
      !runtime.manualBankPayoutsEnabled ||
      runtime.stripeConnectPayoutsEnabled
    ) {
      return ineligible(
        "MANUAL_BANK_DISABLED",
        "Manual bank payouts are not currently enabled. Connect Stripe or contact support before requesting a withdrawal.",
      )
    }
  }

  if (method.type === "stripe_connect") {
    if (!runtime.stripeConnectPayoutsEnabled) {
      return ineligible(
        "STRIPE_CONNECT_DISABLED",
        "Stripe payouts are not currently enabled. No withdrawal can be submitted through this method.",
      )
    }
    const account = method.providerAccount
    if (
      !method.providerAccountId ||
      !account ||
      account.publisherId !== method.publisherId ||
      account.provider !== "stripe_connect"
    ) {
      return ineligible(
        "PROVIDER_BINDING_INVALID",
        "This Stripe payout method is not bound to the publisher's verified account and requires support review.",
      )
    }
    if (
      account.isActive !== true ||
      account.status !== "ENABLED" ||
      account.transfersEnabled !== true ||
      account.payoutsEnabled !== true ||
      account.detailsSubmitted !== true ||
      account.payoutScheduleConfigured !== true ||
      account.defaultCurrency !== USD_CURRENCY
    ) {
      return ineligible(
        "STRIPE_ACCOUNT_NOT_READY",
        "Stripe setup is incomplete or restricted. Continue setup and refresh the provider status before withdrawing.",
      )
    }
  }

  if (!method.isActive) {
    return {
      executable: false,
      canReactivate: true,
      code: "INACTIVE",
      message: "This payout method is disabled. Enable it before withdrawing.",
    }
  }

  return {
    executable: true,
    canReactivate: false,
    code: "READY",
    message: "This payout method is ready for withdrawals.",
  }
}

export function selectExecutablePayoutMethods<
  T extends {
    type: unknown
    isActive: boolean
    withdrawalEligibility?: { executable?: boolean } | null
  },
>(
  methods: readonly T[] | null | undefined,
): Array<T & { type: CertifiedWithdrawalMethodType }> {
  return (methods ?? []).filter(
    (method): method is T & { type: CertifiedWithdrawalMethodType } =>
      isCertifiedWithdrawalMethodType(method.type) &&
      method.isActive === true &&
      method.withdrawalEligibility?.executable === true,
  )
}
