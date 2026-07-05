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
