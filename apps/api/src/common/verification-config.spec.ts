import { resolveVerificationRateLimitConfig } from "./verification-config"

describe("resolveVerificationRateLimitConfig", () => {
  it("uses conservative defaults", () => {
    expect(resolveVerificationRateLimitConfig({})).toEqual({
      cooldownMs: 60_000,
      hourlyCap: 20,
    })
  })

  it("accepts bounded positive integers", () => {
    expect(
      resolveVerificationRateLimitConfig({
        VERIFY_COOLDOWN_SECONDS: "120",
        VERIFY_HOURLY_CAP: "50",
      }),
    ).toEqual({ cooldownMs: 120_000, hourlyCap: 50 })
  })

  it.each([
    ["zero", { VERIFY_HOURLY_CAP: "0" }],
    ["negative", { VERIFY_COOLDOWN_SECONDS: "-1" }],
    ["fraction", { VERIFY_HOURLY_CAP: "1.5" }],
    ["NaN", { VERIFY_HOURLY_CAP: "nope" }],
    ["too large", { VERIFY_COOLDOWN_SECONDS: "3601" }],
  ])("fails closed for %s configuration", (_label, env) => {
    expect(() => resolveVerificationRateLimitConfig(env)).toThrow()
  })
})
