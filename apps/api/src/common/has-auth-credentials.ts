// Shape check against Better Auth signed-cookie format (verified against
// better-auth@1.6.14 cookies/index.mjs + better-call@1.3.5 crypto.mjs).
//
// Cookie name: Better Auth checks both `${prefix}.${name}` and
// `${prefix}-${name}`. Our config sets prefix=guestpost, name defaults to
// session_token → guestpost.session_token or guestpost-session_token.
//
// Cookie value: encodeURIComponent(`${token}.${base64(HMAC-SHA256)}`).
// After URL-decode: token segment + `.` + base64 (44 chars incl. padding).
// We only verify shape, not the HMAC — that costs a DB round-trip.
// Forged-but-shaped cookies still get rejected at AuthGuard. The point
// of this check is the rate-limit tier bump, not session validity.

const SESSION_COOKIE_RE = /(?:^|;\s*)guestpost[.-]session_token=([^;]+)/
const SIGNED_VALUE_RE = /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9+/]{40,}={0,2}$/

interface HasAuthCredentialsRequest {
  headers: {
    authorization?: string
    cookie?: string
  }
}

export function hasAuthCredentials(req: HasAuthCredentialsRequest): boolean {
  if (req.headers.authorization?.startsWith("Bearer ")) return true
  const cookie = req.headers.cookie
  if (typeof cookie !== "string") return false
  const match = cookie.match(SESSION_COOKIE_RE)
  if (!match) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(match[1])
  } catch {
    return false
  }
  return SIGNED_VALUE_RE.test(decoded)
}
