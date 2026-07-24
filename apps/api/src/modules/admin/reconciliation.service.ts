import { runReconciliation } from "@guestpost/shared"
import { Injectable } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"

/**
 * Financial drift detector. The check logic lives in
 * @guestpost/shared/reconciliation-core so the worker's scheduled sweep and
 * this on-demand endpoint can never disagree about what "drift" means.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async run(userId?: string) {
    const report = await runReconciliation(this.prisma)
    const moduleKeys = [
      "walletDrift",
      "publisherDrift",
      "settlementDrift",
      "orderPaymentRecon",
      "refundRecon",
      "stuckFinancialOrders",
      "stuckPayouts",
    ] as const
    const issueCodes = [
      ...new Set(
        moduleKeys.flatMap((key) => report[key].map((finding) => finding.code)),
      ),
    ]
    await this.audit.log({
      action: "FINANCIAL_RECONCILIATION_RUN",
      entityType: "FinancialReconciliation",
      metadata: {
        version: report.version,
        ranAt: report.ranAt,
        scanDurationMs: report.scanDurationMs,
        summary: report.summary,
        issueCodes,
      },
      userId: userId ?? null,
      organizationId: null,
    })
    return report
  }

  history(take = 20) {
    return this.prisma.auditLog.findMany({
      where: {
        action: "FINANCIAL_RECONCILIATION_RUN",
        entityType: "FinancialReconciliation",
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(take, 1), 100),
      select: {
        id: true,
        metadata: true,
        userId: true,
        createdAt: true,
      },
    })
  }
}
