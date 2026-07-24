import {
  ADMIN_MIDDLEWARE_CONFIG,
  getSessionCookieValue,
  requiresAuthRedirect,
} from "@guestpost/shared/dist/middleware-auth"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

export const config = {
  matcher: ["/dashboard/:path*"],
}

export function middleware(request: NextRequest) {
  const result = requiresAuthRedirect(
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
    getSessionCookieValue((name) => request.cookies.get(name)),
    ADMIN_MIDDLEWARE_CONFIG,
  )
  if (result.needsRedirect) {
    const url = new URL(result.signInPath, request.url)
    url.searchParams.set("returnTo", result.redirect!)
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}
