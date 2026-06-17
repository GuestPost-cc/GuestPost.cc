import { createHash } from "node:crypto"
import { createAuthMiddleware } from "better-auth/api"
import type { Redis } from "ioredis"

export interface EmailRateLimitOptions {
  redis: Redis
  windowMs: number
  limits: {
    signIn: number
    signUp: number
    magicLink: number
    resetPassword: number
  }
  /**
   * Optional structured logger. If omitted, the plugin logs nothing.
   * Receiver should treat this as INFO severity — limit triggers are
   * normal traffic in the presence of stuffing attempts, not errors.
   */
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void
  }
}

// Verified against Better Auth 1.6.14 source during Phase 7.8 pre-impl
// (dist/api/routes/sign-in.mjs:143, sign-up.mjs:21, password.mjs:20 and
// plugins/magic-link/index.mjs:40). If you upgrade Better Auth, re-verify
// each path — the integration test asserts every entry here matches a
// real registered route and will fail loudly on drift.
type RouteKey = keyof EmailRateLimitOptions["limits"]
const ROUTES: ReadonlyArray<{ path: string; key: RouteKey; prefix: string }> = [
  { path: "/sign-in/email", key: "signIn", prefix: "signin" },
  { path: "/sign-up/email", key: "signUp", prefix: "signup" },
  { path: "/sign-in/magic-link", key: "magicLink", prefix: "magic" },
  { path: "/request-password-reset", key: "resetPassword", prefix: "reset" },
]

// SHA-256 of the normalized email. Stored in Redis keys (and logged)
// instead of plaintext so emails don't leak via redis-cli MONITOR, RDB
// dumps, support screenshots, or log aggregators. Not a security
// primitive — emails are public — just a privacy hygiene choice for an
// internal store.
export function hashEmail(email: string): string {
  return createHash("sha256").update(email).digest("hex")
}

// Account-enumeration safeguard: the response shape MUST be byte-identical
// to Better Auth's built-in IP rate-limit response (verified against
// better-auth@1.6.14 dist/api/rate-limiter/index.mjs rateLimitResponse()).
// Otherwise an attacker can compare responses to detect "this email
// exists" vs "this one doesn't". Body, status, statusText, and headers
// all mirror the built-in exactly.
function rateLimitResponse(retryAfterSec: number): Response {
  return new Response(
    JSON.stringify({ message: "Too many requests. Please try again later." }),
    {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "X-Retry-After": String(retryAfterSec) },
    },
  )
}

export function emailRateLimitPlugin(opts: EmailRateLimitOptions) {
  const windowSec = Math.ceil(opts.windowMs / 1000)
  return {
    id: "email-rate-limit",
    hooks: {
      before: ROUTES.map(({ path, key, prefix }) => ({
        matcher: (ctx: { path?: string }) => ctx.path === path,
        handler: createAuthMiddleware(async (ctx) => {
          const raw = (ctx as { body?: { email?: unknown } }).body?.email
          if (typeof raw !== "string") return
          const email = raw.toLowerCase().trim()
          if (!email) return
          const limit = opts.limits[key]
          const redisKey = `auth-rl:${prefix}:${hashEmail(email)}`
          const count = await opts.redis.incr(redisKey)
          if (count === 1) {
            await opts.redis.pexpire(redisKey, opts.windowMs)
          }
          if (count > limit) {
            opts.logger?.info("auth email rate limit triggered", {
              emailHash: hashEmail(email),
              endpoint: prefix,
              count,
              limit,
            })
            return rateLimitResponse(windowSec)
          }
        }),
      })),
    },
  }
}

// Exported for the integration test's route-drift assertion.
export const EMAIL_RATE_LIMIT_ROUTES = ROUTES
