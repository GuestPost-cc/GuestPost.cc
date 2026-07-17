import {
  getSessionCookieValue,
  requiresAuthRedirect,
  SECURE_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../middleware-auth"

describe("middleware auth helpers", () => {
  it("accepts the development session cookie name", () => {
    const value = getSessionCookieValue((name) =>
      name === SESSION_COOKIE_NAME ? { value: "dev-session" } : undefined,
    )

    expect(value).toBe("dev-session")
  })

  it("accepts the production secure session cookie name", () => {
    const value = getSessionCookieValue((name) =>
      name === SECURE_SESSION_COOKIE_NAME
        ? { value: "secure-session" }
        : undefined,
    )

    expect(value).toBe("secure-session")
  })

  it("allows protected paths when any supported session cookie is present", () => {
    expect(
      requiresAuthRedirect("/dashboard", "secure-session", {
        signInPath: "/",
        protectedPaths: ["/dashboard"],
      }),
    ).toEqual({ needsRedirect: false })
  })
})
