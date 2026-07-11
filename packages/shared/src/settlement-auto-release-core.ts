// Phase 6 — Settlement auto-release sweep.
//
// Finds CUSTOMER_APPROVED settlements with releasePolicy = AUTO and
// enableAutoRelease = true, then releases them in per-row transactions:
//   - Upsert ADMIN SettlementApproval
//   - Status CUSTOMER_APPROVED → RELEASED
//   - Publisher balance update with debt netting
//   - Order status → COMPLETED
//   - SETTLEMENT_RELEASE + DEBT_REPAYMENT transactions
//   - OrderEvent + auditLog
//
// Pure function: takes a Prisma-compatible client and returns counters.
// No NestJS — writes auditLog rows directly via prisma.

import { orderEventMetadata } from "./audit/order-event-metadata"
import { WorkflowDecisionService } from "./workflow/decision-service"

export interface RunSettlementAutoReleaseOptions {
  batchSize?: number
  now?: Date
  onError?: (err: unknown, settlementId: string) => void
  /**
   * Optional hook invoked after a successful per-row release transaction.
   * Used for fire-and-forget side effects (e.g. enqueuing a publisher
   * trust recompute). Runs outside the atomic transaction.
   */
  onRelease?: (settlement: {
    publisherId: string
    orderId: string
    id: string
  }) => void
}

export interface SettlementAutoReleaseResult {
  scanned: number
  released: number
  skipped: number
  durationMs: number
}

type AutoReleasePrisma = any
type AutoReleaseTx = any

export async function runSettlementAutoRelease(
  prisma: AutoReleasePrisma,
  opts: RunSettlementAutoReleaseOptions = {},
): Promise<SettlementAutoReleaseResult> {
  const startedAt = Date.now()
  const now = opts.now ?? new Date()
  const batchSize = opts.batchSize ?? 100

  const decision = new WorkflowDecisionService()

  const due = await prisma.settlement.findMany({
    where: {
      status: "CUSTOMER_APPROVED",
      releasePolicy: "AUTO",
    },
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
          version: true,
        },
      },
    },
    take: batchSize,
  })

  const eligible = due.filter((s: any) =>
    decision.computeAutoReleaseEligibility(s),
  )

  let released = 0
  let skipped = 0

  for (const settlement of eligible) {
    try {
      const committed = await prisma.$transaction(async (tx: AutoReleaseTx) => {
        const fresh = await tx.settlement.findUnique({
          where: { id: settlement.id },
        })
        if (fresh?.status !== "CUSTOMER_APPROVED") return false

        await tx.settlementApproval.upsert({
          where: {
            settlementId_type: {
              settlementId: settlement.id,
              type: "ADMIN",
            },
          },
          create: {
            settlementId: settlement.id,
            type: "ADMIN",
            approvedBy: "SYSTEM_AUTO_RELEASE",
            roleAtTime: "SYSTEM",
          },
          update: {},
        })

        const updated = await tx.settlement.updateMany({
          where: {
            id: settlement.id,
            status: "CUSTOMER_APPROVED",
            version: settlement.version,
          },
          data: {
            status: "RELEASED",
            settledAt: now,
            version: { increment: 1 },
          },
        })
        if (updated.count === 0) return false

        const [balanceRow] = await tx.$queryRaw<
          any[]
        >`SELECT * FROM "PublisherBalance" WHERE "publisherId" = ${settlement.publisherId} FOR UPDATE`
        const balance = balanceRow ?? null
        const publisherAmount = Number(settlement.publisherAmount)
        const debt = Number(balance?.debtBalance ?? 0)
        const debtApplied = Math.min(debt, publisherAmount)
        const credited = publisherAmount - debtApplied

        if (balance) {
          const balUpdated = await tx.publisherBalance.updateMany({
            where: {
              publisherId: settlement.publisherId,
              version: balance.version,
            },
            data: {
              withdrawableBalance: { increment: credited },
              debtBalance: { decrement: debtApplied },
              lifetimeEarnings: { increment: publisherAmount },
              version: { increment: 1 },
            },
          })
          if (balUpdated.count === 0) return false

          const [freshBal] = await tx.$queryRaw<
            any[]
          >`SELECT * FROM "PublisherBalance" WHERE "publisherId" = ${settlement.publisherId}`
          if (freshBal) {
            const w = Number(freshBal.withdrawableBalance ?? 0)
            const d = Number(freshBal.debtBalance ?? 0)
            if (w < 0 || d < 0) {
              opts.onError?.(
                new Error(
                  `Balance invariant violation: withdrawable=${w} debt=${d} for publisher ${settlement.publisherId}`,
                ),
                settlement.id,
              )
            }
          }
        } else {
          await tx.publisherBalance.create({
            data: {
              publisherId: settlement.publisherId,
              withdrawableBalance: publisherAmount,
              lifetimeEarnings: publisherAmount,
            },
          })
        }

        const orderUpdate = await tx.order.updateMany({
          where: {
            id: settlement.orderId,
            version: settlement.order.version,
            status: { notIn: ["CANCELLED", "REFUNDED", "DISPUTED"] },
          },
          data: {
            status: "COMPLETED",
            version: { increment: 1 },
          },
        })
        if (orderUpdate.count === 0) return false

        await tx.transaction.create({
          data: {
            amount: publisherAmount,
            type: "SETTLEMENT_RELEASE",
            orderId: settlement.orderId,
            publisherId: settlement.publisherId,
            settlementId: settlement.id,
            description: `Auto-release of ${publisherAmount.toFixed(2)} for order ${settlement.orderId}`,
          },
        })

        if (debtApplied > 0) {
          await tx.transaction.create({
            data: {
              amount: -debtApplied,
              type: "DEBT_REPAYMENT",
              orderId: settlement.orderId,
              publisherId: settlement.publisherId,
              settlementId: settlement.id,
              description: `Debt repayment of ${debtApplied.toFixed(2)} netted from auto-release`,
            },
          })
        }

        await tx.orderEvent.create({
          data: {
            orderId: settlement.orderId,
            eventType: "SETTLED",
            actorId: null,
            message: `Settlement auto-released — ${publisherAmount.toFixed(2)} added to publisher balance`,
            metadata: {
              settlementId: settlement.id,
              publisherAmount,
              auto: true,
            },
          },
        })

        await tx.auditLog.create({
          data: {
            action: "SETTLEMENT_AUTO_RELEASED",
            entityType: "Settlement",
            entityId: settlement.id,
            metadata: {
              ...orderEventMetadata(settlement.order),
              orderId: settlement.orderId,
              publisherAmount,
              debtApplied,
            },
            userId: null,
            organizationId: settlement.order.organizationId ?? null,
          },
        })

        return true
      })

      if (committed) {
        released++
        try {
          opts.onRelease?.({
            publisherId: settlement.publisherId,
            orderId: settlement.orderId,
            id: settlement.id,
          })
        } catch {}
      } else {
        skipped++
      }
    } catch (err) {
      try {
        opts.onError?.(err, settlement.id)
      } catch {}
      skipped++
    }
  }

  return {
    scanned: due.length,
    released,
    skipped,
    durationMs: Date.now() - startedAt,
  }
}

export async function countStaleReleaseSettlements(
  prisma: AutoReleasePrisma,
  opts: { now?: Date; staleThresholdHours?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date()
  const thresholdHours = opts.staleThresholdHours ?? 24
  const staleCutoff = new Date(now.getTime() - thresholdHours * 60 * 60 * 1000)

  return prisma.settlement.count({
    where: {
      status: { in: ["CUSTOMER_APPROVED", "ADMIN_APPROVED"] },
      releasePolicy: "AUTO",
      settledAt: null,
      updatedAt: { lt: staleCutoff },
    },
  })
}
