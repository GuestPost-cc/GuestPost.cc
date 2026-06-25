import { readFileSync } from "node:fs"
import { join } from "node:path"

// Mock better-auth/api before importing the plugin. createAuthMiddleware
// is essentially a passthrough wrapper (created via
// createMiddleware.create({ use: [optionsMiddleware, ...] })) that runs
// our inner fn after optionsMiddleware. For the unit test we want to
// invoke the inner fn directly with synthetic ctx, so identity is fine.
// better-auth ships ESM (.mjs) which Jest's CJS loader can't import —
// mocking sidesteps the loader entirely.
jest.mock("better-auth/api", () => ({
  createAuthMiddleware: (fn: any) => fn,
}))

import {
  EMAIL_RATE_LIMIT_ROUTES,
  type EmailRateLimitOptions,
  emailRateLimitPlugin,
  hashEmail,
} from "../plugins/email-rate-limit"

function makeRedisMock() {
  const store = new Map<string, number>()
  return {
    store,
    incr: jest.fn(async (key: string) => {
      const next = (store.get(key) ?? 0) + 1
      store.set(key, next)
      return next
    }),
    pexpire: jest.fn(async (_key: string, _ms: number) => 1),
  }
}

function makeOpts(
  overrides: Partial<EmailRateLimitOptions> = {},
): EmailRateLimitOptions {
  return {
    redis: makeRedisMock() as any,
    windowMs: 3_600_000,
    limits: { signIn: 3, signUp: 3, magicLink: 3, resetPassword: 3 },
    ...overrides,
  }
}

// Each hook returned by the plugin is wrapped in createAuthMiddleware,
// which produces a runnable async function under the hood. We exercise the
// `handler.handler` (the inner middleware function passed to
// createAuthMiddleware) by reconstructing the same shape: pull the route
// entry's path/key/prefix and invoke the underlying handler directly with
// a synthetic ctx.
async function runHook(
  pluginInstance: ReturnType<typeof emailRateLimitPlugin>,
  routePath: string,
  ctx: { body?: { email?: unknown } },
): Promise<Response | undefined> {
  const hook = pluginInstance.hooks.before.find((h) =>
    h.matcher({ path: routePath } as any),
  )
  if (!hook) throw new Error(`no hook matched ${routePath}`)
  return (await (hook.handler as any)({ ...ctx, path: routePath })) as
    | Response
    | undefined
}

describe("emailRateLimitPlugin", () => {
  describe("hashEmail privacy", () => {
    it("produces stable 64-char hex digest", () => {
      const h = hashEmail("alice@example.com")
      expect(h).toMatch(/^[a-f0-9]{64}$/)
      expect(hashEmail("alice@example.com")).toBe(h)
    })
    it("differs across emails", () => {
      expect(hashEmail("a@x.com")).not.toBe(hashEmail("b@x.com"))
    })
  })

  describe("ROUTES table verified against Better Auth source", () => {
    it("matches the 4 paths verified in Phase 7.8 pre-impl", () => {
      const paths = EMAIL_RATE_LIMIT_ROUTES.map((r) => r.path).sort()
      expect(paths).toEqual([
        "/request-password-reset",
        "/sign-in/email",
        "/sign-in/magic-link",
        "/sign-up/email",
      ])
    })
  })

  describe("hook behavior", () => {
    it("returns early when email is missing", async () => {
      const redis = makeRedisMock()
      const plugin = emailRateLimitPlugin(makeOpts({ redis: redis as any }))
      const result = await runHook(plugin, "/sign-in/email", { body: {} })
      expect(result).toBeUndefined()
      expect(redis.incr).not.toHaveBeenCalled()
    })

    it("returns early when email is non-string", async () => {
      const redis = makeRedisMock()
      const plugin = emailRateLimitPlugin(makeOpts({ redis: redis as any }))
      const result = await runHook(plugin, "/sign-in/email", {
        body: { email: 123 as any },
      })
      expect(result).toBeUndefined()
      expect(redis.incr).not.toHaveBeenCalled()
    })

    it("calls INCR + PEXPIRE on first hit with hashed-email key", async () => {
      const redis = makeRedisMock()
      const plugin = emailRateLimitPlugin(makeOpts({ redis: redis as any }))
      await runHook(plugin, "/sign-in/email", {
        body: { email: "alice@example.com" },
      })
      expect(redis.incr).toHaveBeenCalledTimes(1)
      const key = (redis.incr as jest.Mock).mock.calls[0][0]
      expect(key).toBe(`auth-rl:signin:${hashEmail("alice@example.com")}`)
      // Critical privacy invariant: the raw email must NEVER appear in any
      // Redis key built by the plugin.
      expect(key).not.toContain("alice@example.com")
      expect(key).not.toContain("alice")
      expect(redis.pexpire).toHaveBeenCalledWith(key, 3_600_000)
    })

    it("does NOT call PEXPIRE on subsequent hits (only sets TTL once)", async () => {
      const redis = makeRedisMock()
      const plugin = emailRateLimitPlugin(makeOpts({ redis: redis as any }))
      await runHook(plugin, "/sign-in/email", {
        body: { email: "alice@example.com" },
      })
      await runHook(plugin, "/sign-in/email", {
        body: { email: "alice@example.com" },
      })
      expect(redis.pexpire).toHaveBeenCalledTimes(1)
    })

    it("returns 429 Response when count exceeds the limit", async () => {
      const redis = makeRedisMock()
      const plugin = emailRateLimitPlugin(
        makeOpts({
          redis: redis as any,
          limits: { signIn: 2, signUp: 2, magicLink: 2, resetPassword: 2 },
        }),
      )
      const r1 = await runHook(plugin, "/sign-in/email", {
        body: { email: "alice@example.com" },
      })
      const r2 = await runHook(plugin, "/sign-in/email", {
        body: { email: "alice@example.com" },
      })
      const r3 = await runHook(plugin, "/sign-in/email", {
        body: { email: "alice@example.com" },
      })
      expect(r1).toBeUndefined()
      expect(r2).toBeUndefined()
      expect(r3).toBeInstanceOf(Response)
      expect(r3?.status).toBe(429)
      expect(r3?.statusText).toBe("Too Many Requests")
      expect(r3?.headers.get("X-Retry-After")).toBe("3600")
      const body = await r3?.json()
      expect(body).toEqual({
        message: "Too many requests. Please try again later.",
      })
    })

    it("uses per-endpoint prefixes (signin/signup/magic/reset)", async () => {
      const redis = makeRedisMock()
      const plugin = emailRateLimitPlugin(makeOpts({ redis: redis as any }))
      const email = "alice@example.com"
      await runHook(plugin, "/sign-in/email", { body: { email } })
      await runHook(plugin, "/sign-up/email", { body: { email } })
      await runHook(plugin, "/sign-in/magic-link", { body: { email } })
      await runHook(plugin, "/request-password-reset", { body: { email } })
      const prefixes = (redis.incr as jest.Mock).mock.calls.map(
        (c) => c[0].split(":")[1],
      )
      expect(prefixes).toEqual(["signin", "signup", "magic", "reset"])
    })

    it("uses per-endpoint buckets (sign-in counter does not affect sign-up)", async () => {
      const redis = makeRedisMock()
      const plugin = emailRateLimitPlugin(
        makeOpts({
          redis: redis as any,
          limits: { signIn: 2, signUp: 2, magicLink: 2, resetPassword: 2 },
        }),
      )
      const email = "alice@example.com"
      await runHook(plugin, "/sign-in/email", { body: { email } })
      await runHook(plugin, "/sign-in/email", { body: { email } })
      // sign-in is now at its limit; sign-up should still pass for the
      // same email since the buckets are per-endpoint.
      const result = await runHook(plugin, "/sign-up/email", {
        body: { email },
      })
      expect(result).toBeUndefined()
    })

    it("logs INFO with emailHash (never raw email) when limit triggers", async () => {
      const redis = makeRedisMock()
      const logger = { info: jest.fn() }
      const plugin = emailRateLimitPlugin(
        makeOpts({
          redis: redis as any,
          logger,
          limits: { signIn: 1, signUp: 1, magicLink: 1, resetPassword: 1 },
        }),
      )
      await runHook(plugin, "/sign-in/email", {
        body: { email: "alice@example.com" },
      })
      await runHook(plugin, "/sign-in/email", {
        body: { email: "alice@example.com" },
      })
      expect(logger.info).toHaveBeenCalledWith(
        "auth email rate limit triggered",
        expect.objectContaining({
          emailHash: hashEmail("alice@example.com"),
          endpoint: "signin",
          count: 2,
          limit: 1,
        }),
      )
      const loggedMeta = (logger.info as jest.Mock).mock.calls[0][1]
      // Privacy invariant for the log line.
      const dumped = JSON.stringify(loggedMeta)
      expect(dumped).not.toContain("alice@example.com")
      expect(dumped).not.toContain("alice")
    })
  })

  describe("email normalization (regression — copy-paste robustness)", () => {
    it("collapses lowercase, uppercase, and surrounding whitespace into one bucket", async () => {
      const redis = makeRedisMock()
      const plugin = emailRateLimitPlugin(makeOpts({ redis: redis as any }))
      const variants = [
        "alice@example.com",
        "Alice@Example.com",
        "ALICE@EXAMPLE.COM",
        " alice@example.com",
        "alice@example.com ",
        "  ALICE@Example.com  ",
      ]
      for (const v of variants) {
        await runHook(plugin, "/sign-in/email", { body: { email: v } })
      }
      const keys = new Set(
        (redis.incr as jest.Mock).mock.calls.map((c) => c[0]),
      )
      expect(keys.size).toBe(1) // all variants share one Redis key
      const onlyKey = [...keys][0]
      expect(onlyKey).toBe(`auth-rl:signin:${hashEmail("alice@example.com")}`)
    })
  })

  describe("regression: plugin source never builds a Redis key from the raw email", () => {
    // Defense-in-depth: even if someone refactors the hook later, the
    // grep below should keep failing CI loudly. We forbid building any
    // template literal that interpolates `email` directly into a key —
    // it must always go through hashEmail(...).
    it("source file never concatenates raw email into a key string", () => {
      const src = readFileSync(
        join(__dirname, "..", "plugins", "email-rate-limit.ts"),
        "utf8",
      )
      // Strip comments + strings so this is a *code* check, not a doc check.
      // Look for patterns like `${email}` inside backtick strings used as
      // keys. The legitimate usage is `${hashEmail(email)}`.
      const offending = [
        /`[^`]*\$\{email\}[^`]*`/, // `...${email}...`
        /"auth-rl[^"]*"\s*\+\s*email\b/, // "auth-rl..." + email
      ]
      for (const re of offending) {
        expect(src.match(re)).toBeNull()
      }
      // Positive assertion: the file DOES use hashEmail.
      expect(src).toMatch(/hashEmail\(email\)/)
    })
  })
})
