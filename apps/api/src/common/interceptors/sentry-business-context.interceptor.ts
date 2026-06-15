// Phase 7.0 — populates Sentry scope with business-context tags on every request.
//
// Runs as a global NestJS interceptor. Before the controller handler executes,
// pulls req.user (populated by AuthGuard) and route params, and tags the active
// Sentry scope so any exception captured during the request — by
// SentryExceptionFilter, an unhandledRejection, or an explicit captureException
// in a service — carries identifying context for investigation.
//
// Tags applied (when present):
//   userType, staffRole, customerRole, publisherRole,
//   organizationId, publisherId,
//   orderId, ticketId, settlementId (from route params)
//
// Also tags requestId from the AsyncLocalStorage frame established by
// RequestIdMiddleware.

import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from "@nestjs/common"
import * as Sentry from "@sentry/node"
import { Observable } from "rxjs"
import { setBusinessContext, getRequestId, type BusinessContext } from "@guestpost/shared"

interface ReqWithUser {
  user?: {
    userType?: string
    staffRole?: string | null
    customerRole?: string | null
    publisherRole?: string | null
    organizationId?: string | null
    publisherId?: string | null
  }
  params?: Record<string, string | undefined>
}

@Injectable()
export class SentryBusinessContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<ReqWithUser>()
    const scope = Sentry.getCurrentScope()

    const requestId = getRequestId()
    if (requestId) {
      scope.setTag("requestId", requestId)
    }

    const businessCtx: BusinessContext = {
      userType: req.user?.userType,
      staffRole: req.user?.staffRole ?? undefined,
      customerRole: req.user?.customerRole ?? undefined,
      publisherRole: req.user?.publisherRole ?? undefined,
      organizationId: req.user?.organizationId ?? undefined,
      publisherId: req.user?.publisherId ?? undefined,
      orderId: req.params?.orderId ?? req.params?.id ?? undefined,
      ticketId: req.params?.ticketId,
      settlementId: req.params?.settlementId,
    }
    setBusinessContext(scope, businessCtx)

    return next.handle()
  }
}
