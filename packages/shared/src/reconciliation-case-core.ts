import { createHash } from "node:crypto"
import type { DriftRow, ReconciliationReport } from "./reconciliation-core"

type CaseFinding = {
  orderId: string
  code: string
  entityId: string
  entityType: string
  severity: string
  amount?: string
  metadata: Record<string, string | number | boolean>
}

const REPORT_MODULES = [
  "walletDrift",
  "publisherDrift",
  "settlementDrift",
  "orderPaymentRecon",
  "refundRecon",
  "stuckFinancialOrders",
  "stuckPayouts",
] as const

const METADATA_KEYS = [
  "expectedAmount",
  "actualAmount",
  "expectedStatus",
  "actualStatus",
  "duplicateCount",
  "transactionId",
  "settlementId",
  "publisherCompensationId",
  "orderId",
  "publisherId",
  "walletId",
  "publicReference",
  "payoutExecutionId",
  "paymentDisputeId",
  "depositAttemptId",
  "depositTransactionId",
] as const

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function orderIdFor(row: DriftRow): string | null {
  if (row.action?.type === "order" && row.action.id) return row.action.id
  const value = row.metadata?.orderId
  return typeof value === "string" && value.length > 0 ? value : null
}

function safeMetadata(
  row: DriftRow,
): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = {}
  for (const key of METADATA_KEYS) {
    const value = row.metadata?.[key]
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      metadata[key] = value
    }
  }
  return metadata
}

/**
 * Converts detector output into one safe, deterministic evidence set per
 * Order. It intentionally excludes free-form messages and provider payloads.
 */
export function groupReconciliationOrderFindings(
  report: ReconciliationReport,
): Map<string, CaseFinding[]> {
  const grouped = new Map<string, CaseFinding[]>()
  for (const module of REPORT_MODULES) {
    for (const row of report[module]) {
      const orderId = orderIdFor(row)
      if (!orderId) continue
      const finding: CaseFinding = {
        orderId,
        code: row.code,
        entityId: row.entityId,
        entityType: row.entityType,
        severity: row.severity,
        ...(row.amount === undefined ? {} : { amount: row.amount }),
        metadata: safeMetadata(row),
      }
      const current = grouped.get(orderId) ?? []
      current.push(finding)
      grouped.set(orderId, current)
    }
  }
  for (const findings of grouped.values()) {
    findings.sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    )
  }
  return grouped
}

/**
 * Writes the immutable scan and case snapshots after the canonical shared
 * detector runs. Callers supply either the API or worker Prisma client, which
 * guarantees that both paths create identical cases.
 */
export async function persistReconciliationCases(
  prisma: any,
  report: ReconciliationReport,
  input: { detector: "admin" | "worker"; initiatedById?: string | null },
) {
  const grouped = groupReconciliationOrderFindings(report)
  const ranAt = new Date(report.ranAt)
  if (Number.isNaN(ranAt.getTime())) {
    throw new Error("Reconciliation report has an invalid timestamp")
  }

  return prisma.$transaction(async (tx: any) => {
    const scan = await tx.reconciliationScan.create({
      data: {
        reportVersion: report.version,
        detector: input.detector,
        ranAt,
        report,
        initiatedById: input.initiatedById ?? null,
      },
      select: { id: true },
    })

    const cases: Array<{ id: string; orderId: string; fingerprint: string }> =
      []
    for (const [orderId, findings] of grouped) {
      const evidenceFingerprint = fingerprint({ orderId, findings })
      const caseRow = await tx.reconciliationCase.upsert({
        where: {
          aggregateType_aggregateId: {
            aggregateType: "Order",
            aggregateId: orderId,
          },
        },
        create: {
          aggregateType: "Order",
          aggregateId: orderId,
          orderId,
          currentFingerprint: evidenceFingerprint,
          detectedAt: ranAt,
          lastDetectedAt: ranAt,
        },
        update: {
          currentFingerprint: evidenceFingerprint,
          lastDetectedAt: ranAt,
          version: { increment: 1 },
        },
        select: { id: true },
      })
      await tx.reconciliationCaseSnapshot.create({
        data: {
          caseId: caseRow.id,
          scanId: scan.id,
          evidenceFingerprint,
          findingCodes: [
            ...new Set(findings.map((finding) => finding.code)),
          ].sort(),
          findings,
        },
      })
      cases.push({ id: caseRow.id, orderId, fingerprint: evidenceFingerprint })
    }
    return { scanId: scan.id, cases }
  })
}
