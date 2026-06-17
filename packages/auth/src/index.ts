import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { bearer } from "better-auth/plugins/bearer"
import { prisma } from "@guestpost/database"
import { toNodeHandler } from "better-auth/node"
import { emailRateLimitPlugin, type EmailRateLimitOptions } from "./plugins/email-rate-limit"

export { toNodeHandler }
export type { EmailRateLimitOptions }

// Fail closed: silently trusting localhost origins in production would relax
// origin checking on a money platform. Same pattern as QUEUE_SIGNING_SECRET.
if (process.env.NODE_ENV === "production" && !process.env.TRUSTED_ORIGINS) {
  throw new Error("TRUSTED_ORIGINS is required in production (comma-separated list of app origins)")
}

export interface AuthFactoryOptions {
  /**
   * When supplied, registers the Phase 7.8 email-keyed rate limiter on
   * the four email-typed auth endpoints. When omitted, the instance
   * runs without the plugin — used by the back-compat `auth` singleton
   * below, which is consumed by AuthGuard for session reads (no
   * rate-limit context needed there).
   */
  emailRateLimit?: EmailRateLimitOptions
}

export function createAuth(opts: AuthFactoryOptions = {}) {
  return betterAuth({
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:4000",
    basePath: "/api/v1/auth",
    database: prismaAdapter(prisma, {
      provider: "postgresql",
    }),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? "",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      },
    },
    magicLink: {
      enabled: true,
    },
    trustedOrigins: process.env.NODE_ENV === "production"
      ? process.env.TRUSTED_ORIGINS!.split(",").map((o) => o.trim())
      : ((req: any) => {
          const origin = req?.headers?.get?.("origin") || req?.headers?.origin
          return origin ? [origin, "http://localhost:3000", "http://localhost:3001", "http://localhost:3002", "http://localhost:3003", "http://localhost:4000"] : [
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3002",
            "http://localhost:3003",
            "http://localhost:4000",
          ]
        }) as any,
    advanced: {
      cookiePrefix: "guestpost",
      useSecureCookies: process.env.NODE_ENV === "production",
    },
    plugins: [
      bearer(),
      ...(opts.emailRateLimit ? [emailRateLimitPlugin(opts.emailRateLimit)] : []),
    ],
  })
}

// Back-compat singleton — used by AuthGuard (auth.api.getSession), which
// doesn't need rate-limit context. Two Better Auth instances co-exist
// safely (verified during Phase 7.8 pre-impl: server-side dist/index.mjs
// has zero process-global listeners, schedulers, or event-emitter
// registrations).
export const auth = createAuth()
