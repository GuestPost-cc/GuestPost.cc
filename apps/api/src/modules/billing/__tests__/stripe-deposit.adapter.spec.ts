import { DepositProviderError } from "../providers/deposit-provider.interface"
import {
  classifyStripeDepositFailure,
  normalizeStripeDepositSession,
} from "../providers/stripe-deposit.adapter"

const originalStripeKey = process.env.STRIPE_SECRET_KEY

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_example"
})

afterAll(() => {
  if (originalStripeKey == null) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = originalStripeKey
})

describe("Stripe deposit failure classification", () => {
  it.each([
    [
      { type: "StripeAuthenticationError", code: "api_key_expired" },
      "PROVIDER_AUTHENTICATION_FAILED",
      false,
    ],
    [{ type: "StripeRateLimitError" }, "PROVIDER_RATE_LIMITED", true],
    [{ type: "StripeInvalidRequestError" }, "PROVIDER_REQUEST_REJECTED", false],
    [{ type: "StripeConnectionError" }, "PROVIDER_UNAVAILABLE", true],
  ])("maps provider facts to %s", (error, code, retryable) => {
    const classified = classifyStripeDepositFailure(error)

    expect(classified).toBeInstanceOf(DepositProviderError)
    expect(classified).toMatchObject({ code, retryable })
    expect(classified.message).toBe(code)
  })

  it("preserves an already-sanitized provider error", () => {
    const expected = new DepositProviderError(
      "PROVIDER_RESPONSE_INVALID",
      false,
    )
    expect(classifyStripeDepositFailure(expected)).toBe(expected)
  })
})

describe("Stripe deposit session normalization", () => {
  it("returns only bounded Checkout evidence", () => {
    const expiresAt = 1_787_872_400
    expect(
      normalizeStripeDepositSession({
        id: "cs_exact",
        object: "checkout.session",
        payment_intent: { id: "pi_exact", secret: "must-not-cross-boundary" },
        client_reference_id: "attempt-1",
        metadata: {
          depositAttemptId: "attempt-1",
          publicReference: "GP-DP-EXACT",
          walletId: "wallet-1",
          userId: "user-1",
          organizationId: "org-1",
          rawProviderContext: "must-not-cross-boundary",
        },
        amount_total: 2500,
        currency: "usd",
        mode: "payment",
        status: "open",
        url: "https://checkout.stripe.com/exact",
        expires_at: expiresAt,
        livemode: false,
        raw_response: "must-not-cross-boundary",
      }),
    ).toEqual({
      providerSessionId: "cs_exact",
      providerObjectType: "checkout.session",
      providerPaymentId: "pi_exact",
      clientReferenceId: "attempt-1",
      metadata: {
        depositAttemptId: "attempt-1",
        publicReference: "GP-DP-EXACT",
        walletId: "wallet-1",
        userId: "user-1",
        organizationId: "org-1",
      },
      amountTotalMinor: 2500,
      currency: "USD",
      mode: "payment",
      status: "open",
      url: "https://checkout.stripe.com/exact",
      expiresAt: new Date(expiresAt * 1000),
      livemode: false,
    })
  })

  it.each([
    null,
    {},
    { id: "cs_wrong_mode", livemode: true },
  ])("rejects malformed or cross-environment evidence without raw text", (value) => {
    let caught: unknown
    try {
      normalizeStripeDepositSession(value)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DepositProviderError)
    expect(caught).toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      retryable: false,
    })
    expect(String((caught as Error).message)).toBe("PROVIDER_RESPONSE_INVALID")
  })
})
