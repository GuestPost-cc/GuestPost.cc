import { normalizeProviderWebhook } from "../payout-webhook"

function stripeEvent(type: string, status: string) {
  return {
    id: `evt_${type.replaceAll(".", "_")}_${status}`,
    type,
    livemode: false,
    account: "acct_test",
    data: {
      object: {
        id: type.startsWith("transfer.") ? "tr_test" : "po_test",
        status,
        amount: 1000,
        currency: "usd",
      },
    },
  }
}

describe("Stripe payout webhook normalization", () => {
  it.each([
    "paid",
    "failed",
    "canceled",
  ])("keeps payout.updated observational when its object snapshot is %s", (status) => {
    expect(
      normalizeProviderWebhook(
        "stripe_connect",
        stripeEvent("payout.updated", status),
      ),
    ).toMatchObject({
      providerExecutionId: "po_test",
      status: "PROCESSING",
      rawStatus: status,
    })
  })

  it.each([
    ["payout.paid", "paid", "COMPLETED"],
    ["payout.failed", "failed", "FAILED"],
    ["payout.canceled", "canceled", "FAILED"],
  ])("maps exact typed terminal event %s", (type, rawStatus, expected) => {
    expect(
      normalizeProviderWebhook("stripe_connect", stripeEvent(type, rawStatus))
        .status,
    ).toBe(expected)
  })

  it("does not infer completion from a platform transfer snapshot", () => {
    expect(
      normalizeProviderWebhook(
        "stripe_connect",
        stripeEvent("transfer.updated", "paid"),
      ).status,
    ).toBe("PROCESSING")
  })

  it("does not map a typed terminal event whose object status contradicts it", () => {
    expect(
      normalizeProviderWebhook(
        "stripe_connect",
        stripeEvent("payout.paid", "pending"),
      ).status,
    ).toBeNull()
  })
})
