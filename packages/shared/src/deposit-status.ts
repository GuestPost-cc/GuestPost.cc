// A deposit becomes wallet-credit-backed exactly once, when its DEPOSIT
// ledger transaction commits. Refund and dispute states are derivative views
// of that same credited funding fact, so they remain eligible for exact
// evidence replay and dispute correlation.
export const WALLET_CREDIT_BACKED_DEPOSIT_STATUSES = [
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "DISPUTED",
  "CHARGEBACK",
] as const

export type WalletCreditBackedDepositStatus =
  (typeof WALLET_CREDIT_BACKED_DEPOSIT_STATUSES)[number]

const WALLET_CREDIT_BACKED_DEPOSIT_STATUS_SET: ReadonlySet<string> = new Set(
  WALLET_CREDIT_BACKED_DEPOSIT_STATUSES,
)

export function isWalletCreditBackedDepositStatus(
  status: unknown,
): status is WalletCreditBackedDepositStatus {
  return (
    typeof status === "string" &&
    WALLET_CREDIT_BACKED_DEPOSIT_STATUS_SET.has(status)
  )
}

// These are the only pre-credit states from which exact authoritative paid
// evidence may create the wallet credit. EXPIRED is included because provider
// settlement can win a race with local session expiry or arrive later through
// authenticated recovery; refusing that proof would strand paid funds.
export const CREDITABLE_PRE_CREDIT_DEPOSIT_STATUSES = [
  "CREATED",
  "PENDING_CUSTOMER_ACTION",
  "PROCESSING",
  "FAILED",
  "EXPIRED",
] as const

export type CreditablePreCreditDepositStatus =
  (typeof CREDITABLE_PRE_CREDIT_DEPOSIT_STATUSES)[number]

const CREDITABLE_PRE_CREDIT_DEPOSIT_STATUS_SET: ReadonlySet<string> = new Set(
  CREDITABLE_PRE_CREDIT_DEPOSIT_STATUSES,
)

export function isCreditablePreCreditDepositStatus(
  status: unknown,
): status is CreditablePreCreditDepositStatus {
  return (
    typeof status === "string" &&
    CREDITABLE_PRE_CREDIT_DEPOSIT_STATUS_SET.has(status)
  )
}
