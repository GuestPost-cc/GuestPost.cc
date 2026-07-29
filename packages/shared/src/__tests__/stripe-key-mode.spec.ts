import {
  assertStripeFinancialObjectMode,
  classifyStripeKeyMode,
  StripeConfigurationError,
} from "../stripe-key-mode"

describe("Stripe key mode classification", () => {
  it.each([
    ["sk_test_example", "test"],
    ["rk_test_example", "test"],
    ["sk_live_example", "live"],
    ["rk_live_example", "live"],
    ["  rk_test_example  ", "test"],
    [undefined, "none"],
    ["", "none"],
    ["pk_test_example", "invalid"],
    ["secret", "invalid"],
  ] as const)("classifies credentials without exposing them", (key, expected) => {
    expect(classifyStripeKeyMode(key)).toBe(expected)
  })

  it("configuration errors expose only a stable non-secret code", () => {
    const error = new StripeConfigurationError(
      "STRIPE_KEY_INVALID",
      "Stripe key is invalid",
    )

    expect(error).toMatchObject({
      name: "StripeConfigurationError",
      code: "STRIPE_KEY_INVALID",
      message: "Stripe key is invalid",
    })
  })

  it.each([
    {
      name: "test evidence after live promotion",
      livemode: false,
      secretKey: "rk_live_example",
      liveModeEnabled: "true",
      code: "STRIPE_PROVIDER_MODE_MISMATCH",
    },
    {
      name: "live evidence after test rollback",
      livemode: true,
      secretKey: "rk_test_example",
      liveModeEnabled: "false",
      code: "STRIPE_PROVIDER_MODE_MISMATCH",
    },
    {
      name: "live evidence while the live-money gate is disabled",
      livemode: true,
      secretKey: "rk_live_example",
      liveModeEnabled: "false",
      code: "STRIPE_LIVE_MODE_DISABLED",
    },
  ])("rejects $name", ({ livemode, secretKey, liveModeEnabled, code }) => {
    expect(() =>
      assertStripeFinancialObjectMode(livemode, {
        secretKey,
        liveModeEnabled,
      }),
    ).toThrow(
      expect.objectContaining({
        name: "StripeConfigurationError",
        code,
      }),
    )
  })

  it.each([
    [false, "rk_test_example", undefined, "test"],
    [true, "rk_live_example", " TRUE ", "live"],
  ] as const)("accepts exact durable mode evidence", (livemode, secretKey, liveModeEnabled, expected) => {
    expect(
      assertStripeFinancialObjectMode(livemode, {
        secretKey,
        liveModeEnabled,
      }),
    ).toBe(expected)
  })
})
