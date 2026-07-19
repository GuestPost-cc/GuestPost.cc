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
    warn?: (msg: string, meta?: Record<string, unknown>) => void
  }
}

interface LocalCounter {
  count: number
  expiresAt: number
}

const REDIS_RETRY_COOLDOWN_MS = 30_000
const MAX_LOCAL_COUNTERS = 20_000

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
  // Redis is the authoritative, cross-instance store. The bounded local map
  // is a security-preserving degradation path for provider outages and quota
  // exhaustion: requests remain email-rate-limited instead of turning every
  // login into a 500 or silently disabling the second protection layer.
  const localCounters = new Map<string, LocalCounter>()
  let redisRetryAt = 0
  let lastRedisWarningAt = 0

  function incrementLocal(key: string, now: number): number {
    const current = localCounters.get(key)
    if (!current || current.expiresAt <= now) {
      if (localCounters.size >= MAX_LOCAL_COUNTERS) {
        for (const [candidate, counter] of localCounters) {
          if (
            counter.expiresAt <= now ||
            localCounters.size >= MAX_LOCAL_COUNTERS
          ) {
            localCounters.delete(candidate)
          }
          if (localCounters.size < MAX_LOCAL_COUNTERS) break
        }
      }
      localCounters.set(key, { count: 1, expiresAt: now + opts.windowMs })
      return 1
    }
    current.count += 1
    return current.count
  }

  async function increment(
    key: string,
  ): Promise<{ count: number; source: "redis" | "local" }> {
    const now = Date.now()
    if (now >= redisRetryAt) {
      try {
        const count = await opts.redis.incr(key)
        if (count === 1) await opts.redis.pexpire(key, opts.windowMs)
        redisRetryAt = 0
        return { count, source: "redis" }
      } catch (error) {
        redisRetryAt = now + REDIS_RETRY_COOLDOWN_MS
        if (now - lastRedisWarningAt >= REDIS_RETRY_COOLDOWN_MS) {
          lastRedisWarningAt = now
          opts.logger?.warn?.("auth email rate limit using local fallback", {
            errorName: error instanceof Error ? error.name : "UnknownError",
            retryInMs: REDIS_RETRY_COOLDOWN_MS,
          })
        }
      }
    }
    return { count: incrementLocal(key, now), source: "local" }
  }

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
          const { count, source } = await increment(redisKey)
          if (count > limit) {
            opts.logger?.info("auth email rate limit triggered", {
              emailHash: hashEmail(email),
              endpoint: prefix,
              count,
              limit,
              source,
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
