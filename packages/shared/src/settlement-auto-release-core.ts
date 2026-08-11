// Phase 6 — Settlement auto-release sweep.
//
// Finds CUSTOMER_APPROVED settlements with releasePolicy = AUTO and
// enableAutoRelease = true, then releases them in per-row transactions:
//   - Lock and re-evaluate the canonical settlement eligibility gate
//   - Upsert ADMIN SettlementApproval
//   - Status CUSTOMER_APPROVED → RELEASED
//   - Exact-cent publisher balance update with debt netting
//   - Order status → COMPLETED
//   - SETTLEMENT_RELEASE + DEBT_REPAYMENT transactions
//   - OrderEvent + auditLog
//
// Pure function: takes a Prisma-compatible client and returns counters.
// No NestJS — writes auditLog rows directly via prisma.

import { orderEventMetadata } from "./audit/order-event-metadata"
import { evaluateLockedSettlementEligibility } from "./settlement-gating"
import { runSettlementSerializableTransaction } from "./settlement-transaction"
import { WorkflowDecisionService } from "./workflow/decision-service"
import { loadSettlementCustomerHistory } from "./workflow/settlement-risk"

export interface RunSettlementAutoReleaseOptions {
  batchSize?: number
  now?: Date
  onError?: (err: unknown, settlementId: string) => void
  /** Invoked after commit for durable communication rows created by gating. */
  onCommunicationEvents?: (eventIds: string[]) => void | Promise<void>
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
  freshnessBlocked: number
  riskBlocked: number
  durationMs: number
}

// The link-monitor sweep runs every six hours. Auto-release tolerates one
// missed sweep, but never releases against evidence older than twelve hours.
// Keep this fixed and mirrored by the PostgreSQL release trigger; making the
// money boundary runtime-configurable would let a bad deployment silently
// weaken it.
export const AUTO_RELEASE_RECHECK_MAX_AGE_MS = 12 * 60 * 60 * 1000

interface AutoReleaseRecheckEvidence {
  checkedAt: Date | string
  createdAt: Date | string
  httpStatus: number
  linkFound: boolean
  targetUrlMatched: boolean
  anchorFound: boolean
}

export function isFreshSuccessfulAutoReleaseEvidence(
  evidence: AutoReleaseRecheckEvidence | null | undefined,
  releaseAt: Date,
): boolean {
  if (!evidence) return false

  const checkedAtMs = new Date(evidence.checkedAt).getTime()
  const createdAtMs = new Date(evidence.createdAt).getTime()
  const releaseAtMs = releaseAt.getTime()
  if (
    !Number.isFinite(checkedAtMs) ||
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(releaseAtMs)
  ) {
    return false
  }

  // Future-dated observations or rows committed after the claimed release
  // time are not valid evidence. The inclusive lower bound makes an exact
  // twelve-hour-old check valid and anything older fail closed.
  if (
    checkedAtMs > releaseAtMs ||
    createdAtMs > releaseAtMs ||
    releaseAtMs - checkedAtMs > AUTO_RELEASE_RECHECK_MAX_AGE_MS
  ) {
    return false
  }

  return (
    [200, 301, 302].includes(evidence.httpStatus) &&
    evidence.linkFound === true &&
    evidence.targetUrlMatched === true &&
    evidence.anchorFound === true
  )
}

type AutoReleasePrisma = any
type AutoReleaseTx = any

class SettlementAutoReleaseRaceError extends Error {
  readonly name = "SettlementAutoReleaseRaceError"
}

function requireUsd(value: unknown, label: string): void {
  if (value !== "USD") {
    throw new Error(`${label} currency must be exactly USD`)
  }
}

function exactUsdCents(value: unknown, label: string): bigint {
  const raw =
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : value &&
          typeof (value as { toString?: unknown }).toString === "function"
        ? String(value)
        : ""
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(raw)
  if (!match) throw new Error(`${label} is not an exact two-decimal amount`)
  const cents =
    BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"))
  return match[1] === "-" ? -cents : cents
}

function usdAmount(cents: bigint): string {
  const negative = cents < 0n
  const absolute = negative ? -cents : cents
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n)
    .toString()
    .padStart(2, "0")}`
}

export async function runSettlementAutoRelease(
  prisma: AutoReleasePrisma,
  opts: RunSettlementAutoReleaseOptions = {},
): Promise<SettlementAutoReleaseResult> {
  const startedAt = Date.now()
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
  let freshnessBlocked = 0
  let riskBlocked = 0

  for (const settlement of eligible) {
    try {
      const committed = await runSettlementSerializableTransaction(
        prisma,
        async (tx: AutoReleaseTx) => {
          // Eligibility is a live decision, not a property of releasePolicy. Lock
          // the order and every blocker before the first approval or money write.
          const eligibility = await evaluateLockedSettlementEligibility(
            tx,
            settlement.orderId,
          )
          if (!eligibility.eligible) {
            return {
              kind: "eligibility_blocked" as const,
              communicationEventIds: eligibility.urlReuseCommunicationEventId
                ? [eligibility.urlReuseCommunicationEventId]
                : [],
            }
          }

          await tx.$queryRaw`SELECT "id" FROM "Settlement" WHERE "id" = ${settlement.id} FOR UPDATE`
          const fresh = await tx.settlement.findUnique({
            where: { id: settlement.id },
          })
          if (
            fresh?.status !== "CUSTOMER_APPROVED" ||
            fresh.releasePolicy !== "AUTO"
          )
            return false

          // releasePolicy is an immutable creation-time snapshot. Re-run the
          // dynamic risk evidence under the same locked transaction so a
          // later chargeback or publisher-tier downgrade cannot ride an old
          // AUTO classification into a money movement. The row stays
          // CUSTOMER_APPROVED for explicit Finance review.
          const currentOrder = await tx.order.findUnique({
            where: { id: settlement.orderId },
            select: {
              organizationId: true,
              customerId: true,
              verifyMethod: true,
              amount: true,
            },
          })
          if (!currentOrder) return "risk_blocked" as const
          const [publisher, customerHistory] = await Promise.all([
            tx.publisher.findUnique({
              where: { id: settlement.publisherId },
              select: { tier: true },
            }),
            loadSettlementCustomerHistory(tx, {
              organizationId: currentOrder.organizationId,
              customerId: currentOrder.customerId,
            }),
          ])
          const currentRiskPolicy = decision.computeSettlementReleasePolicy(
            {
              verifyMethod: currentOrder.verifyMethod,
              amount: Number(currentOrder.amount),
            },
            publisher,
            [],
            customerHistory,
          )
          if (currentRiskPolicy !== "AUTO") return "risk_blocked" as const

          const releaseAt = opts.now ?? new Date()
          const latestEvidence =
            await tx.deliveryVerificationEvidence.findFirst({
              where: {
                deliveryVersionId: eligibility.snapshot.activeDeliveryVersionId,
              },
              // checkedAt is the observation time. A future-dated newest row
              // is deliberately selected and rejected instead of allowing an
              // older successful row to authorize release.
              orderBy: [
                { checkedAt: "desc" },
                { createdAt: "desc" },
                { id: "desc" },
              ],
              select: {
                checkedAt: true,
                createdAt: true,
                httpStatus: true,
                linkFound: true,
                targetUrlMatched: true,
                anchorFound: true,
              },
            })
          if (
            !isFreshSuccessfulAutoReleaseEvidence(latestEvidence, releaseAt)
          ) {
            return "freshness_blocked" as const
          }
          requireUsd(eligibility.snapshot.orderCurrency, "Order")
          requireUsd(fresh.currency, "Settlement")

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
              version: fresh.version,
            },
            data: {
              status: "RELEASED",
              currency: "USD",
              settledAt: releaseAt,
              version: { increment: 1 },
            },
          })
          if (updated.count === 0) throw new SettlementAutoReleaseRaceError()

          // Claim the exact order version proven eligible while its row lock is
          // held. A conflict must abort the transaction, never commit a partial
          // settlement/balance transition.
          const orderUpdate = await tx.order.updateMany({
            where: {
              id: settlement.orderId,
              version: eligibility.snapshot.orderVersion,
              status: "DELIVERED",
              currency: "USD",
              paymentStatus: "PAID",
            },
            data: {
              status: "COMPLETED",
              version: { increment: 1 },
            },
          })
          if (orderUpdate.count === 0)
            throw new SettlementAutoReleaseRaceError()

          const [balanceRow] = await tx.$queryRaw<
            any[]
          >`SELECT * FROM "PublisherBalance" WHERE "publisherId" = ${settlement.publisherId} FOR UPDATE`
          const balance = balanceRow ?? null
          if (balance) requireUsd(balance.currency, "Publisher balance")
          const publisherAmount = exactUsdCents(
            fresh.publisherAmount,
            "Settlement publisher amount",
          )
          if (publisherAmount <= 0n) {
            throw new Error("Settlement publisher amount must be positive")
          }
          const debt = exactUsdCents(
            balance?.debtBalance ?? 0,
            "Publisher debt balance",
          )
          if (debt < 0n) {
            throw new Error("Publisher debt balance cannot be negative")
          }
          const debtApplied = debt < publisherAmount ? debt : publisherAmount
          const credited = publisherAmount - debtApplied
          const publisherAmountText = usdAmount(publisherAmount)
          const debtAppliedText = usdAmount(debtApplied)
          const creditedText = usdAmount(credited)

          if (balance) {
            const balUpdated = await tx.publisherBalance.updateMany({
              where: {
                publisherId: settlement.publisherId,
                version: balance.version,
              },
              data: {
                currency: "USD",
                withdrawableBalance: { increment: creditedText },
                debtBalance: { decrement: debtAppliedText },
                lifetimeEarnings: { increment: publisherAmountText },
                version: { increment: 1 },
              },
            })
            if (balUpdated.count === 0)
              throw new SettlementAutoReleaseRaceError()

            const [freshBal] = await tx.$queryRaw<
              any[]
            >`SELECT * FROM "PublisherBalance" WHERE "publisherId" = ${settlement.publisherId}`
            if (freshBal) {
              const withdrawable = exactUsdCents(
                freshBal.withdrawableBalance ?? 0,
                "Publisher withdrawable balance",
              )
              const freshDebt = exactUsdCents(
                freshBal.debtBalance ?? 0,
                "Publisher debt balance",
              )
              if (withdrawable < 0n || freshDebt < 0n) {
                throw new Error(
                  `Balance invariant violation: withdrawable=${usdAmount(withdrawable)} debt=${usdAmount(freshDebt)} for publisher ${settlement.publisherId}`,
                )
              }
            }
          } else {
            await tx.publisherBalance.create({
              data: {
                publisherId: settlement.publisherId,
                currency: "USD",
                withdrawableBalance: publisherAmountText,
                lifetimeEarnings: publisherAmountText,
              },
            })
          }

          await tx.transaction.create({
            data: {
              amount: publisherAmountText,
              currency: "USD",
              type: "SETTLEMENT_RELEASE",
              orderId: settlement.orderId,
              publisherId: settlement.publisherId,
              settlementId: settlement.id,
              description: `Auto-release of ${publisherAmountText} for order ${settlement.orderId}`,
            },
          })

          if (debtApplied > 0n) {
            await tx.transaction.create({
              data: {
                amount: usdAmount(-debtApplied),
                currency: "USD",
                type: "DEBT_REPAYMENT",
                orderId: settlement.orderId,
                publisherId: settlement.publisherId,
                settlementId: settlement.id,
                description: `Debt repayment of ${debtAppliedText} netted from auto-release`,
              },
            })
          }

          await tx.orderEvent.create({
            data: {
              orderId: settlement.orderId,
              eventType: "SETTLED",
              actorId: null,
              message: `Settlement auto-released — ${publisherAmountText} added to publisher balance`,
              metadata: {
                settlementId: settlement.id,
                publisherAmount: publisherAmountText,
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
                publisherAmount: publisherAmountText,
                debtApplied: debtAppliedText,
              },
              userId: null,
              organizationId: settlement.order.organizationId ?? null,
            },
          })

          return true
        },
      )

      if (
        typeof committed === "object" &&
        committed?.kind === "eligibility_blocked"
      ) {
        try {
          await opts.onCommunicationEvents?.(committed.communicationEventIds)
        } catch {
          // The durable outbox recovery sweep remains authoritative.
        }
        skipped++
      } else if (committed === true) {
        released++
        try {
          opts.onRelease?.({
            publisherId: settlement.publisherId,
            orderId: settlement.orderId,
            id: settlement.id,
          })
        } catch {}
      } else {
        if (committed === "freshness_blocked") freshnessBlocked++
        if (committed === "risk_blocked") riskBlocked++
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
    freshnessBlocked,
    riskBlocked,
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
