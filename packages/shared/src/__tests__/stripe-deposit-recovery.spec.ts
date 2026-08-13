import {
  retrieveStripeDepositEvidence,
  StripeDepositRecoveryError,
} from "../stripe-deposit-recovery"

const session = {
  object: "checkout.session",
  id: "cs_test_recovery",
  payment_intent: "pi_test_recovery",
  client_reference_id: "attempt-1",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  amount_total: 1250,
  currency: "usd",
  livemode: false,
  metadata: {
    depositAttemptId: "attempt-1",
    publicReference: "DP-RECOVERY-1",
    walletId: "wallet-1",
    userId: "user-1",
    organizationId: "org-1",
  },
}
const paymentIntent = {
  object: "payment_intent",
  id: "pi_test_recovery",
  latest_charge: "ch_test_recovery",
  status: "succeeded",
  amount: 1250,
  amount_received: 1250,
  currency: "usd",
  livemode: false,
  metadata: {
    depositAttemptId: "attempt-1",
    publicReference: "DP-RECOVERY-1",
    walletId: "wallet-1",
  },
}
const charge = {
  object: "charge",
  id: "ch_test_recovery",
  payment_intent: "pi_test_recovery",
  paid: true,
  captured: true,
  refunded: false,
  disputed: false,
  amount: 1250,
  amount_captured: 1250,
  amount_refunded: 0,
  currency: "usd",
  livemode: false,
}

describe("authenticated Stripe deposit retrieval", () => {
  it("retrieves Checkout, PaymentIntent, and Charge into bounded typed evidence", async () => {
    const calls: string[] = []
    const evidence = await retrieveStripeDepositEvidence(session.id, {
      secretKey: "rk_test_recovery",
      liveModeEnabled: "false",
      now: new Date("2026-08-12T00:00:00.000Z"),
      requestObject: async (path, id) => {
        calls.push(`${path}:${id}`)
        if (path === "checkout/sessions") return session
        if (path === "payment_intents") return paymentIntent
        return charge
      },
    })

    expect(calls).toEqual([
      "checkout/sessions:cs_test_recovery",
      "payment_intents:pi_test_recovery",
      "charges:ch_test_recovery",
    ])
    expect(evidence).toMatchObject({
      source: "AUTHENTICATED_PROVIDER_RETRIEVAL",
      providerSessionId: "cs_test_recovery",
      providerPaymentId: "pi_test_recovery",
      providerChargeId: "ch_test_recovery",
      checkoutAmountTotalMinor: 1250n,
      paymentIntentReceivedMinor: 1250n,
      chargeAmountCapturedMinor: 1250n,
      checkoutLivemode: false,
    })
    expect(evidence.evidenceFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it("rejects a Charge that is not linked to the retrieved PaymentIntent", async () => {
    await expect(
      retrieveStripeDepositEvidence(session.id, {
        secretKey: "rk_test_recovery",
        liveModeEnabled: "false",
        requestObject: async (path) => {
          if (path === "checkout/sessions") return session
          if (path === "payment_intents") return paymentIntent
          return { ...charge, payment_intent: "pi_other" }
        },
      }),
    ).rejects.toMatchObject({
      code: "STRIPE_RECOVERY_RESPONSE_INVALID",
      retryable: false,
    })
  })

  it.each([
    ["disputed", { disputed: true }],
    ["partially refunded", { amount_refunded: 1 }],
  ])("rejects a %s Charge before it can become persisted authority", async (_label, patch) => {
    await expect(
      retrieveStripeDepositEvidence(session.id, {
        secretKey: "rk_test_recovery",
        liveModeEnabled: "false",
        requestObject: async (path) => {
          if (path === "checkout/sessions") return session
          if (path === "payment_intents") return paymentIntent
          return { ...charge, ...patch }
        },
      }),
    ).rejects.toMatchObject({
      code: "STRIPE_RECOVERY_RESPONSE_INVALID",
      retryable: false,
    })
  })

  it("fails closed without the distinct retrieval credential", async () => {
    await expect(
      retrieveStripeDepositEvidence(session.id, { secretKey: "" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<StripeDepositRecoveryError>>({
        code: "STRIPE_RECOVERY_KEY_MISSING",
        retryable: true,
      }),
    )
  })

  it("rejects a broad sk credential at the restricted retrieval boundary", async () => {
    await expect(
      retrieveStripeDepositEvidence(session.id, { secretKey: "sk_test_broad" }),
    ).rejects.toMatchObject({
      code: "STRIPE_RECOVERY_KEY_INVALID",
      retryable: true,
    })
  })
})
