/**
 * Phase 7.8 #25 + AUTH-04 — email-verification gate policy.
 *
 * All user types (CUSTOMER, PUBLISHER, STAFF) require `User.emailVerified === true`
 * for state-changing operations. GET reads stay open so locked-out users
 * can still load dashboards and trigger their own verification email.
 * Auth and resend-verification endpoints are exempt (see EXEMPT_POST_PATHS).
 *
 * Pre-merge GET-mutation audit completed (Phase 7.8 commit 5): no GET
 * route in apps/api/src/modules/** mutates state, so "GETs stay open"
 * is safe.
 *
 * If a future GET route DOES mutate state, the right resolution is to
 * refactor it to POST/PATCH (preferred — wrong-verb endpoints are a
 * separate bug). EXEMPT_POST_PATHS is the policy's auditable surface
 * for any POST/PATCH/PUT/DELETE path that an unverified user must
 * still be able to reach.
 */

// Routes a CUSTOMER must still be able to hit even when emailVerified
// is false. Currently:
//   - /api/v1/auth/* — sign-out, send-verification-email, etc. The
//     user can't get out of the lockout if they can't sign out or
//     trigger a verification resend.
//   - /api/v1/users/me/resend-verification — explicit resend trigger if
//     added later; future-proof entry.
const EXEMPT_POST_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/v1\/auth\//,
  /^\/api\/v1\/users\/me\/resend-verification$/,
]

interface RequestLike {
  method: string
  path: string
}

export function requiresEmailVerification(req: RequestLike): boolean {
  if (
    req.method === "GET" ||
    req.method === "HEAD" ||
    req.method === "OPTIONS"
  ) {
    return false
  }
  return !EXEMPT_POST_PATHS.some((re) => re.test(req.path))
}

// Exported for the unit test.
export const __EXEMPT_POST_PATHS = EXEMPT_POST_PATHS
