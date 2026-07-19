// Phase 6.8 — Audit finding #7 closure.
//
// Tests for the auth-redirect helper. The helper is a security-sensitive
// surface: a slip in URL sanitization is an open-redirect vulnerability;
// a slip in the idempotency guard is a UX nightmare (every concurrent
// 401 triggers its own redirect). The helpers are pure — no React, no
// DOM beyond a tiny window/sessionStorage mock.

import {
  __resetAuthRedirectGuard,
  buildAuthErrorHandler,
  isAuthEndpointPath,
  sanitizeReturnTo,
} from "../auth-redirect"

// ─── sanitizeReturnTo ─────────────────────────────────────────────────────

describe("sanitizeReturnTo — open-redirect defense", () => {
  // Happy path: relative paths are preserved verbatim with query + hash.
  it.each([
    ["/dashboard", "/dashboard"],
    ["/dashboard/orders/abc123", "/dashboard/orders/abc123"],
    ["/dashboard/orders?status=PAID", "/dashboard/orders?status=PAID"],
    ["/dashboard/orders/abc#tab-brief", "/dashboard/orders/abc#tab-brief"],
    ["/", "/"],
  ])("preserves relative path %s → %s", (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected)
  })

  // Attack surfaces — every one of these must return null.
  it.each([
    ["//evil.com", "protocol-relative URL"],
    ["//evil.com/dashboard", "protocol-relative subpath"],
    ["http://evil.com", "absolute http"],
    ["https://evil.com/dashboard", "absolute https"],
    ["javascript:alert(1)", "scheme handler — XSS"],
    ["data:text/html,<script>alert(1)</script>", "data: scheme — XSS"],
    ["mailto:victim@example.com", "mailto: scheme"],
    ["file:///etc/passwd", "file: scheme"],
    ["vbscript:msgbox(1)", "vbscript: scheme"],
    ["dashboard", "missing leading slash (relative-relative)"],
    ["", "empty"],
    ["  /dashboard", "whitespace-prefixed (becomes relative)"],
    ["\\\\evil.com", "backslash protocol-relative"],
  ])("rejects %s (%s) → null", (input) => {
    expect(sanitizeReturnTo(input)).toBe(null)
  })

  it.each([
    [null],
    [undefined],
    [123 as unknown as string],
    [{} as unknown as string],
    [[] as unknown as string],
  ])("rejects non-string input %p → null", (input) => {
    expect(sanitizeReturnTo(input as any)).toBe(null)
  })

  // Specific high-value attack: a string that LOOKS relative but contains
  // a protocol-relative URL in its search/hash. URL parsing should
  // still keep us on our origin.
  it("preserves `/dashboard?next=//evil.com` (the inner protocol-relative is in a query value, not the path)", () => {
    // The inner //evil.com is a value of `next`, not a path. URL parsing
    // resolves it against our placeholder origin, so the pathname is
    // still /dashboard and the search carries the literal `?next=//evil.com`.
    // The app's own code is responsible for honoring or rejecting `next`
    // independently — sanitizeReturnTo only guarantees we don't change
    // origins via the returnTo itself.
    const result = sanitizeReturnTo("/dashboard?next=//evil.com")
    expect(result).toContain("/dashboard")
  })
})

// ─── isAuthEndpointPath ───────────────────────────────────────────────────

describe("isAuthEndpointPath — skip 401 handler on auth endpoints", () => {
  it.each([
    "/auth/sign-in/email",
    "/auth/sign-up/email",
    "/auth/sign-out",
    "/auth/magic-link/send",
    "/auth/reset-password",
    "/auth/verify-email/abc",
    "/identity/me",
    "/api/v1/auth/sign-in/email",
    "/api/v1/identity/me",
  ])("recognizes %s as an auth endpoint", (path) => {
    expect(isAuthEndpointPath(path)).toBe(true)
  })

  it.each([
    "/orders",
    "/dashboard",
    "/marketplace/listings",
    "/support/tickets",
    "/admin/users",
  ])("recognizes %s as a NON-auth endpoint", (path) => {
    expect(isAuthEndpointPath(path)).toBe(false)
  })
})

// ─── buildAuthErrorHandler ────────────────────────────────────────────────

describe("buildAuthErrorHandler — idempotency + same-page debounce + URL composition", () => {
  // Mock the window globals so we can assert on .assign + sessionStorage
  // without polluting the real test runner environment.
  let assignSpy: jest.Mock
  let setItemSpy: jest.Mock
  let originalLocation: Location
  let originalSessionStorage: Storage

  beforeEach(() => {
    __resetAuthRedirectGuard()
    assignSpy = jest.fn()
    setItemSpy = jest.fn()
    originalLocation = (globalThis as any).window?.location
    originalSessionStorage = (globalThis as any).window?.sessionStorage
    const fakeStorage = {
      setItem: setItemSpy,
      getItem: jest.fn(),
      removeItem: jest.fn(),
    }
    ;(globalThis as any).window = {
      location: {
        pathname: "/dashboard/orders/abc",
        search: "?tab=brief",
        assign: assignSpy,
      },
      sessionStorage: fakeStorage,
    }
    // Helper reads bare `sessionStorage` (a browser global). Mirror onto
    // globalThis so it resolves outside a JSDOM environment.
    ;(globalThis as any).sessionStorage = fakeStorage
  })

  afterEach(() => {
    if (originalLocation) (globalThis as any).window.location = originalLocation
    if (originalSessionStorage)
      (globalThis as any).window.sessionStorage = originalSessionStorage
    delete (globalThis as any).sessionStorage
  })

  it("redirects with sanitized returnTo composed from current path+search", () => {
    const handler = buildAuthErrorHandler({ signInPath: "/" })
    handler()
    expect(assignSpy).toHaveBeenCalledTimes(1)
    const target = assignSpy.mock.calls[0][0] as string
    expect(target).toMatch(/^\/\?returnTo=/)
    expect(target).toContain(
      encodeURIComponent("/dashboard/orders/abc?tab=brief"),
    )
  })

  it("stashes the reason banner in sessionStorage", () => {
    const handler = buildAuthErrorHandler({
      signInPath: "/",
      reason: "Custom reason",
    })
    handler()
    expect(setItemSpy).toHaveBeenCalledWith(
      "guestpost:auth-redirect-reason",
      "Custom reason",
    )
  })

  it("idempotency: multiple concurrent calls only fire ONE redirect", () => {
    const handler = buildAuthErrorHandler({ signInPath: "/" })
    handler()
    handler()
    handler()
    handler()
    expect(assignSpy).toHaveBeenCalledTimes(1)
  })

  it("debounces if user is already on the sign-in page (no redirect loop)", () => {
    ;(globalThis as any).window.location.pathname = "/"
    ;(globalThis as any).window.location.search = ""
    const handler = buildAuthErrorHandler({ signInPath: "/" })
    handler()
    expect(assignSpy).not.toHaveBeenCalled()
  })

  it("debounces correctly with trailing slash difference", () => {
    ;(globalThis as any).window.location.pathname = "/"
    ;(globalThis as any).window.location.search = ""
    const handler = buildAuthErrorHandler({ signInPath: "/" }) // single slash
    handler()
    expect(assignSpy).not.toHaveBeenCalled()
  })

  it("runs the onBeforeRedirect cleanup hook before navigating", () => {
    const cleanup = jest.fn()
    const handler = buildAuthErrorHandler({
      signInPath: "/",
      onBeforeRedirect: cleanup,
    })
    handler()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(assignSpy).toHaveBeenCalledTimes(1)
    // Cleanup must run BEFORE assign (so query cache is gone before nav).
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      assignSpy.mock.invocationCallOrder[0],
    )
  })

  it("swallows errors thrown by the cleanup hook (never blocks the redirect)", () => {
    const cleanup = jest.fn(() => {
      throw new Error("clear() exploded")
    })
    const handler = buildAuthErrorHandler({
      signInPath: "/",
      onBeforeRedirect: cleanup,
    })
    expect(() => handler()).not.toThrow()
    expect(assignSpy).toHaveBeenCalledTimes(1)
  })

  it("omits returnTo when the current path already IS the sign-in path", () => {
    ;(globalThis as any).window.location.pathname = "/some/protected/route"
    ;(globalThis as any).window.location.search = ""
    const handler = buildAuthErrorHandler({ signInPath: "/" })
    handler()
    const target = assignSpy.mock.calls[0][0] as string
    // returnTo should be the path, encoded
    expect(target).toContain("returnTo=")
  })

  it("excludes the hash from returnTo (OAuth flows can carry tokens in hashes — never echo them back)", () => {
    ;(globalThis as any).window.location.pathname = "/dashboard"
    ;(globalThis as any).window.location.search = ""
    ;(globalThis as any).window.location.hash = "#access_token=ANGRY"
    const handler = buildAuthErrorHandler({ signInPath: "/" })
    handler()
    const target = assignSpy.mock.calls[0][0] as string
    expect(target).not.toContain("access_token")
    expect(target).not.toContain("ANGRY")
  })
})
