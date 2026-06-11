import { Injectable } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { Decimal } from "@prisma/client/runtime/library"

/**
 * Financial drift detector. Until a full double-entry ledger exists, this is
 * the proof that cached balances still agree with the transaction history:
 *
 *  1. Wallets: availableBalance + reservedBalance must equal the sum of all
 *     wallet transactions except RESERVATION (a reservation moves money
 *     between the two buckets of the SAME wallet, so it nets to zero in the
 *     combined balance but its row is single-signed).
 *  2. Publisher balances: withdrawableBalance must equal the sum of
 *     SETTLEMENT_RELEASE + DEBT_REPAYMENT + SETTLEMENT_CLAWBACK +
 *     WITHDRAWAL + WITHDRAWAL_REVERSAL rows for the publisher.
 *     NOTE: withdrawals created before the ledger-row change have no
 *     WITHDRAWAL transaction — legacy drift equals their summed amounts.
 *  3. Stuck orders: DELIVERED orders with neither an active settlement nor
 *     an unreversed PlatformRevenue row (the auto-settlement step failed and
 *     nothing retries it).
 *
 * All checks use set-based grouped queries — a fixed number of round trips
 * regardless of row counts, so this stays runnable on demand as data grows.
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async run() {
    const [wallets, publishers, stuckOrders, stuckPayouts] = await Promise.all([
      this.checkWallets(),
      this.checkPublisherBalances(),
      this.checkStuckOrders(),
      this.checkStuckPayouts(),
    ])
    return {
      ranAt: new Date().toISOString(),
      ok: wallets.length === 0 && publishers.length === 0 && stuckOrders.length === 0 && stuckPayouts.length === 0,
      walletDrift: wallets,
      publisherDrift: publishers,
      stuckOrders,
      stuckPayouts,
    }
  }

  private async checkWallets() {
    const [wallets, sums] = await Promise.all([
      this.prisma.wallet.findMany({
        select: { id: true, organizationId: true, availableBalance: true, reservedBalance: true },
      }),
      this.prisma.transaction.groupBy({
        by: ["walletId", "type"],
        where: { walletId: { not: null } },
        _sum: { amount: true },
      }),
    ])

    const expectedByWallet = new Map<string, Decimal>()
    for (const s of sums) {
      if (s.type === "RESERVATION" || !s.walletId) continue
      const current = expectedByWallet.get(s.walletId) ?? new Decimal(0)
      expectedByWallet.set(s.walletId, current.plus(s._sum.amount ?? 0))
    }

    const drift: any[] = []
    for (const w of wallets) {
      const expected = expectedByWallet.get(w.id) ?? new Decimal(0)
      const actual = new Decimal(w.availableBalance).plus(w.reservedBalance)
      if (!actual.equals(expected)) {
        drift.push({
          walletId: w.id,
          organizationId: w.organizationId,
          actual: actual.toFixed(2),
          expected: expected.toFixed(2),
          delta: actual.minus(expected).toFixed(2),
        })
      }
    }
    return drift
  }

  private async checkPublisherBalances() {
    const LEDGER_TYPES = [
      "SETTLEMENT_RELEASE",
      "DEBT_REPAYMENT",
      "SETTLEMENT_CLAWBACK",
      "WITHDRAWAL",
      "WITHDRAWAL_REVERSAL",
    ]
    const [balances, sums] = await Promise.all([
      this.prisma.publisherBalance.findMany({
        select: { publisherId: true, withdrawableBalance: true, debtBalance: true },
      }),
      this.prisma.transaction.groupBy({
        by: ["publisherId"],
        where: { publisherId: { not: null }, type: { in: LEDGER_TYPES as any } },
        _sum: { amount: true },
      }),
    ])

    const expectedByPublisher = new Map<string, Decimal>()
    for (const s of sums) {
      if (s.publisherId) expectedByPublisher.set(s.publisherId, new Decimal(s._sum.amount ?? 0))
    }

    const drift: any[] = []
    for (const b of balances) {
      const expected = expectedByPublisher.get(b.publisherId) ?? new Decimal(0)
      const actual = new Decimal(b.withdrawableBalance)
      if (!actual.equals(expected)) {
        drift.push({
          publisherId: b.publisherId,
          actual: actual.toFixed(2),
          expected: expected.toFixed(2),
          delta: actual.minus(expected).toFixed(2),
          debtBalance: new Decimal(b.debtBalance).toFixed(2),
        })
      }
    }
    return drift
  }

  private async checkStuckPayouts() {
    const stuck: any[] = []
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)

    // Withdrawals stuck in PROCESSING for > 1 hour with no recent execution
    const staleProcessing = await this.prisma.withdrawal.findMany({
      where: { status: "PROCESSING", updatedAt: { lt: oneHourAgo } },
      select: { id: true, publisherId: true, amount: true, updatedAt: true },
    })
    if (staleProcessing.length > 0) {
      const recentExecGroups = await this.prisma.payoutExecution.groupBy({
        by: ["withdrawalId"],
        where: {
          withdrawalId: { in: staleProcessing.map((w) => w.id) },
          createdAt: { gt: oneHourAgo },
        },
        _count: true,
      })
      const hasRecentExecution = new Set(recentExecGroups.map((g) => g.withdrawalId))
      for (const w of staleProcessing) {
        if (!hasRecentExecution.has(w.id)) {
          stuck.push({
            withdrawalId: w.id,
            publisherId: w.publisherId,
            amount: w.amount.toFixed(2),
            problem: "PROCESSING for >1h with no recent payout execution",
          })
        }
      }
    }

    // PayoutExecutions stuck in PROCESSING for > 2 hours
    const staleExecutions = await this.prisma.payoutExecution.findMany({
      where: { status: "PROCESSING", updatedAt: { lt: twoHoursAgo } },
      select: { id: true, withdrawalId: true, providerExecutionId: true, updatedAt: true },
    })
    for (const e of staleExecutions) {
      stuck.push({
        executionId: e.id,
        withdrawalId: e.withdrawalId,
        providerExecutionId: e.providerExecutionId,
        problem: "PROCESSING for >2h — manual intervention required",
      })
    }

    // One grouped pass over executions answers three questions: which
    // withdrawals have a FAILED execution, which have a COMPLETED one, and
    // which have more than one COMPLETED (double-payout signal).
    const execGroups = await this.prisma.payoutExecution.groupBy({
      by: ["withdrawalId", "status"],
      where: { status: { in: ["FAILED", "COMPLETED"] } },
      _count: true,
    })
    const hasFailedExec = new Set<string>()
    const hasCompletedExec = new Set<string>()
    const duplicateCompleted = new Map<string, number>()
    for (const g of execGroups) {
      if (g.status === "FAILED") hasFailedExec.add(g.withdrawalId)
      if (g.status === "COMPLETED") {
        hasCompletedExec.add(g.withdrawalId)
        if (g._count > 1) duplicateCompleted.set(g.withdrawalId, g._count)
      }
    }

    // Withdrawals marked FAILED with no failed execution record
    const failedWithdrawals = await this.prisma.withdrawal.findMany({
      where: { status: "FAILED" },
      select: { id: true, publisherId: true, amount: true },
    })
    for (const w of failedWithdrawals) {
      if (!hasFailedExec.has(w.id)) {
        stuck.push({
          withdrawalId: w.id,
          publisherId: w.publisherId,
          amount: w.amount.toFixed(2),
          problem: "FAILED status with no failed PayoutExecution record",
        })
      }
    }

    // Duplicate COMPLETED executions for same withdrawal
    if (duplicateCompleted.size > 0) {
      const dupWithdrawals = await this.prisma.withdrawal.findMany({
        where: { id: { in: [...duplicateCompleted.keys()] } },
        select: { id: true, publisherId: true, amount: true },
      })
      const byId = new Map(dupWithdrawals.map((w) => [w.id, w]))
      for (const [withdrawalId, count] of duplicateCompleted) {
        const withdrawal = byId.get(withdrawalId)
        stuck.push({
          withdrawalId,
          publisherId: withdrawal?.publisherId,
          amount: withdrawal?.amount.toFixed(2),
          problem: `Found ${count} COMPLETED executions for single withdrawal — potential double payout`,
        })
      }
    }

    // lifetimePaid drift: sum of COMPLETED withdrawal amounts vs lifetimePaid
    const [paidBalances, completedSums] = await Promise.all([
      this.prisma.publisherBalance.findMany({
        where: { lifetimePaid: { gt: 0 } },
        select: { publisherId: true, lifetimePaid: true },
      }),
      this.prisma.withdrawal.groupBy({
        by: ["publisherId"],
        where: { status: "COMPLETED" },
        _sum: { amount: true },
      }),
    ])
    const completedByPublisher = new Map(completedSums.map((s) => [s.publisherId, new Decimal(s._sum.amount ?? 0)]))
    for (const b of paidBalances) {
      const expected = completedByPublisher.get(b.publisherId) ?? new Decimal(0)
      const actual = new Decimal(b.lifetimePaid)
      if (!actual.equals(expected)) {
        stuck.push({
          publisherId: b.publisherId,
          lifetimePaid: actual.toFixed(2),
          expectedFromWithdrawals: expected.toFixed(2),
          delta: actual.minus(expected).toFixed(2),
          problem: "lifetimePaid does not match sum of COMPLETED withdrawal amounts",
        })
      }
    }

    // COMPLETED withdrawals with no COMPLETED PayoutExecution
    const completedWithdrawals = await this.prisma.withdrawal.findMany({
      where: { status: "COMPLETED" },
      select: { id: true, publisherId: true, amount: true },
    })
    for (const w of completedWithdrawals) {
      if (!hasCompletedExec.has(w.id)) {
        stuck.push({
          withdrawalId: w.id,
          publisherId: w.publisherId,
          amount: w.amount.toFixed(2),
          problem: "COMPLETED withdrawal has no COMPLETED PayoutExecution record",
        })
      }
    }

    return stuck
  }

  private async checkStuckOrders() {
    const delivered = await this.prisma.order.findMany({
      where: { status: "DELIVERED" },
      select: {
        id: true,
        organizationId: true,
        deliveredAt: true,
        settlements: { where: { status: { not: "CANCELLED" } }, select: { id: true } },
        platformRevenue: { select: { id: true, reversedAt: true } },
      },
    })
    return delivered
      .filter((o) => o.settlements.length === 0 && (!o.platformRevenue || o.platformRevenue.reversedAt !== null))
      .map((o) => ({
        orderId: o.id,
        organizationId: o.organizationId,
        deliveredAt: o.deliveredAt?.toISOString() ?? null,
        problem: "DELIVERED order has no active settlement and no platform revenue",
      }))
  }
}
