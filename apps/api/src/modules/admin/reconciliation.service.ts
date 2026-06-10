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
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async run() {
    const [wallets, publishers, stuckOrders] = await Promise.all([
      this.checkWallets(),
      this.checkPublisherBalances(),
      this.checkStuckOrders(),
    ])
    return {
      ranAt: new Date().toISOString(),
      ok: wallets.length === 0 && publishers.length === 0 && stuckOrders.length === 0,
      walletDrift: wallets,
      publisherDrift: publishers,
      stuckOrders,
    }
  }

  private async checkWallets() {
    const wallets = await this.prisma.wallet.findMany({
      select: { id: true, organizationId: true, availableBalance: true, reservedBalance: true },
    })
    const drift: any[] = []
    for (const w of wallets) {
      const sums = await this.prisma.transaction.groupBy({
        by: ["type"],
        where: { walletId: w.id },
        _sum: { amount: true },
      })
      let expected = new Decimal(0)
      for (const s of sums) {
        if (s.type === "RESERVATION") continue
        expected = expected.plus(s._sum.amount ?? 0)
      }
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
    const balances = await this.prisma.publisherBalance.findMany({
      select: { publisherId: true, withdrawableBalance: true, debtBalance: true },
    })
    const LEDGER_TYPES = [
      "SETTLEMENT_RELEASE",
      "DEBT_REPAYMENT",
      "SETTLEMENT_CLAWBACK",
      "WITHDRAWAL",
      "WITHDRAWAL_REVERSAL",
    ]
    const drift: any[] = []
    for (const b of balances) {
      const sum = await this.prisma.transaction.aggregate({
        where: { publisherId: b.publisherId, type: { in: LEDGER_TYPES as any } },
        _sum: { amount: true },
      })
      const expected = new Decimal(sum._sum.amount ?? 0)
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
