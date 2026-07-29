import {
  assertStripeObjectMode,
  stripeKeyMode,
  validateStripeEnvironment,
} from "../stripe-client"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("Stripe environment security gates", () => {
  it.each([
    ["sk_test_example", "test"],
    ["rk_test_example", "test"],
    ["sk_live_example", "live"],
    ["rk_live_example", "live"],
  ])("classifies %s without exposing the credential", (key, mode) => {
    process.env.STRIPE_SECRET_KEY = key
    expect(stripeKeyMode()).toBe(mode)
  })

  it("requires both independently signed Connect event scopes", () => {
    process.env.STRIPE_SECRET_KEY = "rk_test_example"
    process.env.STRIPE_CONNECT_ENABLED = "true"
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_platform"
    delete process.env.STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET

    expect(() => validateStripeEnvironment()).toThrow(
      /STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET is missing/,
    )
  })

  it("rejects reuse across Stripe webhook trust boundaries", () => {
    process.env.STRIPE_SECRET_KEY = "rk_test_example"
    process.env.STRIPE_DEPOSITS_ENABLED = "true"
    process.env.STRIPE_CONNECT_ENABLED = "true"
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_deposit"
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_platform"
    process.env.STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET = "whsec_platform"

    expect(() => validateStripeEnvironment()).toThrow(/must be different/)
  })

  it("rejects webhook-secret reuse while outbound Stripe features are disabled", () => {
    process.env.STRIPE_SECRET_KEY = "rk_test_example"
    process.env.STRIPE_DEPOSITS_ENABLED = "false"
    process.env.STRIPE_CONNECT_ENABLED = "false"
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_shared"
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_shared"
    process.env.STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET = "whsec_connected"

    expect(() => validateStripeEnvironment()).toThrow(/must be different/)
  })

  it("requires payout webhook secrets as a pair even while outbound sends are disabled", () => {
    process.env.STRIPE_SECRET_KEY = "rk_test_example"
    process.env.STRIPE_DEPOSITS_ENABLED = "false"
    process.env.STRIPE_CONNECT_ENABLED = "false"
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_platform"
    delete process.env.STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET

    expect(() => validateStripeEnvironment()).toThrow(
      /STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET is missing/,
    )
  })

  it("requires a valid key whenever an inbound webhook surface is configured", () => {
    process.env.STRIPE_DEPOSITS_ENABLED = "false"
    process.env.STRIPE_CONNECT_ENABLED = "false"
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_platform"
    process.env.STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET = "whsec_connected"
    delete process.env.STRIPE_SECRET_KEY

    expect(() => validateStripeEnvironment()).toThrow(
      /requires STRIPE_SECRET_KEY/,
    )
  })

  it("keeps restricted live keys behind the explicit live-money gate", () => {
    process.env.STRIPE_SECRET_KEY = "rk_live_example"
    process.env.STRIPE_DEPOSITS_ENABLED = "true"
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_deposit"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"

    expect(() => validateStripeEnvironment()).toThrow(/Live Stripe key refused/)
  })

  it.each([
    undefined,
    "not-a-stripe-key",
  ])("cannot infer test mode from a missing or malformed credential (%s)", (key) => {
    if (key === undefined) {
      delete process.env.STRIPE_SECRET_KEY
    } else {
      process.env.STRIPE_SECRET_KEY = key
    }

    expect(() => assertStripeObjectMode(false, "Stripe webhook Event")).toThrow(
      /cannot be verified/,
    )
  })

  it("refuses live objects while the explicit live-money gate is off", () => {
    process.env.STRIPE_SECRET_KEY = "rk_live_example"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"

    expect(() => assertStripeObjectMode(true, "Stripe webhook Event")).toThrow(
      /live mode is refused/,
    )
  })
})
