import {
  AUTH_ACCOUNT_OPTIONS,
  AUTH_SESSION_OPTIONS,
  googleProviderOptions,
} from "../security-options"

describe("auth security options", () => {
  it("requires explicit Google signup and disables implicit account linking", () => {
    expect(googleProviderOptions()).toMatchObject({
      disableImplicitSignUp: true,
      prompt: "select_account",
    })
    expect(AUTH_ACCOUNT_OPTIONS.accountLinking.disableImplicitLinking).toBe(
      true,
    )
  })

  it("uses the bounded rolling session policy", () => {
    expect(AUTH_SESSION_OPTIONS).toMatchObject({
      expiresIn: 8 * 60 * 60,
      updateAge: 30 * 60,
      freshAge: 30 * 60,
    })
  })
})
