import {
  CREDITABLE_PRE_CREDIT_DEPOSIT_STATUSES,
  isCreditablePreCreditDepositStatus,
  isWalletCreditBackedDepositStatus,
  WALLET_CREDIT_BACKED_DEPOSIT_STATUSES,
} from "../deposit-status"

describe("deposit status evidence classes", () => {
  it("defines exactly the five wallet-credit-backed derivative states", () => {
    expect(WALLET_CREDIT_BACKED_DEPOSIT_STATUSES).toEqual([
      "SUCCEEDED",
      "PARTIALLY_REFUNDED",
      "REFUNDED",
      "DISPUTED",
      "CHARGEBACK",
    ])
    for (const status of WALLET_CREDIT_BACKED_DEPOSIT_STATUSES) {
      expect(isWalletCreditBackedDepositStatus(status)).toBe(true)
    }
    for (const status of [
      "CREATED",
      "PENDING_CUSTOMER_ACTION",
      "PROCESSING",
      "FAILED",
      "EXPIRED",
      "",
      null,
      undefined,
    ]) {
      expect(isWalletCreditBackedDepositStatus(status)).toBe(false)
    }
  })

  it("keeps terminal expiry out of the signed-event credit path", () => {
    expect(CREDITABLE_PRE_CREDIT_DEPOSIT_STATUSES).toEqual([
      "CREATED",
      "PENDING_CUSTOMER_ACTION",
      "PROCESSING",
      "FAILED",
    ])
    for (const status of CREDITABLE_PRE_CREDIT_DEPOSIT_STATUSES) {
      expect(isCreditablePreCreditDepositStatus(status)).toBe(true)
    }
    expect(isCreditablePreCreditDepositStatus("EXPIRED")).toBe(false)
    expect(isCreditablePreCreditDepositStatus("SUCCEEDED")).toBe(false)
  })
})
