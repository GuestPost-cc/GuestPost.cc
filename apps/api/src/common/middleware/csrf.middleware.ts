import {
  ForbiddenException,
  Injectable,
  type NestMiddleware,
} from "@nestjs/common"
import { type NextFunction, type Request, type Response } from "express"

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Safe methods are not subject to CSRF
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next()
      return
    }

    // Bearer token is CSRF-immune (stored in-memory, not cookie-borne).
    // The API client always sends both channels, so a Bearer header on any
    // state-changing request proves it's not a cross-origin forgery.
    if (req.headers.authorization?.startsWith("Bearer ")) {
      next()
      return
    }

    // No session cookie = nothing to hijack
    const cookies = req.headers.cookie ?? ""
    const hasSessionCookie =
      cookies.includes("guestpost.session_token") ||
      cookies.includes("guestpost-session_token")
    if (!hasSessionCookie) {
      next()
      return
    }

    // Session cookie present on a state-changing request without a Bearer
    // token → the browser auto-attached the cookie cross-origin but the
    // attacker's page cannot read the in-memory Bearer token.
    throw new ForbiddenException("CSRF validation failed")
  }
}
