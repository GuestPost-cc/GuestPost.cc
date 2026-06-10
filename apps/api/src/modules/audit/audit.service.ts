import { Injectable, Logger } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"

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
    const data = {
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      metadata: (params.metadata ?? undefined) as any,
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
