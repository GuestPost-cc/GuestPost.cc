/**
 * The single source of truth for the session cookie name.
 *
 * Better Auth sets `{cookiePrefix}.session_token` = `guestpost.session_token`.
 * All middlewares and server-side credential-checkers MUST use this constant
 * rather than hard-coding the string, otherwise login redirects loop.
 * @see https://github.com/anomalyco/GuestPost.cc-work/blob/main/bedrock/Memory/SECURITY.md
 */
export const SESSION_COOKIE_NAME = "guestpost.session_token"

export interface MiddlewareAuthConfig {
  signInPath: string
  protectedPaths: string[]
}

export function requiresAuthRedirect(
  pathname: string,
  sessionCookie: string | null | undefined,
  config: MiddlewareAuthConfig,
):
  | { needsRedirect: true; signInPath: string; redirect?: string }
  | { needsRedirect: false } {
  const isProtected = config.protectedPaths.some((p) => pathname.startsWith(p))
  if (!isProtected) return { needsRedirect: false }

  if (!sessionCookie) {
    return {
      needsRedirect: true,
      signInPath: config.signInPath,
      redirect: pathname,
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
