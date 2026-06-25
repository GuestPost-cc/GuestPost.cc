// Phase 7.0 — X-Request-ID middleware.
//
// Mounted globally before all routes. Per request:
//   1. Read incoming X-Request-ID header
//   2. Validate against allowlist regex (UUIDv4 / UUIDv7 / ULIDs / short
//      trusted IDs of 1-128 ASCII alphanumerics + `_`/`-`)
//   3. On invalid: silently replace with a fresh UUID via crypto.randomUUID().
//      A malformed header NEVER fails an otherwise-good request.
//   4. On absent: generate fresh
//   5. Echo final value in response header
//   6. Wrap the rest of the request in runWithRequestId() so service-layer
//      code, audit log writes, and worker enqueue can pull the ID from
//      AsyncLocalStorage without per-callsite plumbing.
//
// The regex rejects:
//   - empty strings
//   - control characters (e.g. \x00, \x07)
//   - newlines (the classic log-poisoning vector — `x\n[SENTRY] release=fake`)
//   - non-ASCII (Unicode → ambiguous in log lines)
//   - anything over 128 chars

// Deep import: request-context uses node:async_hooks and must not be in the
// shared package's browser-safe barrel.
import {
  generateRequestId,
  isValidRequestId,
  runWithRequestId,
} from "@guestpost/shared/dist/observability/request-context"
import { Injectable, type NestMiddleware } from "@nestjs/common"
import type { NextFunction, Request, Response } from "express"

const HEADER_NAME = "x-request-id"

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[HEADER_NAME]
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming

    const requestId = isValidRequestId(candidate)
      ? candidate
      : generateRequestId()

    // Echo in response header so the client can include it in error reports / toasts.
    res.setHeader("X-Request-ID", requestId)

    // Surface on the request object for legacy code that reads from `req` directly.
    ;(req as Request & { requestId?: string }).requestId = requestId

    // Establish AsyncLocalStorage frame for the rest of the request.
    runWithRequestId(requestId, () => {
      next()
    })
  }
}
