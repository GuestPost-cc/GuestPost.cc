import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

function configuredOrigin(value: string | undefined) {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function contentSecurityPolicy(nonce: string) {
  const development = process.env.NODE_ENV !== "production"
  const connectSources = [
    "'self'",
    configuredOrigin(process.env.NEXT_PUBLIC_API_URL),
    configuredOrigin(process.env.NEXT_PUBLIC_PORTAL_URL),
    configuredOrigin(process.env.NEXT_PUBLIC_PUBLISHER_URL),
    "https://*.ingest.sentry.io",
    ...(development ? ["http:", "ws:", "wss:"] : []),
  ].filter((source): source is string => Boolean(source))

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
  const nonce = crypto.randomUUID().replaceAll("-", "")
  const policy = contentSecurityPolicy(nonce)
  const requestHeaders = new Headers(request.headers)

  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set("Content-Security-Policy", policy)

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })

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
