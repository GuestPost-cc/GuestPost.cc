import { Injectable, Logger } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name)

  constructor(private readonly prisma: PrismaService) {}

  async log(params: {
    action: string
    entityType: string
    entityId?: string
    metadata?: Record<string, unknown>
    userId: string
    organizationId: string
    ipAddress?: string
    userAgent?: string
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: params.action,
          entityType: params.entityType,
          entityId: params.entityId ?? null,
          metadata: (params.metadata ?? undefined) as any,
          userId: params.userId,
          organizationId: params.organizationId,
          ipAddress: params.ipAddress ?? null,
          userAgent: params.userAgent ?? null,
        },
      })
    } catch (err) {
      this.logger.warn(`Audit log failed for ${params.action}: ${err}`)
    }
  }
}
