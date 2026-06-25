/**
 * Phase 7.10 — Email verification flow wiring spec.
 *
 * Scope: tests the contracts between Better Auth's `emailVerification`
 * block (built by buildAuthOptions in @guestpost/auth) and the
 * AuthGuard's in-memory cache invalidation. Inspects the option object
 * we pass to betterAuth() via the test seam (buildAuthOptions) instead
 * of standing up a full Nest+supertest stack — the repo doesn't have
 * HTTP integration infrastructure today, and building it for one phase
 * would be substantial scope creep.
 *
 * Each link of the chain is proven at the function level here:
 *
 *   verifyEmail → afterEmailVerification → onEmailVerified
 *               → invalidateAuthContext → next cache lookup returns null
 *
 * The full HTTP-level end-to-end (case (e) in the plan) is covered by
 * the manual smoke step documented in the PR body; building Nest+supertest
 * integration test infrastructure is captured as a follow-up backlog
 * item.
 */
import { buildAuthOptions, type SendEmailArgs } from "@guestpost/auth"
import {
  clearAuthContextCache,
  getCachedAuthContext,
  invalidateAuthContext,
  setCachedAuthContext,
} from "../common/auth-context-cache"

describe("Phase 7.10 — buildAuthOptions emailVerification wiring", () => {
  describe("when buildAuthOptions is called WITHOUT sendEmail (back-compat singleton path)", () => {
    it("does NOT register an emailVerification block", () => {
      const built = buildAuthOptions()
      expect(built.emailVerification).toBeUndefined()
    })
  })

  describe("when buildAuthOptions is called WITH sendEmail", () => {
    it("registers a sendVerificationEmail callback that invokes the supplied sendEmail", async () => {
      const sendEmail = jest.fn(async (_args: SendEmailArgs) => {})
      const built = buildAuthOptions({ sendEmail })

      expect(typeof built.emailVerification?.sendVerificationEmail).toBe(
        "function",
      )

      // Drive the callback as Better Auth would.
      await built.emailVerification?.sendVerificationEmail?.({
        user: { id: "u-1", email: "alice@example.com", name: "Alice" } as any,
        url: "https://app.example/api/v1/auth/verify-email?token=abc",
        token: "abc",
      })

      expect(sendEmail).toHaveBeenCalledTimes(1)
      expect(sendEmail).toHaveBeenCalledWith({
        to: "alice@example.com",
        subject: expect.stringContaining("Verify"),
        html: expect.stringContaining("Hi Alice"),
        jobName: "send-verification-email",
      })
    })

    it("embeds the verify-email URL in the rendered email body", async () => {
      const sendEmail = jest.fn(async (_args: SendEmailArgs) => {})
      const built = buildAuthOptions({ sendEmail })
      const url = "https://app.example/api/v1/auth/verify-email?token=abc123"
      await built.emailVerification?.sendVerificationEmail?.({
        user: { id: "u-1", email: "alice@example.com", name: "Alice" } as any,
        url,
        token: "abc123",
      })
      const args = sendEmail.mock.calls[0][0]
      expect(args.html).toContain(`href="${url}"`)
    })

    it("auto-sends verification on signup (sendOnSignUp: true)", () => {
      const built = buildAuthOptions({ sendEmail: jest.fn() })
      expect(built.emailVerification?.sendOnSignUp).toBe(true)
    })

    it("auto-signs in after verification (autoSignInAfterVerification: true)", () => {
      const built = buildAuthOptions({ sendEmail: jest.fn() })
      expect(built.emailVerification?.autoSignInAfterVerification).toBe(true)
    })

    it("uses a 24h token lifetime (expiresIn: 86400 seconds)", () => {
      const built = buildAuthOptions({ sendEmail: jest.fn() })
      expect(built.emailVerification?.expiresIn).toBe(60 * 60 * 24)
    })
  })

  describe("when buildAuthOptions is called WITH onEmailVerified", () => {
    it("registers an afterEmailVerification callback that invokes the supplied onEmailVerified with userId", async () => {
      const onEmailVerified = jest.fn()
      const built = buildAuthOptions({
        sendEmail: jest.fn(),
        onEmailVerified,
      })

      expect(typeof built.emailVerification?.afterEmailVerification).toBe(
        "function",
      )

      await built.emailVerification?.afterEmailVerification?.({
        id: "u-42",
        email: "bob@example.com",
        emailVerified: true,
      } as any)

      expect(onEmailVerified).toHaveBeenCalledTimes(1)
      expect(onEmailVerified).toHaveBeenCalledWith("u-42")
    })

    it("does NOT register afterEmailVerification when only sendEmail is supplied", () => {
      const built = buildAuthOptions({ sendEmail: jest.fn() })
      expect(built.emailVerification?.afterEmailVerification).toBeUndefined()
    })
  })
})

describe("Phase 7.10 — verifyEmail → onEmailVerified → cache-invalidation chain", () => {
  beforeEach(() => {
    clearAuthContextCache()
  })

  it("populates the cache, invalidates via onEmailVerified, next lookup misses", async () => {
    // Setup: AuthGuard would have populated the cache with the
    // unverified state on a prior request (the load-bearing precondition
    // for the test — without this, the test would pass even if
    // invalidation did nothing).
    setCachedAuthContext("u-100", {
      id: "u-100",
      emailVerified: false,
      userType: "CUSTOMER",
    })
    expect(getCachedAuthContext("u-100")).not.toBeNull()

    // Trigger: simulate Better Auth firing the afterEmailVerification
    // callback after a successful /verify-email round-trip. The wiring
    // proven by the previous describe block routes this to
    // invalidateAuthContext via the onEmailVerified option.
    const built = buildAuthOptions({
      sendEmail: jest.fn(),
      onEmailVerified: (userId) => invalidateAuthContext(userId),
    })
    await built.emailVerification?.afterEmailVerification?.({
      id: "u-100",
      email: "alice@example.com",
      emailVerified: true,
    } as any)

    // Assert: the cache entry is gone. AuthGuard's next call for u-100
    // would miss the cache, re-fetch from DB, and see emailVerified=true.
    expect(getCachedAuthContext("u-100")).toBeNull()
  })

  it("invalidating one user does not affect others (regression guard)", async () => {
    setCachedAuthContext("u-200", { id: "u-200", emailVerified: false })
    setCachedAuthContext("u-201", { id: "u-201", emailVerified: false })

    const built = buildAuthOptions({
      sendEmail: jest.fn(),
      onEmailVerified: (userId) => invalidateAuthContext(userId),
    })
    await built.emailVerification?.afterEmailVerification?.({
      id: "u-200",
      email: "alice@example.com",
      emailVerified: true,
    } as any)

    expect(getCachedAuthContext("u-200")).toBeNull()
    expect(getCachedAuthContext("u-201")).not.toBeNull()
  })
})
