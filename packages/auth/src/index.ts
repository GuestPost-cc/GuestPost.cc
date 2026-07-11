import { prisma } from "@guestpost/database"
import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { getOAuthState } from "better-auth/api"
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

export type PortalIntent = "customer" | "publisher"

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
  /**
   * Called after birth-time signup provisioning changes the derived auth
   * context (memberships, publisher memberships, active org/publisher).
   * Passed by the API app to avoid importing Nest internals here.
   */
  invalidateAuthContext?: (userId: string) => void
}

function normalizePortalIntent(value: unknown): PortalIntent | null {
  if (value === "publisher") return "publisher"
  if (value === "customer") return "customer"
  return null
}

function portalIntentFromUrl(
  rawUrl: string | null | undefined,
): PortalIntent | null {
  if (!rawUrl) return null
  try {
    const url = new URL(
      rawUrl,
      process.env.BETTER_AUTH_URL ?? "http://localhost:4000",
    )
    const direct = normalizePortalIntent(url.searchParams.get("portal"))
    if (direct) return direct

    const callbackURL = url.searchParams.get("callbackURL")
    if (callbackURL) return portalIntentFromUrl(callbackURL)
  } catch {
    return null
  }
  return null
}

function portalIntentFromOrigin(
  rawOrigin: string | null | undefined,
): PortalIntent | null {
  if (!rawOrigin) return null
  try {
    const origin = new URL(rawOrigin)
    if (origin.port === "3002") return "publisher"
    if (origin.port === "3001") return "customer"
  } catch {
    return null
  }
  return null
}

async function resolvePortalIntent(ctx: any): Promise<PortalIntent> {
  const oauthState = await getOAuthState().catch(() => null)
  const fromOAuthState = portalIntentFromUrl(oauthState?.callbackURL)
  if (fromOAuthState) return fromOAuthState

  const request = ctx?.request
  const headers = request?.headers
  const headerValue =
    headers?.get?.("x-portal-type") ?? headers?.["x-portal-type"]
  const fromHeader = normalizePortalIntent(headerValue)
  if (fromHeader) return fromHeader

  const fromUrl = portalIntentFromUrl(request?.url)
  if (fromUrl) return fromUrl

  const body = ctx?.body ?? request?.body
  const fromBody = normalizePortalIntent(body?.portal)
  if (fromBody) return fromBody

  const callbackURL = body?.callbackURL ?? body?.callbackUrl ?? body?.redirectTo
  const fromCallback = portalIntentFromUrl(callbackURL)
  if (fromCallback) return fromCallback

  const origin = headers?.get?.("origin") ?? headers?.origin
  const fromOrigin = portalIntentFromOrigin(origin)
  if (fromOrigin) return fromOrigin

  const referer = headers?.get?.("referer") ?? headers?.referer
  const fromReferer = portalIntentFromOrigin(referer)
  if (fromReferer) return fromReferer

  return "customer"
}

function displayName(
  value: string | null | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim()
  return (trimmed || fallback).slice(0, 120)
}

async function provisionCustomerAccount(user: {
  id: string
  email: string
  name?: string | null
}) {
  const hasMembership = await prisma.membership.count({
    where: { userId: user.id },
  })
  if (hasMembership > 0) return

  const orgName = `${displayName(user.name, "Client")}'s Workspace`
  await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: orgName,
        slug: `cust-${user.id.slice(0, 12)}`,
      },
    })
    await tx.membership.create({
      data: {
        userId: user.id,
        organizationId: org.id,
        role: "OWNER",
        status: "ACTIVE",
      },
    })
  })
}

async function provisionPublisherAccount(user: {
  id: string
  email: string
  name?: string | null
}) {
  const hasPublisherMembership = await prisma.publisherMembership.count({
    where: { userId: user.id },
  })
  if (hasPublisherMembership > 0) return

  const name = displayName(user.name, user.email)
  await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: `Publisher org for ${user.email}`,
        slug: `pub-${user.id.slice(0, 12)}`,
      },
    })
    const publisher = await tx.publisher.create({
      data: {
        name,
        email: user.email,
        organizationId: org.id,
        tier: "NEW",
      },
    })
    await tx.publisherMembership.create({
      data: {
        userId: user.id,
        publisherId: publisher.id,
        role: "PUBLISHER_OWNER",
      },
    })
  })
}

async function convertFreshCustomerToPublisher(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new Error("USER_NOT_FOUND")
  if (user.userType === "PUBLISHER") {
    await provisionPublisherAccount(user)
    return
  }
  if (user.userType !== "CUSTOMER") return

  const [customerMemberships, publisherMemberships] = await Promise.all([
    prisma.membership.count({ where: { userId, status: "ACTIVE" } }),
    prisma.publisherMembership.count({ where: { userId } }),
  ])
  if (publisherMemberships > 0) {
    await prisma.user.update({
      where: { id: userId },
      data: { userType: "PUBLISHER" },
    })
    return
  }
  if (customerMemberships > 0) {
    throw new Error("ACCOUNT_COLLISION_USE_SEPARATE_PROFILE")
  }

  await provisionPublisherAccount(user)
  await prisma.user.update({
    where: { id: userId },
    data: { userType: "PUBLISHER" },
  })
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
    user: {
      additionalFields: {
        userType: {
          type: "string",
          required: true,
          defaultValue: "CUSTOMER",
          input: false,
        },
      },
    },
    session: {
      expiresIn: 8 * 60 * 60, // 8 hours — stolen cookie window bounded
      updateAge: 30 * 60, // 30 min — active users extend expiry; keeps
      // thieves' window from being infinite
    },
    emailAndPassword: {
      enabled: true,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user: any, ctx: any) => {
            const portalIntent = await resolvePortalIntent(ctx)
            return {
              data: {
                ...user,
                userType:
                  portalIntent === "publisher" ? "PUBLISHER" : "CUSTOMER",
              },
            }
          },
          after: async (user: any) => {
            if (user.userType === "PUBLISHER") {
              await provisionPublisherAccount(user)
            } else if (user.userType === "CUSTOMER") {
              await provisionCustomerAccount(user)
            }
            opts.invalidateAuthContext?.(user.id)
          },
        },
      },
      session: {
        create: {
          before: async (session: any, ctx: any) => {
            const portalIntent = await resolvePortalIntent(ctx)
            if (portalIntent === "publisher") {
              await convertFreshCustomerToPublisher(session.userId)
              opts.invalidateAuthContext?.(session.userId)
            }
            return { data: session }
          },
        },
      },
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
      cookies: {
        oauth_state: {
          attributes: {
            sameSite:
              (process.env.OAUTH_STATE_COOKIE_SAMESITE as
                | "Strict"
                | "Lax"
                | "None") ||
              (() => {
                throw new Error("OAUTH_STATE_COOKIE_SAMESITE must be set")
              })(),
            secure:
              process.env.OAUTH_STATE_COOKIE_SECURE === "true"
                ? true
                : process.env.OAUTH_STATE_COOKIE_SECURE === "false"
                  ? false
                  : (() => {
                      throw new Error("OAUTH_STATE_COOKIE_SECURE must be set")
                    })(),
          },
        },
        state: {
          attributes: {
            sameSite:
              (process.env.OAUTH_STATE_COOKIE_SAMESITE as
                | "Strict"
                | "Lax"
                | "None") ||
              (() => {
                throw new Error("OAUTH_STATE_COOKIE_SAMESITE must be set")
              })(),
            secure:
              process.env.OAUTH_STATE_COOKIE_SECURE === "true"
                ? true
                : process.env.OAUTH_STATE_COOKIE_SECURE === "false"
                  ? false
                  : (() => {
                      throw new Error("OAUTH_STATE_COOKIE_SECURE must be set")
                    })(),
          },
        },
      },
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

// Re-export types for consumers
export type {
  AuthError,
  AuthenticatedUser,
  AuthProvider,
  AuthSession,
  SignInResult,
} from "./types"
