import {
  getSessionCookieValue,
  PORTAL_MIDDLEWARE_CONFIG,
  requiresAuthRedirect,
} from "@guestpost/shared/dist/middleware-auth"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

function contentSecurityPolicy(nonce: string) {
  const development = process.env.NODE_ENV !== "production"
  const connectSources = [
    "'self'",
    process.env.NEXT_PUBLIC_API_URL,
    "https://*.ingest.sentry.io",
    ...(development ? ["http:", "ws:", "wss:"] : []),
  ].filter(Boolean)

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
      development ? " 'unsafe-eval'" : ""
    }`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    ...(development ? [] : ["upgrade-insecure-requests"]),
  ].join("; ")
}

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/dashboard")) {
    const auth = requiresAuthRedirect(
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
      getSessionCookieValue((name) => request.cookies.get(name)),
      PORTAL_MIDDLEWARE_CONFIG,
    )
    if (auth.needsRedirect) {
      const url = new URL(auth.signInPath, request.url)
      url.searchParams.set("returnTo", auth.redirect!)
      return NextResponse.redirect(url)
    }
  }
  const nonce = crypto.randomUUID().replaceAll("-", "")
  const policy = contentSecurityPolicy(nonce)
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set("Content-Security-Policy", policy)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set("Content-Security-Policy", policy)
  return response
}

export const config = {
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|robots.txt|sitemap.xml|llms.txt|\\.well-known/security.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
}
