// Financial drift detection core — shared by the API's on-demand
// GET /admin/reconciliation endpoint and the worker's scheduled sweep.
// Takes any Prisma client (API's PrismaService or the worker's singleton) so
// the two paths can never diverge on what "drift" means.
//
// Checks:
//  1. Wallets: availableBalance + reservedBalance must equal the sum of all
//     wallet transactions except RESERVATION (a reservation moves money
//     between the two buckets of the SAME wallet, so it nets to zero in the
//     combined balance but its row is single-signed).
//  2. Publisher balances: withdrawableBalance must equal the sum of
//     SETTLEMENT_RELEASE + DEBT_REPAYMENT + SETTLEMENT_CLAWBACK +
//     WITHDRAWAL + WITHDRAWAL_REVERSAL rows for the publisher.
//  3. Stuck orders: DELIVERED orders with neither an active settlement nor
//     an unreversed PlatformRevenue row.
//  4. Stuck payouts: stale PROCESSING, FAILED/COMPLETED withdrawals without
//     matching execution records, duplicate COMPLETED executions,
//     lifetimePaid drift.
//
// All checks use set-based grouped queries — a fixed number of round trips
// regardless of row counts.

type AnyPrisma = any

// Decimal-safe sums without a Decimal dependency: fixed-point BigInt at 12
// fractional digits — far beyond any computed money value here (fee splits
// round at 2dp), so sub-cent drift cannot hide in truncation.
const SCALE = 12
const SCALE_FACTOR = 10n ** BigInt(SCALE)

function toScaled(value: unknown): bigint {
  const s = String(value ?? 0)
  const neg = s.startsWith("-")
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".")
  const scaled =
    BigInt(whole || "0") * SCALE_FACTOR +
    BigInt((frac + "0".repeat(SCALE)).slice(0, SCALE))
  return neg ? -scaled : scaled
}

// Render trimmed (min 2dp) so reports stay readable: 3816.000000000000 -> 3816.00
function fromScaled(scaled: bigint): string {
  const neg = scaled < 0n
  const abs = neg ? -scaled : scaled
  const whole = abs / SCALE_FACTOR
  let frac = (abs % SCALE_FACTOR)
    .toString()
    .padStart(SCALE, "0")
    .replace(/0+$/, "")
  if (frac.length < 2) frac = frac.padEnd(2, "0")
  return `${neg ? "-" : ""}${whole}.${frac}`
}

export interface ReconciliationReport {
  ranAt: string
  ok: boolean
  walletDrift: any[]
  publisherDrift: any[]
  stuckOrders: any[]
  stuckPayouts: any[]
}

async function checkWallets(prisma: AnyPrisma) {
  const [wallets, sums] = await Promise.all([
    prisma.wallet.findMany({
      select: {
        id: true,
        organizationId: true,
        availableBalance: true,
        reservedBalance: true,
      },
    }),
    prisma.transaction.groupBy({
      by: ["walletId", "type"],
      where: { walletId: { not: null } },
      _sum: { amount: true },
    }),
  ])

  const expectedByWallet = new Map<string, bigint>()
  for (const s of sums) {
    if (s.type === "RESERVATION" || !s.walletId) continue
    const current = expectedByWallet.get(s.walletId) ?? 0n
    expectedByWallet.set(s.walletId, current + toScaled(s._sum.amount ?? 0))
  }

  const drift: any[] = []
  for (const w of wallets) {
    const expected = expectedByWallet.get(w.id) ?? 0n
    const actual = toScaled(w.availableBalance) + toScaled(w.reservedBalance)
    if (actual !== expected) {
      drift.push({
        walletId: w.id,
        organizationId: w.organizationId,
        actual: fromScaled(actual),
        expected: fromScaled(expected),
        delta: fromScaled(actual - expected),
      })
    }
  }
  return drift
}

async function checkPublisherBalances(prisma: AnyPrisma) {
  const LEDGER_TYPES = [
    "SETTLEMENT_RELEASE",
    "DEBT_REPAYMENT",
    "SETTLEMENT_CLAWBACK",
    "WITHDRAWAL",
    "WITHDRAWAL_REVERSAL",
  ]
  const [balances, sums] = await Promise.all([
    prisma.publisherBalance.findMany({
      select: {
        publisherId: true,
        withdrawableBalance: true,
        debtBalance: true,
      },
    }),
    prisma.transaction.groupBy({
      by: ["publisherId"],
      where: { publisherId: { not: null }, type: { in: LEDGER_TYPES as any } },
      _sum: { amount: true },
    }),
  ])

  const expectedByPublisher = new Map<string, bigint>()
  for (const s of sums) {
    if (s.publisherId)
      expectedByPublisher.set(s.publisherId, toScaled(s._sum.amount ?? 0))
  }

  const drift: any[] = []
  for (const b of balances) {
    const expected = expectedByPublisher.get(b.publisherId) ?? 0n
    const actual = toScaled(b.withdrawableBalance)
    if (actual !== expected) {
      drift.push({
        publisherId: b.publisherId,
        actual: fromScaled(actual),
        expected: fromScaled(expected),
        delta: fromScaled(actual - expected),
        debtBalance: String(b.debtBalance),
      })
    }
  }
  return drift
}

async function checkStuckOrders(prisma: AnyPrisma) {
  const delivered = await prisma.order.findMany({
    where: { status: "DELIVERED" },
    select: {
      id: true,
      organizationId: true,
      deliveredAt: true,
      settlements: {
        where: { status: { not: "CANCELLED" } },
        select: { id: true },
      },
      platformRevenue: { select: { id: true, reversedAt: true } },
    },
  })
  const stuck = delivered
    .filter(
      (o: any) =>
        o.settlements.length === 0 &&
        (!o.platformRevenue || o.platformRevenue.reversedAt !== null),
    )
    .map((o: any) => ({
      orderId: o.id,
      organizationId: o.organizationId,
      deliveredAt: o.deliveredAt?.toISOString() ?? null,
      problem:
        "DELIVERED order has no active settlement and no platform revenue",
    }))

  // Escrowed customer money must not age silently: paid orders no publisher
  // ever accepted. Surfaced for staff action (force-cancel refunds through
  // the single tested refund path) — deliberately NOT auto-refunded here;
  // the sweep is a detector, not a money mover.
  const staleDays = Math.max(
    Number(process.env.ORDER_ACCEPT_STALE_DAYS ?? 7),
    1,
  )
  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000)
  const staleSubmitted = await prisma.order.findMany({
    where: { status: "SUBMITTED", updatedAt: { lt: cutoff } },
    select: { id: true, organizationId: true, amount: true, updatedAt: true },
  })
  for (const o of staleSubmitted) {
    stuck.push({
      orderId: o.id,
      organizationId: o.organizationId,
      amount: String(o.amount ?? 0),
      problem: `SUBMITTED for >${staleDays}d with no publisher acceptance — customer funds escrowed; review or force-cancel (refund)`,
    } as any)
  }

  return stuck
}

async function checkStuckPayouts(prisma: AnyPrisma) {
  const stuck: any[] = []
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)

  const staleProcessing = await prisma.withdrawal.findMany({
    where: { status: "PROCESSING", updatedAt: { lt: oneHourAgo } },
    select: { id: true, publisherId: true, amount: true, updatedAt: true },
  })
  if (staleProcessing.length > 0) {
    const recentExecGroups = await prisma.payoutExecution.groupBy({
      by: ["withdrawalId"],
      where: {
        withdrawalId: { in: staleProcessing.map((w: any) => w.id) },
        createdAt: { gt: oneHourAgo },
      },
      _count: true,
    })
    const hasRecentExecution = new Set(
      recentExecGroups.map((g: any) => g.withdrawalId),
    )
    for (const w of staleProcessing) {
      if (!hasRecentExecution.has(w.id)) {
        stuck.push({
          withdrawalId: w.id,
          publisherId: w.publisherId,
          amount: String(w.amount),
          problem: "PROCESSING for >1h with no recent payout execution",
        })
      }
    }
  }

  const staleExecutions = await prisma.payoutExecution.findMany({
    where: { status: "PROCESSING", updatedAt: { lt: twoHoursAgo } },
    select: {
      id: true,
      withdrawalId: true,
      providerExecutionId: true,
      updatedAt: true,
    },
  })
  for (const e of staleExecutions) {
    stuck.push({
      executionId: e.id,
      withdrawalId: e.withdrawalId,
      providerExecutionId: e.providerExecutionId,
      problem: "PROCESSING for >2h — manual intervention required",
    })
  }

  // One grouped pass: FAILED-orphan / COMPLETED-orphan / duplicate-COMPLETED
  const execGroups = await prisma.payoutExecution.groupBy({
    by: ["withdrawalId", "status"],
    where: { status: { in: ["FAILED", "COMPLETED"] } },
    _count: { _all: true },
  })
  const hasFailedExec = new Set<string>()
  const hasCompletedExec = new Set<string>()
  const duplicateCompleted = new Map<string, number>()
  for (const g of execGroups) {
    if (g.status === "FAILED") hasFailedExec.add(g.withdrawalId)
    if (g.status === "COMPLETED") {
      hasCompletedExec.add(g.withdrawalId)
      if (g._count._all > 1)
        duplicateCompleted.set(g.withdrawalId, g._count._all)
    }
  }

  const failedWithdrawals = await prisma.withdrawal.findMany({
    where: { status: "FAILED" },
    select: { id: true, publisherId: true, amount: true },
  })
  for (const w of failedWithdrawals) {
    if (!hasFailedExec.has(w.id)) {
      stuck.push({
        withdrawalId: w.id,
        publisherId: w.publisherId,
        amount: String(w.amount),
        problem: "FAILED status with no failed PayoutExecution record",
      })
    }
  }

  if (duplicateCompleted.size > 0) {
    const dupWithdrawals = await prisma.withdrawal.findMany({
      where: { id: { in: [...duplicateCompleted.keys()] } },
      select: { id: true, publisherId: true, amount: true },
    })
    const byId = new Map(dupWithdrawals.map((w: any) => [w.id, w]))
    for (const [withdrawalId, count] of duplicateCompleted) {
      const withdrawal: any = byId.get(withdrawalId)
      stuck.push({
        withdrawalId,
        publisherId: withdrawal?.publisherId,
        amount: withdrawal ? String(withdrawal.amount) : null,
        problem: `Found ${count} COMPLETED executions for single withdrawal — potential double payout`,
      })
    }
  }

  // lifetimePaid drift vs COMPLETED withdrawal sums
  const [paidBalances, completedSums] = await Promise.all([
    prisma.publisherBalance.findMany({
      where: { lifetimePaid: { gt: 0 } },
      select: { publisherId: true, lifetimePaid: true },
    }),
    prisma.withdrawal.groupBy({
      by: ["publisherId"],
      where: { status: "COMPLETED" },
      _sum: { amount: true },
    }),
  ])
  const completedByPublisher = new Map<string, bigint>(
    completedSums.map((s: any) => [
      s.publisherId as string,
      toScaled(s._sum.amount ?? 0),
    ]),
  )
  for (const b of paidBalances) {
    const expected = completedByPublisher.get(b.publisherId) ?? 0n
    const actual = toScaled(b.lifetimePaid)
    if (actual !== expected) {
      stuck.push({
        publisherId: b.publisherId,
        lifetimePaid: fromScaled(actual),
        expectedFromWithdrawals: fromScaled(expected),
        delta: fromScaled(actual - expected),
        problem:
          "lifetimePaid does not match sum of COMPLETED withdrawal amounts",
      })
    }
  }

  const completedWithdrawals = await prisma.withdrawal.findMany({
    where: { status: "COMPLETED" },
    select: { id: true, publisherId: true, amount: true },
  })
  for (const w of completedWithdrawals) {
    if (!hasCompletedExec.has(w.id)) {
      stuck.push({
        withdrawalId: w.id,
        publisherId: w.publisherId,
        amount: String(w.amount),
        problem: "COMPLETED withdrawal has no COMPLETED PayoutExecution record",
      })
    }
  }

  return stuck
}

export async function runReconciliation(
  prisma: AnyPrisma,
): Promise<ReconciliationReport> {
  const [wallets, publishers, stuckOrders, stuckPayouts] = await Promise.all([
    checkWallets(prisma),
    checkPublisherBalances(prisma),
    checkStuckOrders(prisma),
    checkStuckPayouts(prisma),
  ])
  return {
    ranAt: new Date().toISOString(),
    ok:
      wallets.length === 0 &&
      publishers.length === 0 &&
      stuckOrders.length === 0 &&
      stuckPayouts.length === 0,
    walletDrift: wallets,
    publisherDrift: publishers,
    stuckOrders,
    stuckPayouts,
  }
}
