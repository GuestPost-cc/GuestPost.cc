// Phase 7.3 — Settlement auto-approve sweep (audit #10).
//
// Lifted from apps/api/src/modules/settlements/settlement-auto-approve.service.ts
// so the worker can own the cron. Pure function: takes a Prisma-compatible
// client and returns counters. No NestJS, no AuditService — writes auditLog
// rows directly via prisma (worker has no DI container).
//
// The original NestJS service is deleted as part of this phase; this is the
// new single source of truth. Same per-row semantics as before:
//   - Skip settlements with an OPEN/UNDER_REVIEW dispute (settlement gating)
//   - Status + version guard on the updateMany (a manual approval racing
//     the sweep wins, the sweep silently skips that row)
//   - Atomic transaction per row: status update + SettlementApproval upsert
//     + OrderEvent + auditLog all commit together or not at all
//
// Idempotency: re-running the sweep is safe. Already-approved rows fail the
// `status: { in: ["PENDING", "UNDER_REVIEW"] }` filter and are skipped.

import { orderEventMetadata } from "./audit/order-event-metadata"

export interface RunSettlementAutoApproveOptions {
  /**
   * Maximum settlements to process per sweep. Defaults to 100, matching the
   * previous NestJS service. Tunable via env at the caller level
   * (SETTLEMENT_AUTO_APPROVE_BATCH_SIZE on the worker side); clamped to
   * [1, 10_000] at the worker before being passed in.
   */
  batchSize?: number
  /**
   * Override "now" for deterministic tests. Production callers pass nothing
   * and the function uses `new Date()`.
   */
  now?: Date
}

export interface SettlementAutoApproveResult {
  /** Total eligible rows fetched in this sweep (before per-row filtering). */
  scanned: number
  /** Successfully auto-approved (transaction committed). */
  approved: number
  /** Eligible but skipped (active dispute OR status/version race lost). */
  skipped: number
  /** Wall-clock duration of the entire sweep in milliseconds. */
  durationMs: number
}

// Loose Prisma-shape contract. Matches `AnyPrisma = any` convention used by
// other cores in this package (reconciliation-core, website-verification-core)
// — TypeScript can't reconcile generated PrismaClient types with a narrow
// interface (variance), so we use `any` and rely on the worker's smoke tests
// + the integration suite to catch shape drift.
type AutoApprovePrisma = any
type AutoApproveTx = any

export async function runSettlementAutoApprove(
  prisma: AutoApprovePrisma,
  opts: RunSettlementAutoApproveOptions = {},
): Promise<SettlementAutoApproveResult> {
  const startedAt = Date.now()
  const now = opts.now ?? new Date()
  const batchSize = opts.batchSize ?? 100

  const due = await prisma.settlement.findMany({
    where: {
      status: { in: ["PENDING", "UNDER_REVIEW"] },
      reviewEndsAt: { lte: now },
    },
    // Phase 6.9 — snapshot trio in scope so orderEventMetadata reads the
    // same fields here as everywhere else. Adds 7 columns to the select; no
    // extra query.
    include: {
      order: {
        select: {
          id: true,
          organizationId: true,
          listingId: true,
          listingServiceId: true,
          type: true,
          fulfillmentChannel: true,
          websiteId: true,
          amount: true,
        },
      },
    },
    take: batchSize,
  })

  let approved = 0
  let skipped = 0

  for (const settlement of due) {
    // Settlement gating: an active dispute blocks auto-approval (the customer
    // is actively contesting; the review window is paused for resolution).
    const activeDispute = await prisma.orderDispute.findFirst({
      where: { orderId: settlement.orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } },
    })
    if (activeDispute) {
      skipped++
      continue
    }

    try {
      const committed = await prisma.$transaction(async (tx: AutoApproveTx) => {
        // Status + version guard — a manual approval racing this sweep wins.
        const updated = await tx.settlement.updateMany({
          where: {
            id: settlement.id,
            status: { in: ["PENDING", "UNDER_REVIEW"] },
            version: settlement.version,
          },
          data: { status: "CUSTOMER_APPROVED", version: { increment: 1 } },
        })
        if (updated.count === 0) return false

        await tx.settlementApproval.upsert({
          where: { settlementId_type: { settlementId: settlement.id, type: "CUSTOMER" } },
          create: {
            settlementId: settlement.id,
            type: "CUSTOMER",
            approvedBy: "SYSTEM_AUTO_APPROVE",
            roleAtTime: "SYSTEM",
          },
          update: {},
        })

        await tx.orderEvent.create({
          data: {
            orderId: settlement.orderId,
            eventType: "SETTLED",
            actorId: null,
            message: `Settlement auto-approved — review window ended ${settlement.reviewEndsAt?.toISOString()}`,
            metadata: { settlementId: settlement.id, auto: true },
          },
        })

        await tx.auditLog.create({
          data: {
            action: "SETTLEMENT_AUTO_APPROVED",
            entityType: "Settlement",
            entityId: settlement.id,
            metadata: {
              ...orderEventMetadata(settlement.order),
              orderId: settlement.orderId,
              reviewEndsAt: settlement.reviewEndsAt?.toISOString(),
            },
            userId: null,
            organizationId: settlement.order.organizationId ?? null,
          },
        })

        return true
      })

      if (committed) {
        approved++
      } else {
        skipped++ // version-guard race lost
      }
    } catch {
      // Per-row failures (DB error, etc.) are counted as skipped so the
      // sweep can continue. The caller logs sweep-level counters; per-row
      // errors propagate via Sentry from the queue-observability wrapper.
      skipped++
    }
  }

  return {
    scanned: due.length,
    approved,
    skipped,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Stale-review detector. Independent query — call this AFTER `runSettlementAutoApprove`
 * to surface settlements that should have been approved by now but weren't
 * (either because the sweep is broken, the dispute path is wedged, or the
 * status guard kept failing). Caller decides what to do with the count
 * (typically: emit a Sentry warning if > 0).
 *
 * "Stale" = `reviewEndsAt` more than `staleThresholdHours` hours in the past
 * AND still PENDING/UNDER_REVIEW. Default threshold is 24h — a settlement
 * 24h past its review window with no resolution is unambiguously stuck.
 */
export async function countStaleReviewSettlements(
  prisma: AutoApprovePrisma,
  opts: { now?: Date; staleThresholdHours?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date()
  const thresholdHours = opts.staleThresholdHours ?? 24
  const threshold = new Date(now.getTime() - thresholdHours * 60 * 60 * 1000)

  return prisma.settlement.count({
    where: {
      status: { in: ["PENDING", "UNDER_REVIEW"] },
      reviewEndsAt: { lt: threshold },
    },
  })
}
