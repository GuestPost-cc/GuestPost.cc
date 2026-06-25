// Deep import: request-context uses node:async_hooks and is not in the
// shared barrel (Next.js client bundles can't tolerate it).
import { getRequestId } from "@guestpost/shared/dist/observability/request-context"
import { Injectable, Logger } from "@nestjs/common"
import type { PrismaService } from "../../common/prisma.service"

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name)

  constructor(private readonly prisma: PrismaService) {}

  // System/webhook/platform-scope actions have no real user or org — pass
  // null, never sentinel strings ("SYSTEM"): those violate the FKs and the
  // row is silently dropped.
  //
  // For financial mutations, pass the surrounding Prisma transaction as `tx`
  // so the audit row commits atomically with the money movement instead of
  // being best-effort.
  //
  // Phase 7.0: requestId is auto-injected from AsyncLocalStorage into the
  // metadata JSON when present (set by RequestIdMiddleware). Worker-side
  // audit writes inherit the same ID after the processor wrapper re-enters
  // the ALS frame from the signed job payload.
  //
  // Phase 7.7 A1: requestId additionally written to the indexed top-level
  // column. The metadata.requestId mirror is kept indefinitely (not
  // transitional) — storage cost is trivial and downstream readers
  // (Sentry exports, ad-hoc scripts) may still parse the JSON.
  async log(
    params: {
      action: string
      entityType: string
      entityId?: string
      metadata?: Record<string, unknown>
      userId?: string | null
      organizationId?: string | null
      ipAddress?: string
      userAgent?: string
    },
    tx?: any,
  ) {
    const requestId = getRequestId()
    const metadata =
      requestId && params.metadata
        ? { ...params.metadata, requestId }
        : requestId
          ? { requestId }
          : params.metadata
    const data = {
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      metadata: (metadata ?? undefined) as any,
      requestId: requestId ?? null,
      userId: params.userId ?? null,
      organizationId: params.organizationId ?? null,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    }

    if (tx) {
      // Inside a transaction the write must NOT be swallowed — a failed
      // audit insert aborts the financial operation with it.
      await tx.auditLog.create({ data })
      return
    }

    try {
      await this.prisma.auditLog.create({ data })
    } catch (err) {
      this.logger.warn(`Audit log failed for ${params.action}: ${err}`)
    }
  }
}
