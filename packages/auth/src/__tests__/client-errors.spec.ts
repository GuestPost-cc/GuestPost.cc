import { getOAuthErrorMessage, mapBetterAuthError } from "../client/errors"

describe("account suspension auth errors", () => {
  it("maps an email login suspension without exposing internal reasons", () => {
    expect(
      mapBetterAuthError({
        code: "ACCOUNT_SUSPENDED",
        message: "This account is suspended.",
        status: 403,
      }),
    ).toEqual({
      code: "ACCOUNT_SUSPENDED",
      message: "This account is suspended.",
      recoverable: true,
      httpStatus: 403,
    })
  })

  it("maps the OAuth callback suspension code", () => {
    expect(getOAuthErrorMessage("account_suspended")).toBe(
      "This account is suspended. Contact support if you believe this is a mistake.",
    )
  })
})
