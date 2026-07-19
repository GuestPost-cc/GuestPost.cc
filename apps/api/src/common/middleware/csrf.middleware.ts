import {
  ForbiddenException,
  Injectable,
  Logger,
  type NestMiddleware,
} from "@nestjs/common"
import { type NextFunction, type Request, type Response } from "express"
import { isTrustedOrigin } from "../security/trusted-origins"

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CsrfMiddleware.name)

  use(req: Request, _res: Response, next: NextFunction): void {
    // Safe methods are not subject to CSRF
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next()
      return
    }

    // Better Auth applies its own Origin/Fetch Metadata checks to auth routes.
    if (req.path.startsWith("/api/v1/auth/")) {
      next()
      return
    }

    // No session cookie = nothing to hijack
    const cookies = req.headers.cookie ?? ""
    const hasSessionCookie =
      cookies.includes("guestpost.session_token") ||
      cookies.includes("__Secure-guestpost.session_token") ||
      cookies.includes("guestpost-session_token") ||
      cookies.includes("__Secure-guestpost-session_token")
    if (!hasSessionCookie) {
      next()
      return
    }

    const origin = req.headers.origin ?? req.headers.referer
    const fetchSite = req.headers["sec-fetch-site"]
    const hasProtectionHeader = req.headers["x-csrf-protection"] === "1"
    const trustedFetchSite =
      !fetchSite || fetchSite === "same-origin" || fetchSite === "same-site"

    if (isTrustedOrigin(origin) && trustedFetchSite && hasProtectionHeader) {
      next()
      return
    }

    this.logger.warn(`CSRF blocked ${req.method} ${req.path}`)
    throw new ForbiddenException("CSRF validation failed")
  }
}
