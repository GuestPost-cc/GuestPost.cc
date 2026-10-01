import { runReconciliation } from "@guestpost/shared"
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { isStagingSingleActorRepairEnabled } from "./reconciliation-repair.gates"

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
        // On-demand API scans are read-only. The scheduled worker is the
        // only writer of immutable scan/case evidence under the RLS boundary.
        persistedAsEvidence: false,
      },
      userId: userId ?? null,
      organizationId: null,
    })
    return report
  }

  async listCases(input: { take: number; skip: number; status?: string }) {
    const statuses = new Set([
      "DETECTED",
      "NEEDS_EVIDENCE",
      "AWAITING_APPROVAL",
      "APPLIED",
      "VERIFIED",
      "BLOCKED",
    ])
    if (input.status && !statuses.has(input.status)) {
      throw new BadRequestException("Unknown reconciliation case status")
    }
    const where = input.status ? { status: input.status } : {}
    const [cases, total] = await Promise.all([
      (this.prisma as any).reconciliationCase.findMany({
        where,
        orderBy: [{ lastDetectedAt: "desc" }, { id: "desc" }],
        skip: input.skip,
        take: input.take,
        select: {
          id: true,
          orderId: true,
          status: true,
          currentFingerprint: true,
          detectedAt: true,
          lastDetectedAt: true,
          version: true,
          snapshots: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { findingCodes: true, createdAt: true },
          },
        },
      }),
      (this.prisma as any).reconciliationCase.count({ where }),
    ])
    return { cases, total, take: input.take, skip: input.skip }
  }

  async getCase(caseId: string) {
    const caseRow = await (this.prisma as any).reconciliationCase.findUnique({
      where: { id: caseId },
      select: {
        id: true,
        orderId: true,
        status: true,
        currentFingerprint: true,
        detectedAt: true,
        lastDetectedAt: true,
        version: true,
        order: {
          select: {
            id: true,
            amount: true,
            currency: true,
            status: true,
            paymentStatus: true,
            version: true,
          },
        },
        snapshots: {
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            evidenceFingerprint: true,
            findingCodes: true,
            findings: true,
            createdAt: true,
            scan: {
              select: { detector: true, ranAt: true, reportVersion: true },
            },
          },
        },
        repairProposals: {
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            proposalDigest: true,
            amount: true,
            currency: true,
            incidentReference: true,
            providerRefundConfirmedAbsent: true,
            reason: true,
            initiatedByUserId: true,
            expiresAt: true,
            createdAt: true,
            approval: { select: { approvedByUserId: true, createdAt: true } },
            execution: {
              select: {
                id: true,
                reversalTransactionId: true,
                executedByUserId: true,
                createdAt: true,
              },
            },
          },
        },
      },
    })
    if (!caseRow) throw new NotFoundException("Reconciliation case not found")
    const stagingBypassConfigured = isStagingSingleActorRepairEnabled()
    const stagingRoleMembership = stagingBypassConfigured
      ? await this.prisma.$queryRaw<Array<{ enabled: boolean }>>`
          SELECT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_db_role_setting AS setting
            JOIN pg_catalog.pg_roles AS configured_role
              ON configured_role.oid = setting.setrole
            WHERE setting.setdatabase = (
                SELECT database.oid FROM pg_catalog.pg_database AS database
                WHERE database.datname = current_database()
              )
              AND pg_catalog.pg_has_role(
                session_user,
                configured_role.oid,
                'MEMBER'
              )
              AND 'guestpost.financial_repair_single_actor=on' = ANY(setting.setconfig)
          ) AS enabled
        `
      : []
    return {
      ...caseRow,
      makerCheckerRequired:
        !stagingBypassConfigured || stagingRoleMembership[0]?.enabled !== true,
    }
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
