import {
  getSessionCookieValue,
  hasPlausibleSessionCookie,
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

  it("allows protected paths when a plausibly signed session cookie is present", () => {
    expect(
      requiresAuthRedirect(
        "/dashboard",
        `${"a".repeat(16)}.${"b".repeat(40)}`,
        {
          signInPath: "/",
          protectedPaths: ["/dashboard"],
        },
      ),
    ).toEqual({ needsRedirect: false })
  })

  it("redirects invalid cookie values instead of rendering the dashboard shell", () => {
    expect(hasPlausibleSessionCookie("forged")).toBe(false)
    expect(
      requiresAuthRedirect("/dashboard", "forged", {
        signInPath: "/",
        protectedPaths: ["/dashboard"],
      }),
    ).toMatchObject({ needsRedirect: true })
  })

  it("preserves the full query string in an unauthenticated return path", () => {
    expect(
      requiresAuthRedirect(
        "/dashboard/marketplace/site/order?service=service-1",
        null,
        {
          signInPath: "/",
          protectedPaths: ["/dashboard"],
        },
      ),
    ).toEqual({
      needsRedirect: true,
      signInPath: "/",
      redirect: "/dashboard/marketplace/site/order?service=service-1",
    })
  })
})
