// Phase 7.0 — Sentry wrapper around AllExceptionsFilter.
//
// Captures unhandled controller / service errors to Sentry while delegating
// response shape to the existing AllExceptionsFilter (one source of truth
// for what the client sees).
//
// Capture policy:
//   - 5xx HttpException → captured (these are bugs)
//   - non-HttpException → captured (uncaught throws, programmer errors)
//   - 4xx HttpException (BadRequest, Unauthorized, Forbidden, NotFound,
//     Conflict, etc.) → NOT captured (these are user errors, not bugs;
//     flooding Sentry with 401s would bury real issues)
//
// When SENTRY_DSN is unset, Sentry.captureException is a safe no-op so this
// filter is dev-mode safe out of the box.

import { Catch, ArgumentsHost, HttpException } from "@nestjs/common"
import * as Sentry from "@sentry/node"
import { AllExceptionsFilter } from "./all-exceptions.filter"

@Catch()
export class SentryExceptionFilter extends AllExceptionsFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (this.shouldCapture(exception)) {
      // captureException is safe to call even when Sentry was not init'd —
      // the SDK silently no-ops. No DSN check needed.
      Sentry.captureException(exception)
    }
    super.catch(exception, host)
  }

  private shouldCapture(exception: unknown): boolean {
    if (!(exception instanceof HttpException)) {
      // Anything that isn't an HttpException is an uncaught throw — always a bug.
      return true
    }
    // HttpException with 5xx status — bug. 4xx → skip.
    return exception.getStatus() >= 500
  }
}
