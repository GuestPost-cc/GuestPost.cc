import { hostnameFromHostHeader, resolveApiOrigin } from "@guestpost/api-client"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

function contentSecurityPolicy(nonce: string, request: NextRequest) {
  const development = process.env.NODE_ENV !== "production"
  const connectSources = [
    "'self'",
    resolveApiOrigin({
      configuredUrl: process.env.NEXT_PUBLIC_API_URL,
      browserLocation: {
        hostname:
          hostnameFromHostHeader(request.headers.get("host")) ??
          request.nextUrl.hostname,
        protocol: request.nextUrl.protocol,
      },
      nodeEnv: process.env.NODE_ENV,
    }),
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
  // The auth session is owned by the API host and may not be visible to this
  // sibling app host. Dashboard layouts verify it through the API instead.
  const nonce = crypto.randomUUID().replaceAll("-", "")
  const policy = contentSecurityPolicy(nonce, request)
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set("Content-Security-Policy", policy)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set("Content-Security-Policy", policy)
  return response
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|robots.txt|sitemap.xml|llms.txt|\\.well-known/security.txt).*)",
  ],
}
