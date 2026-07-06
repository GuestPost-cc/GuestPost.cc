import {
  ADMIN_MIDDLEWARE_CONFIG,
  requiresAuthRedirect,
  SESSION_COOKIE_NAME,
} from "@guestpost/shared/dist/middleware-auth"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

export const config = {
  matcher: ["/dashboard/:path*"],
}

export function middleware(request: NextRequest) {
  const result = requiresAuthRedirect(
    request.nextUrl.pathname,
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
    ADMIN_MIDDLEWARE_CONFIG,
  )
  if (result.needsRedirect) {
    const url = new URL(result.signInPath, request.url)
    url.searchParams.set("redirect", result.redirect!)
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}
