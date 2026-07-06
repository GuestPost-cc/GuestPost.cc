import { prisma } from "@guestpost/database"
import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { toNodeHandler } from "better-auth/node"
import { bearer } from "better-auth/plugins/bearer"
import { renderVerificationEmail } from "./email-templates/verification.js"
import {
  type EmailRateLimitOptions,
  emailRateLimitPlugin,
} from "./plugins/email-rate-limit.js"

export type { VerificationEmailContext } from "./email-templates/verification.js"
export { renderVerificationEmail } from "./email-templates/verification.js"
export { emailRateLimitPlugin } from "./plugins/email-rate-limit.js"
export type { EmailRateLimitOptions }
export { toNodeHandler }

// Fail closed: silently trusting localhost origins in production would relax
// origin checking on a money platform. Same pattern as QUEUE_SIGNING_SECRET.
if (process.env.NODE_ENV === "production" && !process.env.TRUSTED_ORIGINS) {
  throw new Error(
    "TRUSTED_ORIGINS is required in production (comma-separated list of app origins)",
  )
}

export interface SendEmailArgs {
  to: string
  subject: string
  html: string
  /** Mapped to the BullMQ job name (the worker switch keys off it for log tagging). */
  jobName?: string
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
  /**
   * Phase 7.10 — Hook for sending transactional emails (verification
   * today, future password-reset templates). Implementations should
   * enqueue to the worker email queue rather than send synchronously.
   *
   * When omitted, the `emailVerification` block is not registered, so
   * Better Auth's `/api/v1/auth/send-verification-email` endpoint returns
   * `VERIFICATION_EMAIL_NOT_ENABLED`. The back-compat singleton uses
   * this path — it's only for session lookup, not signup.
   */
  sendEmail?: (args: SendEmailArgs) => Promise<void>
  /**
   * Phase 7.10 — Called when a user's emailVerified flag flips to true
   * via Better Auth's verify-email handler. Lets callers invalidate the
   * AuthGuard's in-memory context cache immediately so the user's next
   * request after clicking the verify link sees the fresh `true`
   * (instead of waiting up to 30 s for the cache TTL to expire).
   */
  onEmailVerified?: (userId: string) => void
}

/**
 * Phase 7.10 test seam — builds the option object passed to betterAuth().
 * Exposed so unit tests can inspect what we wire (`emailVerification` block,
 * `sendOnSignUp`, `afterEmailVerification`, etc.) without standing up a
 * real Better Auth runtime + Prisma adapter. The production path stays
 * `createAuth(opts) → betterAuth(buildAuthOptions(opts))`.
 */
export function buildAuthOptions(opts: AuthFactoryOptions = {}) {
  return {
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:4000",
    basePath: "/api/v1/auth",
    database: prismaAdapter(prisma, {
      provider: "postgresql",
    }),
    session: {
      expiresIn: 8 * 60 * 60, // 8 hours — stolen cookie window bounded
      updateAge: 30 * 60, // 30 min — active users extend expiry; keeps
      // thieves' window from being infinite
    },
    emailAndPassword: {
      enabled: true,
    },
    // Phase 7.10 — Verification flow. Only registered when the caller
    // supplied `sendEmail`. Without it, signup completes silently with
    // `emailVerified: false` (the pre-7.10 broken state) and Better
    // Auth's `/send-verification-email` route returns NOT_ENABLED.
    emailVerification: opts.sendEmail
      ? {
          sendVerificationEmail: async ({
            user,
            url,
          }: {
            user: { email: string; name?: string | null }
            url: string
            token?: string
          }) => {
            await opts.sendEmail?.({
              to: user.email,
              subject: "Verify your email — GuestPost.cc",
              html: renderVerificationEmail({ name: user.name ?? null, url }),
              jobName: "send-verification-email",
            })
          },
          // Auto-send on signup (otherwise email/password signups silently
          // skip verification and the AuthGuard #25 gate becomes a one-way
          // trapdoor — Phase 7.10's whole motivating bug).
          sendOnSignUp: true,
          // After the user clicks the link, sign them in and redirect to the
          // app — smoother UX than landing on a "verified, now sign in" page.
          autoSignInAfterVerification: true,
          // 24h is generous enough for users who let the email sit overnight
          // without being a security risk (single-use tokens).
          expiresIn: 60 * 60 * 24,
          // Phase 0a verified: this purpose-built callback fires on the
          // verification transition. Replaces the noisier
          // `databaseHooks.user.update.after` approach considered earlier.
          afterEmailVerification: opts.onEmailVerified
            ? async (user: { id: string }) => {
                opts.onEmailVerified?.(user.id)
              }
            : undefined,
        }
      : undefined,
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? "",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      },
    },
    magicLink: {
      enabled: true,
    },
    trustedOrigins:
      process.env.NODE_ENV === "production"
        ? process.env.TRUSTED_ORIGINS?.split(",").map((o) => o.trim())
        : (((req: any) => {
            const origin = req?.headers?.get?.("origin") || req?.headers?.origin
            return origin
              ? [
                  origin,
                  "http://localhost:3000",
                  "http://localhost:3001",
                  "http://localhost:3002",
                  "http://localhost:3003",
                  "http://localhost:4000",
                ]
              : [
                  "http://localhost:3000",
                  "http://localhost:3001",
                  "http://localhost:3002",
                  "http://localhost:3003",
                  "http://localhost:4000",
                ]
          }) as any),
    advanced: {
      cookiePrefix: "guestpost",
      useSecureCookies: process.env.NODE_ENV === "production",
    },
    plugins: [
      bearer(),
      ...(opts.emailRateLimit
        ? [emailRateLimitPlugin(opts.emailRateLimit)]
        : []),
    ],
  }
}

export function createAuth(opts: AuthFactoryOptions = {}) {
  return betterAuth(buildAuthOptions(opts) as any)
}

// Back-compat singleton — used by AuthGuard (auth.api.getSession), which
// only reads sessions and does NOT need email-sending capability. Two
// Better Auth instances co-exist safely (verified during Phase 7.8
// pre-impl: server-side dist/index.mjs has zero process-global listeners,
// schedulers, or event-emitter registrations). Signup + verification go
// through the createAuth({sendEmail, onEmailVerified}) instance bound in
// apps/api/src/main.ts.
export const auth = createAuth()
