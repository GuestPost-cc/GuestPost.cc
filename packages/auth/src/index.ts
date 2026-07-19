import { prisma } from "@guestpost/database"
import { CURRENT_TERMS_VERSION, TERMS_DOCUMENT_TYPE } from "@guestpost/shared"
import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { APIError, createAuthMiddleware, getOAuthState } from "better-auth/api"
import { toNodeHandler } from "better-auth/node"
import { renderPasswordResetEmail } from "./email-templates/password-reset.js"
import { renderVerificationEmail } from "./email-templates/verification.js"
import {
  type EmailRateLimitOptions,
  emailRateLimitPlugin,
} from "./plugins/email-rate-limit.js"
import { validateAuthRequest } from "./request-validation.js"
import {
  AUTH_ACCOUNT_OPTIONS,
  AUTH_SESSION_OPTIONS,
  googleProviderOptions,
} from "./security-options.js"

export type { PasswordResetEmailContext } from "./email-templates/password-reset.js"
export { renderPasswordResetEmail } from "./email-templates/password-reset.js"
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
type AuthAudience = PortalIntent | "staff"

interface SignupConsent {
  accepted: true
  version: string
  method: "email" | "google"
  audience: PortalIntent
}

const SIGNUP_CONSENT_CONTEXT_KEY = "__guestpostSignupConsent"

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

function normalizeAuthAudience(value: unknown): AuthAudience | null {
  if (value === "publisher") return "publisher"
  if (value === "customer") return "customer"
  if (value === "staff") return "staff"
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
    const direct = normalizeAuthAudience(url.searchParams.get("portal"))
    if (direct === "customer" || direct === "publisher") return direct

    const callbackURL = url.searchParams.get("callbackURL")
    if (callbackURL) return portalIntentFromUrl(callbackURL)
  } catch {
    return null
  }
  return null
}

function audienceFromOrigin(
  rawOrigin: string | null | undefined,
): AuthAudience | null {
  if (!rawOrigin) return null
  try {
    const origin = new URL(rawOrigin)
    if (origin.port === "3002") return "publisher"
    if (origin.port === "3001") return "customer"
    if (origin.port === "3003") return "staff"
  } catch {
    return null
  }
  return null
}

async function resolveAuthAudience(ctx: any): Promise<AuthAudience | null> {
  const oauthState = await getOAuthState().catch(() => null)
  const explicitOAuthAudience = normalizeAuthAudience(
    (oauthState as any)?.portal ?? (oauthState as any)?.audience,
  )
  if (explicitOAuthAudience) return explicitOAuthAudience
  const fromOAuthState = portalIntentFromUrl(oauthState?.callbackURL)
  if (fromOAuthState) return fromOAuthState

  const request = ctx?.request
  // Better Auth route middleware exposes request.headers, while database
  // hooks expose ctx.headers directly. Read both so portal enforcement cannot
  // disappear when the same request crosses the adapter boundary.
  const headers = ctx?.headers ?? request?.headers
  const headerValue =
    headers?.get?.("x-portal-type") ?? headers?.["x-portal-type"]
  const fromHeader = normalizeAuthAudience(headerValue)
  if (fromHeader) return fromHeader

  const fromUrl = portalIntentFromUrl(request?.url)
  if (fromUrl) return fromUrl

  const body = ctx?.body ?? request?.body
  const fromBody = normalizeAuthAudience(body?.portal)
  if (fromBody) return fromBody

  const callbackURL = body?.callbackURL ?? body?.callbackUrl ?? body?.redirectTo
  const fromCallback = portalIntentFromUrl(callbackURL)
  if (fromCallback) return fromCallback

  const origin = headers?.get?.("origin") ?? headers?.origin
  const fromOrigin = audienceFromOrigin(origin)
  if (fromOrigin) return fromOrigin

  const referer = headers?.get?.("referer") ?? headers?.referer
  const fromReferer = audienceFromOrigin(referer)
  if (fromReferer) return fromReferer

  return null
}

function readHeader(ctx: any, name: string): string | null {
  const headers = ctx?.headers ?? ctx?.request?.headers
  const value = headers?.get?.(name) ?? headers?.[name]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

async function isAccountSuspended(
  user: {
    id: string
    banned: boolean
    banExpires: Date | null
  },
  onRestored?: (userId: string) => void,
): Promise<boolean> {
  if (!user.banned) return false
  if (!user.banExpires || user.banExpires.getTime() > Date.now()) return true

  // Expired temporary suspensions are restored atomically at the first auth
  // boundary. No session is resurrected; the user must complete a fresh login.
  await prisma.$transaction(async (tx) => {
    const restored = await tx.user.updateMany({
      where: {
        id: user.id,
        banned: true,
        banExpires: { lte: new Date() },
      },
      data: {
        banned: false,
        banReason: null,
        banReasonCode: null,
        banExpires: null,
        suspendedAt: null,
        suspendedByUserId: null,
      },
    })
    if (restored.count > 0) {
      await tx.auditLog.create({
        data: {
          action: "USER_SUSPENSION_EXPIRED",
          entityType: "User",
          entityId: user.id,
          metadata: { userId: user.id, source: "AUTH_BOUNDARY" },
          userId: null,
          organizationId: null,
        },
      })
    }
  })
  onRestored?.(user.id)
  return false
}

function rememberSignupConsent(ctx: any, consent: SignupConsent): void {
  if (ctx && typeof ctx === "object") ctx[SIGNUP_CONSENT_CONTEXT_KEY] = consent
  if (ctx?.context && typeof ctx.context === "object") {
    ctx.context[SIGNUP_CONSENT_CONTEXT_KEY] = consent
  }
}

async function resolveSignupConsent(ctx: any): Promise<SignupConsent | null> {
  const stored =
    ctx?.[SIGNUP_CONSENT_CONTEXT_KEY] ??
    ctx?.context?.[SIGNUP_CONSENT_CONTEXT_KEY]
  if (stored?.accepted === true) return stored as SignupConsent

  const state = (await getOAuthState().catch(() => null)) as any
  const audience = normalizeAuthAudience(state?.portal ?? state?.audience)
  if (
    state?.authFlow === "signup" &&
    state?.termsAccepted === true &&
    state?.termsVersion === CURRENT_TERMS_VERSION &&
    (audience === "customer" || audience === "publisher")
  ) {
    return {
      accepted: true,
      version: CURRENT_TERMS_VERSION,
      method: "google",
      audience,
    }
  }

  return null
}

function userTypeForAudience(
  audience: AuthAudience,
): "CUSTOMER" | "PUBLISHER" | "STAFF" {
  if (audience === "publisher") return "PUBLISHER"
  if (audience === "staff") return "STAFF"
  return "CUSTOMER"
}

function wrongPortalMessage(
  actual: "CUSTOMER" | "PUBLISHER" | "STAFF",
): string {
  if (actual === "CUSTOMER") {
    return "This account is registered as a customer. Open the Customer portal or use a different account."
  }
  if (actual === "PUBLISHER") {
    return "This account is registered as a publisher. Open the Publisher portal or use a different account."
  }
  return "Staff accounts must sign in through the Admin portal."
}

async function recordLegalAcceptance(
  user: { id: string; userType: "CUSTOMER" | "PUBLISHER" },
  consent: SignupConsent,
  ctx: any,
): Promise<void> {
  const forwardedFor = readHeader(ctx, "x-forwarded-for")
  const ipAddress =
    readHeader(ctx, "cf-connecting-ip") ??
    forwardedFor?.split(",")[0]?.trim() ??
    null

  await prisma.legalAcceptance.upsert({
    where: {
      userId_documentType_documentVersion: {
        userId: user.id,
        documentType: TERMS_DOCUMENT_TYPE,
        documentVersion: consent.version,
      },
    },
    create: {
      userId: user.id,
      documentType: TERMS_DOCUMENT_TYPE,
      documentVersion: consent.version,
      method: consent.method,
      audience: user.userType,
      ipAddress,
      userAgent: readHeader(ctx, "user-agent"),
      requestId: readHeader(ctx, "x-request-id"),
    },
    update: {},
  })
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

const validateAuthRequestMiddleware = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/sign-in/email") {
    const audience = await resolveAuthAudience(ctx)
    if (!audience) {
      throw APIError.from("BAD_REQUEST", {
        code: "INVALID_AUDIENCE",
        message: "Choose the portal for this sign-in request.",
      })
    }
  }

  if (ctx.path === "/sign-in/social") {
    const additionalData = ctx.body?.additionalData
    const audience = normalizeAuthAudience(
      additionalData?.portal ?? additionalData?.audience,
    )
    const flow = additionalData?.authFlow
    const isSignup = ctx.body?.requestSignUp === true

    if (
      (flow !== "login" && flow !== "signup") ||
      (flow === "signup") !== isSignup ||
      (audience !== "customer" && audience !== "publisher")
    ) {
      throw APIError.from("BAD_REQUEST", {
        code: "INVALID_AUTH_FLOW",
        message: "Start Google authentication from a GuestPost login page.",
      })
    }

    if (
      isSignup &&
      (additionalData?.termsAccepted !== true ||
        additionalData?.termsVersion !== CURRENT_TERMS_VERSION)
    ) {
      throw APIError.from("BAD_REQUEST", {
        code: "TERMS_REQUIRED",
        message:
          "Accept the current Terms of Service before creating an account.",
      })
    }
  }

  const validation = validateAuthRequest(ctx.path, ctx.body)
  if (!validation) return

  if (!validation.success) {
    throw APIError.from("BAD_REQUEST", {
      code: "VALIDATION_ERROR",
      message: validation.message,
    })
  }

  Object.assign(ctx.body, validation.data)

  if (ctx.path === "/sign-up/email") {
    const audience = await resolveAuthAudience(ctx)
    if (audience !== "customer" && audience !== "publisher") {
      throw APIError.from("BAD_REQUEST", {
        code: "INVALID_AUDIENCE",
        message: "Choose a customer or publisher account type.",
      })
    }
    rememberSignupConsent(ctx, {
      accepted: true,
      version: CURRENT_TERMS_VERSION,
      method: "email",
      audience,
    })

    // Consent is persisted by the user create hook. These request-only
    // fields must not reach Better Auth's user adapter as unknown columns.
    delete ctx.body.termsAccepted
    delete ctx.body.termsVersion
  }
})

const redactBrowserSessionTokenMiddleware = createAuthMiddleware(
  async (ctx) => {
    if (
      ![
        "/get-session",
        "/sign-in/email",
        "/sign-in/social",
        "/sign-up/email",
      ].includes(ctx.path)
    ) {
      return
    }

    const returned = ctx.context.returned
    if (
      !returned ||
      returned instanceof Response ||
      typeof returned !== "object"
    ) {
      return
    }

    const safe = { ...(returned as Record<string, any>) }
    delete safe.token
    if (safe.session && typeof safe.session === "object") {
      safe.session = { ...safe.session }
      delete safe.session.token
    }
    return ctx.json(safe)
  },
)

/**
 * Phase 7.10 test seam — builds the option object passed to betterAuth().
 * Exposed so unit tests can inspect what we wire (`emailVerification` block,
 * `sendOnSignUp`, `afterEmailVerification`, etc.) without standing up a
 * real Better Auth runtime + Prisma adapter. The production path stays
 * `createAuth(opts) → betterAuth(buildAuthOptions(opts))`.
 */
export function buildAuthOptions(opts: AuthFactoryOptions = {}) {
  const authCookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim()

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
        // Safe, non-sensitive account state used only as a defensive client
        // guard. Suspension notes, actor, and reason codes are never exposed.
        banned: {
          type: "boolean",
          required: true,
          defaultValue: false,
          input: false,
        },
      },
    },
    // 8-hour rolling session with a 30-minute refresh cadence. The API adds
    // an absolute lifetime so a stolen cookie cannot be renewed forever.
    session: AUTH_SESSION_OPTIONS,
    hooks: {
      before: validateAuthRequestMiddleware,
      after: redactBrowserSessionTokenMiddleware,
    },
    emailAndPassword: {
      enabled: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: opts.sendEmail
        ? async ({
            user,
            url,
          }: {
            user: { email: string; name?: string | null }
            url: string
          }) => {
            await opts.sendEmail?.({
              to: user.email,
              subject: "Reset your password — GuestPost.cc",
              html: renderPasswordResetEmail({
                name: user.name ?? null,
                url,
              }),
              jobName: "send-password-reset-email",
            })
          }
        : undefined,
    },
    // Linking Google is an explicit account-settings action, never a login
    // side effect.
    account: AUTH_ACCOUNT_OPTIONS,
    databaseHooks: {
      user: {
        create: {
          before: async (user: any, ctx: any) => {
            const consent = await resolveSignupConsent(ctx)
            if (!consent) {
              throw APIError.from("BAD_REQUEST", {
                code: "TERMS_REQUIRED",
                message:
                  "Accept the current Terms of Service before creating an account.",
              })
            }
            return {
              data: {
                ...user,
                userType:
                  consent.audience === "publisher" ? "PUBLISHER" : "CUSTOMER",
              },
            }
          },
          after: async (user: any, ctx: any) => {
            const consent = await resolveSignupConsent(ctx)
            if (!consent) {
              throw APIError.from("BAD_REQUEST", {
                code: "TERMS_REQUIRED",
                message: "Account creation could not verify Terms acceptance.",
              })
            }
            if (user.userType === "PUBLISHER") {
              await provisionPublisherAccount(user)
            } else if (user.userType === "CUSTOMER") {
              await provisionCustomerAccount(user)
            }
            await recordLegalAcceptance(user, consent, ctx)
            opts.invalidateAuthContext?.(user.id)
          },
        },
      },
      session: {
        create: {
          before: async (session: any, ctx: any) => {
            const audience = await resolveAuthAudience(ctx)
            const user = await prisma.user.findUnique({
              where: { id: session.userId },
              select: { userType: true, banned: true, banExpires: true },
            })
            if (!user) {
              throw APIError.from("UNAUTHORIZED", {
                code: "USER_NOT_FOUND",
                message: "Account not found.",
              })
            }
            if (audience && user.userType !== userTypeForAudience(audience)) {
              throw APIError.from("FORBIDDEN", {
                code: "WRONG_PORTAL",
                message: wrongPortalMessage(user.userType),
              })
            }
            if (
              await isAccountSuspended(
                { id: session.userId, ...user },
                opts.invalidateAuthContext,
              )
            ) {
              throw APIError.from("FORBIDDEN", {
                code: "ACCOUNT_SUSPENDED",
                message: user.banExpires
                  ? `This account is suspended until ${user.banExpires.toISOString()}. Contact support if you believe this is a mistake.`
                  : "This account is suspended. Contact support if you believe this is a mistake.",
              })
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
      // Login never creates an account. Explicit signup opts in only after
      // the current Terms have been accepted.
      google: googleProviderOptions(),
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
      crossSubDomainCookies: authCookieDomain
        ? {
            enabled: true,
            domain: authCookieDomain,
          }
        : undefined,
      cookies: {
        oauth_state: {
          attributes: {
            sameSite:
              (process.env.OAUTH_STATE_COOKIE_SAMESITE as
                | "strict"
                | "lax"
                | "none") ||
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
                | "strict"
                | "lax"
                | "none") ||
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
    plugins: opts.emailRateLimit
      ? [emailRateLimitPlugin(opts.emailRateLimit)]
      : [],
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
