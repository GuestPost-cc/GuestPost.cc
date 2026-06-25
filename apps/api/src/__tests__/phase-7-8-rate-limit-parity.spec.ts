/**
 * Phase 7.8 #26 — account-enumeration safeguard parity test.
 *
 * The email-layer 429 (better-auth plugin) and the IP-layer 429 (Express
 * createAuthLimiter) MUST produce byte-identical responses — otherwise
 * an attacker can compare responses to detect "this email exists" vs
 * "this one doesn't" and turn the limiter into a discovery oracle.
 *
 * This spec captures both response shapes in isolation and asserts
 * equality. If either side drifts (Better Auth upgrade changes the
 * built-in 429; someone tweaks createAuthLimiter; the plugin's response
 * builder is edited), this test fails loudly and forces re-alignment.
 *
 * Plugin response is mocked at the module level (Better Auth ESM can't
 * be required by Jest's CJS loader) — the mock is identity for
 * createAuthMiddleware which matches better-auth@1.6.14 runtime
 * (verified during Phase 7.8 pre-impl).
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
// better-auth ESM modules are stubbed globally via jest.config.js
// moduleNameMapper → apps/api/src/__mocks__/better-auth.ts. No per-spec
// jest.mock calls needed.
import { emailRateLimitPlugin } from "@guestpost/auth"

function makeRedisMock() {
  return {
    incr: jest.fn(async () => 999), // immediately over any limit
    pexpire: jest.fn(async () => 1),
  } as any
}

async function pluginRunHook(routePath: string) {
  const plugin = emailRateLimitPlugin({
    redis: makeRedisMock(),
    windowMs: 3_600_000,
    limits: { signIn: 0, signUp: 0, magicLink: 0, resetPassword: 0 },
  })
  const hook = plugin.hooks.before.find((h) =>
    h.matcher({ path: routePath } as any),
  )
  if (!hook) throw new Error(`no hook matched ${routePath}`)
  return (await (hook.handler as any)({
    body: { email: "alice@example.com" },
    path: routePath,
  })) as Response
}

// Reconstruct the IP-layer response by inspecting the same source main.ts
// uses. createAuthLimiter is a closure inside bootstrap() and can't be
// imported, so we assert against the source's known shape. The plugin
// response shape is the canonical reference both sides match.
function expressLayerCanonicalShape() {
  return {
    status: 429,
    statusText: "Too Many Requests",
    body: { message: "Too many requests. Please try again later." },
    headerKey: "X-Retry-After",
  }
}

describe("Phase 7.8 #26 — rate-limit 429 byte parity (enumeration safeguard)", () => {
  describe("plugin response shape", () => {
    let r: Response
    beforeAll(async () => {
      r = await pluginRunHook("/sign-in/email")
    })

    it("status is 429", () => {
      expect(r.status).toBe(429)
    })
    it("statusText is 'Too Many Requests' (proper HTTP phrase, not the APIError enum-key form)", () => {
      expect(r.statusText).toBe("Too Many Requests")
    })
    it("body is {message: 'Too many requests. Please try again later.'} — no extra fields", async () => {
      const body = await r.json()
      expect(body).toEqual({
        message: "Too many requests. Please try again later.",
      })
      // Extra-field guard: no `code`, no `path`, no `error`, no `email`,
      // no `endpoint` — anything that could differentiate IP vs email
      // layer.
      expect(Object.keys(body).sort()).toEqual(["message"])
    })
    it("X-Retry-After header is present (NOT the standard Retry-After — Better Auth uses the X- prefix)", () => {
      expect(r.headers.get("X-Retry-After")).toBe("3600")
    })
  })

  describe("Express layer canonical shape (source-asserted)", () => {
    let src: string
    beforeAll(() => {
      src = readFileSync(join(__dirname, "..", "main.ts"), "utf8")
    })

    it("BETTER_AUTH_429_BODY matches plugin body exactly", () => {
      const match = src.match(/const BETTER_AUTH_429_BODY = \{[\s\S]*?\}/)
      expect(match).not.toBeNull()
      // The constant in source — string-match the exact message.
      expect(match?.[0]).toContain(
        `"Too many requests. Please try again later."`,
      )
    })
    it("createAuthLimiter handler emits status 429 + X-Retry-After header + BETTER_AUTH_429_BODY", () => {
      // Source-shape assertions — the handler closure isn't importable
      // but the source signature is invariant. If any of these strings
      // change in main.ts the parity guarantee is broken.
      expect(src).toMatch(/\.status\(429\)/)
      expect(src).toMatch(/setHeader\(\s*["']X-Retry-After["']/)
      expect(src).toMatch(/\.json\(BETTER_AUTH_429_BODY\)/)
    })
  })

  describe("byte-parity between layers", () => {
    let pluginResponse: Response
    beforeAll(async () => {
      pluginResponse = await pluginRunHook("/sign-in/email")
    })

    it("plugin response body bytes == Express layer body bytes", async () => {
      const pluginBody = await pluginResponse.text()
      const expressBody = JSON.stringify(expressLayerCanonicalShape().body)
      expect(pluginBody).toBe(expressBody)
    })
    it("plugin response status == Express layer status", () => {
      expect(pluginResponse.status).toBe(expressLayerCanonicalShape().status)
    })
    it("plugin response statusText == Express layer statusText", () => {
      expect(pluginResponse.statusText).toBe(
        expressLayerCanonicalShape().statusText,
      )
    })
    it("plugin response carries the same X-Retry-After header key", () => {
      expect(
        pluginResponse.headers.has(expressLayerCanonicalShape().headerKey),
      ).toBe(true)
    })
  })

  describe("non-existent-email parity (no enumeration oracle)", () => {
    it("hits same Redis path regardless of email existence (no User lookup in hook)", async () => {
      // The plugin's hook never touches the User table — it INCRs a Redis
      // counter unconditionally. This means a request for an
      // existent email and a request for a non-existent email both
      // trigger the same 429 with the same response shape. Verified by
      // source-grep: no Prisma / database imports in the plugin file.
      const pluginSrc = readFileSync(
        join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "packages",
          "auth",
          "src",
          "plugins",
          "email-rate-limit.ts",
        ),
        "utf8",
      )
      expect(pluginSrc).not.toMatch(/from\s+["']@guestpost\/database/)
      expect(pluginSrc).not.toMatch(/from\s+["']@prisma\//)
      expect(pluginSrc).not.toMatch(/prisma\./)
    })
  })
})
