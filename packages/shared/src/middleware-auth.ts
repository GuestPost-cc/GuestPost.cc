/**
 * Better Auth cookie names accepted by browser middleware.
 *
 * Development uses `guestpost.session_token`; production secure cookies use
 * `__Secure-guestpost.session_token`. Better Auth also accepts the historical
 * dash form, so middleware should tolerate it during migrations.
 */
export const SESSION_COOKIE_NAME = "guestpost.session_token"
export const SECURE_SESSION_COOKIE_NAME = "__Secure-guestpost.session_token"
export const LEGACY_SESSION_COOKIE_NAME = "guestpost-session_token"
export const SECURE_LEGACY_SESSION_COOKIE_NAME =
  "__Secure-guestpost-session_token"

export const SESSION_COOKIE_NAMES = [
  SECURE_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SECURE_LEGACY_SESSION_COOKIE_NAME,
  LEGACY_SESSION_COOKIE_NAME,
] as const

type CookieLookupResult = { value?: string } | string | null | undefined

const SIGNED_SESSION_COOKIE_RE =
  /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9+/]{40,}={0,2}$/

export function hasPlausibleSessionCookie(value: string | null | undefined) {
  if (!value) return false
  try {
    return SIGNED_SESSION_COOKIE_RE.test(decodeURIComponent(value))
  } catch {
    return false
  }
}

export function getSessionCookieValue(
  getCookie: (name: string) => CookieLookupResult,
): string | null {
  for (const name of SESSION_COOKIE_NAMES) {
    const cookie = getCookie(name)
    const value = typeof cookie === "string" ? cookie : cookie?.value
    if (value) return value
  }
  return null
}

export interface MiddlewareAuthConfig {
  signInPath: string
  protectedPaths: string[]
}

export function requiresAuthRedirect(
  requestPath: string,
  sessionCookie: string | null | undefined,
  config: MiddlewareAuthConfig,
):
  | { needsRedirect: true; signInPath: string; redirect?: string }
  | { needsRedirect: false } {
  const pathname = requestPath.split("?", 1)[0]
  const isProtected = config.protectedPaths.some((p) => pathname.startsWith(p))
  if (!isProtected) return { needsRedirect: false }

  if (!hasPlausibleSessionCookie(sessionCookie)) {
    return {
      needsRedirect: true,
      signInPath: config.signInPath,
      redirect: requestPath,
    }
  }

  return { needsRedirect: false }
}

export const ADMIN_MIDDLEWARE_CONFIG: MiddlewareAuthConfig = {
  signInPath: "/",
  protectedPaths: ["/dashboard"],
}

export const PORTAL_MIDDLEWARE_CONFIG: MiddlewareAuthConfig = {
  signInPath: "/",
  protectedPaths: ["/dashboard"],
}

export const PUBLISHER_MIDDLEWARE_CONFIG: MiddlewareAuthConfig = {
  signInPath: "/",
  protectedPaths: ["/dashboard"],
}
