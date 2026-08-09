import {
  evaluatePayoutMethodEligibility,
  isCertifiedWithdrawalMethodType,
  selectExecutablePayoutMethods,
} from "../payout-method-eligibility"
import { isPaidWithdrawalStatus } from "../payout-status"

const manualRuntime = {
  newLiabilityOperationsEnabled: true,
  manualBankPayoutsEnabled: true,
  stripeConnectPayoutsEnabled: false,
}

const stripeRuntime = {
  newLiabilityOperationsEnabled: true,
  manualBankPayoutsEnabled: true,
  stripeConnectPayoutsEnabled: true,
}

function readyStripeMethod(overrides: Record<string, unknown> = {}) {
  return {
    publisherId: "pub-1",
    type: "stripe_connect",
    isActive: true,
    providerAccountId: "account-1",
    providerAccount: {
      publisherId: "pub-1",
      provider: "stripe_connect",
      isActive: true,
      status: "ENABLED",
      transfersEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      payoutScheduleConfigured: true,
      defaultCurrency: "USD",
    },
    ...overrides,
  }
}

describe("payout method eligibility", () => {
  it.each([
    "paypal",
    "wise",
    "crypto",
    null,
  ])("never certifies the %p route for a new withdrawal", (type) => {
    expect(isCertifiedWithdrawalMethodType(type)).toBe(false)
    expect(
      evaluatePayoutMethodEligibility(
        { publisherId: "pub-1", type, isActive: true },
        manualRuntime,
      ),
    ).toMatchObject({
      executable: false,
      canReactivate: false,
      code: "METHOD_NOT_CERTIFIED",
    })
  })

  it("allows only unbound active manual bank methods when that rail is enabled", () => {
    expect(
      evaluatePayoutMethodEligibility(
        {
          publisherId: "pub-1",
          type: "bank_transfer",
          isActive: true,
          providerAccountId: null,
        },
        manualRuntime,
      ),
    ).toMatchObject({ executable: true, code: "READY" })

    expect(
      evaluatePayoutMethodEligibility(
        {
          publisherId: "pub-1",
          type: "bank_transfer",
          isActive: true,
          providerAccountId: null,
        },
        stripeRuntime,
      ),
    ).toMatchObject({ executable: false, code: "MANUAL_BANK_DISABLED" })
  })

  it("requires the exact fully-ready Stripe account binding", () => {
    expect(
      evaluatePayoutMethodEligibility(readyStripeMethod(), stripeRuntime),
    ).toMatchObject({ executable: true, code: "READY" })

    expect(
      evaluatePayoutMethodEligibility(
        readyStripeMethod({
          providerAccount: {
            ...readyStripeMethod().providerAccount,
            publisherId: "pub-other",
          },
        }),
        stripeRuntime,
      ),
    ).toMatchObject({
      executable: false,
      code: "PROVIDER_BINDING_INVALID",
    })

    expect(
      evaluatePayoutMethodEligibility(
        readyStripeMethod({
          providerAccount: {
            ...readyStripeMethod().providerAccount,
            payoutScheduleConfigured: false,
          },
        }),
        stripeRuntime,
      ),
    ).toMatchObject({
      executable: false,
      code: "STRIPE_ACCOUNT_NOT_READY",
    })
  })

  it("permits reactivation only when the underlying route is executable", () => {
    expect(
      evaluatePayoutMethodEligibility(
        readyStripeMethod({ isActive: false }),
        stripeRuntime,
      ),
    ).toMatchObject({
      executable: false,
      canReactivate: true,
      code: "INACTIVE",
    })
    expect(
      evaluatePayoutMethodEligibility(
        { publisherId: "pub-1", type: "paypal", isActive: false },
        manualRuntime,
      ),
    ).toMatchObject({ executable: false, canReactivate: false })
  })

  it("projects every otherwise-ready route as ineligible while new liability is paused", () => {
    expect(
      evaluatePayoutMethodEligibility(readyStripeMethod(), {
        ...stripeRuntime,
        newLiabilityOperationsEnabled: false,
      }),
    ).toMatchObject({
      executable: false,
      canReactivate: false,
      code: "FINANCE_OPERATIONS_PAUSED",
    })
  })

  it("selects methods only with affirmative server eligibility", () => {
    expect(
      selectExecutablePayoutMethods([
        {
          id: "ready",
          type: "bank_transfer",
          isActive: true,
          withdrawalEligibility: { executable: true },
        },
        {
          id: "legacy",
          type: "paypal",
          isActive: true,
          withdrawalEligibility: { executable: true },
        },
        {
          id: "disabled",
          type: "stripe_connect",
          isActive: false,
          withdrawalEligibility: { executable: true },
        },
        { id: "old-api", type: "bank_transfer", isActive: true },
      ]),
    ).toEqual([
      {
        id: "ready",
        type: "bank_transfer",
        isActive: true,
        withdrawalEligibility: { executable: true },
      },
    ])
  })
})

describe("withdrawal history status", () => {
  it("treats only terminal completed withdrawals as paid out", () => {
    expect(isPaidWithdrawalStatus("COMPLETED")).toBe(true)
    for (const status of [
      "PENDING",
      "APPROVED",
      "PROCESSING",
      "REJECTED",
      "FAILED",
      "REVERSED",
      "PAID",
    ]) {
      expect(isPaidWithdrawalStatus(status)).toBe(false)
    }
  })
})
