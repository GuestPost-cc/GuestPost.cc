// Financial drift detection core — shared by the API's on-demand
// GET /admin/reconciliation endpoint and the worker's scheduled sweep.
// Takes any Prisma client (API's PrismaService or the worker's singleton) so
// the two paths can never diverge on what "drift" means.
//
// Modules:
//  1. Wallet Drift — cached balance vs ledger sum
//  2. Publisher Balance Drift — withdrawableBalance vs ledger sum
//  3. Settlement Integrity — amount consistency, ledger sync, completeness
//  4. Order Payment Reconciliation — PURCHASE transactions vs order state
//  5. Refund Reconciliation — REFUND transactions vs order state
//  6. Stuck Financial Orders — money-flow orders without settlements/payouts
//  7. Stuck Payouts — stale, orphaned, or duplicate payout executions
//
// All checks use set-based grouped queries — a fixed number of round trips
// regardless of row counts.

type AnyPrisma = any

// ─── Fixed-point money helpers (BigInt, 12 fractional digits) ───────────────

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

// ─── Enums & types ─────────────────────────────────────────────────────────

export enum ReconciliationCode {
  WALLET_DRIFT = "WALLET_DRIFT",
  PUBLISHER_DRIFT = "PUBLISHER_DRIFT",
  SETTLEMENT_AMOUNT_MISMATCH = "SETTLEMENT_AMOUNT_MISMATCH",
  SETTLEMENT_RELEASED_NO_TX = "SETTLEMENT_RELEASED_NO_TX",
  SETTLEMENT_TX_NOT_RELEASED = "SETTLEMENT_TX_NOT_RELEASED",
  SETTLEMENT_RELEASE_AMOUNT = "SETTLEMENT_RELEASE_AMOUNT",
  SETTLEMENT_DUPLICATE_RELEASE = "SETTLEMENT_DUPLICATE_RELEASE",
  SETTLEMENT_ORDER_COMPLETED_NONE = "SETTLEMENT_ORDER_COMPLETED_NONE",
  SETTLEMENT_ORDER_COMPLETED_MULTI = "SETTLEMENT_ORDER_COMPLETED_MULTI",
  SETTLEMENT_ORPHAN = "SETTLEMENT_ORPHAN",
  SETTLEMENT_MISSING_ORDER = "SETTLEMENT_MISSING_ORDER",
  SETTLEMENT_MISSING_PUBLISHER = "SETTLEMENT_MISSING_PUBLISHER",
  SETTLEMENT_RELEASED_BALANCE_NOT_CREDITED = "SETTLEMENT_RELEASED_BALANCE_NOT_CREDITED",
  PAYMENT_UNMATCHED = "PAYMENT_UNMATCHED",
  PAYMENT_MISSING_WALLET = "PAYMENT_MISSING_WALLET",
  PAYMENT_ORDER_PAID_NO_TX = "PAYMENT_ORDER_PAID_NO_TX",
  PAYMENT_DUPLICATE = "PAYMENT_DUPLICATE",
  PAYMENT_AMOUNT_MISMATCH = "PAYMENT_AMOUNT_MISMATCH",
  REFUND_NO_TRANSACTION = "REFUND_NO_TRANSACTION",
  REFUND_ORPHAN_TX = "REFUND_ORPHAN_TX",
  REFUND_DUPLICATE = "REFUND_DUPLICATE",
  REFUND_PARTIAL = "REFUND_PARTIAL",
  REFUND_SETTLEMENT_NOT_REVERSED = "REFUND_SETTLEMENT_NOT_REVERSED",
  ORDER_DELIVERED_NO_SETTLEMENT = "ORDER_DELIVERED_NO_SETTLEMENT",
  ORDER_PAID_NO_SETTLEMENT = "ORDER_PAID_NO_SETTLEMENT",
  ORDER_VERIFIED_NO_SETTLEMENT = "ORDER_VERIFIED_NO_SETTLEMENT",
  PAYOUT_STALE_PROCESSING = "PAYOUT_STALE_PROCESSING",
  PAYOUT_STALE_EXECUTION = "PAYOUT_STALE_EXECUTION",
  PAYOUT_FAILED_ORPHAN = "PAYOUT_FAILED_ORPHAN",
  PAYOUT_DUPLICATE_COMPLETED = "PAYOUT_DUPLICATE_COMPLETED",
  PAYOUT_LIFETIME_DRIFT = "PAYOUT_LIFETIME_DRIFT",
  PAYOUT_COMPLETED_NO_EXECUTION = "PAYOUT_COMPLETED_NO_EXECUTION",
}

export enum ReconciliationCategory {
  WALLET = "wallet",
  PUBLISHER = "publisher",
  SETTLEMENT = "settlement",
  PAYMENT = "payment",
  REFUND = "refund",
  ORDER = "order",
  PAYOUT = "payout",
}

export enum SettlementIntegrityGroup {
  AMOUNT = "amount",
  SYNC = "sync",
  COMPLETENESS = "completeness",
}

export interface DriftRow {
  id: string
  severity: "critical" | "warning" | "info"
  category: ReconciliationCategory
  group?: SettlementIntegrityGroup
  code: ReconciliationCode
  entityId: string
  entityType: string
  amount?: string
  message: string
  detectedAt: string
  metadata?: {
    expectedAmount?: string
    actualAmount?: string
    expectedStatus?: string
    actualStatus?: string
    duplicateCount?: number
    transactionId?: string
    settlementId?: string
    orderId?: string
    publisherId?: string
    walletId?: string
  }
  action?: {
    type: "wallet" | "order" | "settlement" | "publisher" | "payout"
    id: string
  }
}

export interface ReconciliationReport {
  version: 1
  ranAt: string
  scanDurationMs: number
  ok: boolean
  summary: {
    critical: number
    warning: number
    info: number
    totalIssues: number
  }
  stats: {
    checkedWallets: number
    checkedSettlements: number
    checkedOrders: number
    checkedTransactions: number
    checkedPublishers: number
  }
  walletDrift: DriftRow[]
  publisherDrift: DriftRow[]
  settlementDrift: DriftRow[]
  orderPaymentRecon: DriftRow[]
  refundRecon: DriftRow[]
  stuckFinancialOrders: DriftRow[]
  stuckPayouts: DriftRow[]
}

interface DriftStats {
  checkedWallets: number
  checkedSettlements: number
  checkedOrders: number
  checkedTransactions: number
  checkedPublishers: number
}

function generateRowId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof c?.randomUUID === "function") return c.randomUUID()
  const hex = "0123456789abcdef"
  let out = ""
  for (let i = 0; i < 32; i++) out += hex[Math.floor(Math.random() * 16)]
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-${out.slice(16, 20)}-${out.slice(20, 32)}`
}

function makeRow(
  overrides: Omit<DriftRow, "id" | "detectedAt"> & { id?: string },
): DriftRow {
  return {
    ...overrides,
    id: overrides.id ?? generateRowId(),
    detectedAt: new Date().toISOString(),
  }
}

// ─── 1. Wallet Drift ───────────────────────────────────────────────────────

async function checkWallets(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
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

  stats.checkedWallets = wallets.length
  stats.checkedTransactions += sums.length

  const expectedByWallet = new Map<string, bigint>()
  for (const s of sums) {
    if (s.type === "RESERVATION" || !s.walletId) continue
    const current = expectedByWallet.get(s.walletId) ?? 0n
    expectedByWallet.set(s.walletId, current + toScaled(s._sum.amount ?? 0))
  }

  const drift: DriftRow[] = []
  for (const w of wallets) {
    const expected = expectedByWallet.get(w.id) ?? 0n
    const actual = toScaled(w.availableBalance) + toScaled(w.reservedBalance)
    if (actual !== expected) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.WALLET,
          code: ReconciliationCode.WALLET_DRIFT,
          entityId: w.id,
          entityType: "Wallet",
          amount: fromScaled(actual - expected),
          message: `Wallet ${w.id.slice(0, 8)} balance (${fromScaled(actual)}) differs from ledger (${fromScaled(expected)})`,
          metadata: {
            expectedAmount: fromScaled(expected),
            actualAmount: fromScaled(actual),
            walletId: w.id,
          },
          action: { type: "wallet", id: w.id },
        }),
      )
    }
  }
  return drift
}

// ─── 2. Publisher Balance Drift ────────────────────────────────────────────

async function checkPublisherBalances(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
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

  stats.checkedPublishers = balances.length
  stats.checkedTransactions += sums.length

  const expectedByPublisher = new Map<string, bigint>()
  for (const s of sums) {
    if (s.publisherId)
      expectedByPublisher.set(s.publisherId, toScaled(s._sum.amount ?? 0))
  }

  const drift: DriftRow[] = []
  for (const b of balances) {
    const expected = expectedByPublisher.get(b.publisherId) ?? 0n
    const actual = toScaled(b.withdrawableBalance)
    if (actual !== expected) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PUBLISHER,
          code: ReconciliationCode.PUBLISHER_DRIFT,
          entityId: b.publisherId,
          entityType: "PublisherBalance",
          amount: fromScaled(actual - expected),
          message: `Publisher ${b.publisherId.slice(0, 8)} withdrawable balance (${fromScaled(actual)}) differs from ledger (${fromScaled(expected)})`,
          metadata: {
            expectedAmount: fromScaled(expected),
            actualAmount: fromScaled(actual),
            publisherId: b.publisherId,
          },
          action: { type: "publisher", id: b.publisherId },
        }),
      )
    }
  }
  return drift
}

// ─── 3. Settlement Integrity ───────────────────────────────────────────────

async function checkSettlementDrift(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
  const drift: DriftRow[] = []
  const now = new Date().toISOString()

  // ── 3a. Amount Integrity ──────────────────────────────────────────────────

  const allSettlements = await prisma.settlement.findMany({
    where: { status: { not: "CANCELLED" } },
    select: {
      id: true,
      grossAmount: true,
      platformFee: true,
      publisherAmount: true,
      publisherId: true,
      orderId: true,
      status: true,
    },
  })
  stats.checkedSettlements = allSettlements.length

  for (const s of allSettlements) {
    const gross = toScaled(s.grossAmount)
    const fee = toScaled(s.platformFee)
    const pub = toScaled(s.publisherAmount)
    if (gross !== fee + pub) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.SETTLEMENT,
          group: SettlementIntegrityGroup.AMOUNT,
          code: ReconciliationCode.SETTLEMENT_AMOUNT_MISMATCH,
          entityId: s.id,
          entityType: "Settlement",
          amount: fromScaled(gross - (fee + pub)),
          message: `Settlement ${s.id.slice(0, 8)} gross (${fromScaled(gross)}) ≠ platformFee (${fromScaled(fee)}) + publisherAmount (${fromScaled(pub)})`,
          metadata: {
            expectedAmount: fromScaled(fee + pub),
            actualAmount: fromScaled(gross),
            settlementId: s.id,
          },
          action: { type: "settlement", id: s.id },
        }),
      )
    }
  }

  // ── 3b. Ledger Synchronization ───────────────────────────────────────────

  const releaseSettlements = allSettlements.filter(
    (s: any) => s.status === "RELEASED",
  )
  const settlementIds = releaseSettlements.map((s: any) => s.id)

  if (settlementIds.length > 0) {
    const releaseTxs = await prisma.transaction.groupBy({
      by: ["settlementId", "type"],
      where: {
        settlementId: { in: settlementIds },
        type: "SETTLEMENT_RELEASE" as any,
      },
      _sum: { amount: true },
      _count: true,
    })
    stats.checkedTransactions += releaseTxs.length

    const txBySettlement = new Map<string, { count: number; sum: bigint }>(
      releaseTxs.map((t: any) => [
        t.settlementId as string,
        {
          count: (t._count as any) ?? 1,
          sum: toScaled((t._sum as any).amount ?? 0),
        },
      ]),
    )

    for (const s of releaseSettlements) {
      const txInfo = txBySettlement.get(s.id)
      if (!txInfo) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.SETTLEMENT,
            group: SettlementIntegrityGroup.SYNC,
            code: ReconciliationCode.SETTLEMENT_RELEASED_NO_TX,
            entityId: s.id,
            entityType: "Settlement",
            message: `Settlement ${s.id.slice(0, 8)} is RELEASED but has no SETTLEMENT_RELEASE transaction`,
            metadata: { settlementId: s.id },
            action: { type: "settlement", id: s.id },
          }),
        )
      } else {
        const pubAmount = toScaled(s.publisherAmount)
        if (txInfo.sum !== pubAmount) {
          drift.push(
            makeRow({
              severity: "critical",
              category: ReconciliationCategory.SETTLEMENT,
              group: SettlementIntegrityGroup.SYNC,
              code: ReconciliationCode.SETTLEMENT_RELEASE_AMOUNT,
              entityId: s.id,
              entityType: "Settlement",
              amount: fromScaled(txInfo.sum - pubAmount),
              message: `Settlement ${s.id.slice(0, 8)} publisherAmount (${fromScaled(pubAmount)}) ≠ release transaction sum (${fromScaled(txInfo.sum)})`,
              metadata: {
                expectedAmount: fromScaled(pubAmount),
                actualAmount: fromScaled(txInfo.sum),
                settlementId: s.id,
              },
              action: { type: "settlement", id: s.id },
            }),
          )
        }
        if (txInfo.count > 1) {
          drift.push(
            makeRow({
              severity: "critical",
              category: ReconciliationCategory.SETTLEMENT,
              group: SettlementIntegrityGroup.SYNC,
              code: ReconciliationCode.SETTLEMENT_DUPLICATE_RELEASE,
              entityId: s.id,
              entityType: "Settlement",
              message: `Settlement ${s.id.slice(0, 8)} has ${txInfo.count} SETTLEMENT_RELEASE transactions`,
              metadata: { duplicateCount: txInfo.count, settlementId: s.id },
              action: { type: "settlement", id: s.id },
            }),
          )
        }
      }
    }
  }

  // Orphan release transactions (tx exists but settlement not RELEASED)
  const nonReleasedTxSettlements = await prisma.transaction.groupBy({
    by: ["settlementId"],
    where: {
      settlementId: {
        in: allSettlements
          .filter((s: any) => s.status !== "RELEASED")
          .map((s: any) => s.id),
      },
      type: "SETTLEMENT_RELEASE" as any,
    },
    _count: true,
  })
  for (const t of nonReleasedTxSettlements) {
    if (!t.settlementId) continue
    drift.push(
      makeRow({
        severity: "critical",
        category: ReconciliationCategory.SETTLEMENT,
        group: SettlementIntegrityGroup.SYNC,
        code: ReconciliationCode.SETTLEMENT_TX_NOT_RELEASED,
        entityId: t.settlementId,
        entityType: "Settlement",
        message: `Settlement ${t.settlementId.slice(0, 8)} has SETTLEMENT_RELEASE transaction but status is not RELEASED`,
        metadata: { settlementId: t.settlementId },
        action: { type: "settlement", id: t.settlementId },
      }),
    )
  }

  // RELEASED settlement but publisher balance not credited
  if (releaseSettlements.length > 0) {
    const releaseTxSums = await prisma.transaction.groupBy({
      by: ["publisherId"],
      where: {
        settlementId: { in: settlementIds },
        type: "SETTLEMENT_RELEASE" as any,
      },
      _sum: { amount: true },
    })
    const releasedByPublisher = new Map<string, bigint>(
      releaseSettlements.map((s: any) => [
        s.publisherId as string,
        toScaled(s.publisherAmount),
      ]),
    )
    const creditedByPublisher = new Map<string, bigint>()
    for (const t of releaseTxSums) {
      if (t.publisherId) {
        const existing = creditedByPublisher.get(t.publisherId) ?? 0n
        creditedByPublisher.set(
          t.publisherId,
          existing + toScaled((t._sum as any).amount ?? 0),
        )
      }
    }
    for (const [pubId, expected] of releasedByPublisher) {
      const credited = creditedByPublisher.get(pubId) ?? 0n
      if (credited < expected) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.SETTLEMENT,
            group: SettlementIntegrityGroup.SYNC,
            code: ReconciliationCode.SETTLEMENT_RELEASED_BALANCE_NOT_CREDITED,
            entityId: pubId,
            entityType: "Publisher",
            amount: fromScaled(expected - credited),
            message: `Publisher ${pubId.slice(0, 8)} has RELEASED settlements totaling ${fromScaled(expected)} but only ${fromScaled(credited)} credited via SETTLEMENT_RELEASE transactions`,
            metadata: {
              expectedAmount: fromScaled(expected),
              actualAmount: fromScaled(credited),
              publisherId: pubId,
            },
            action: { type: "publisher", id: pubId },
          }),
        )
      }
    }
  }

  // ── 3c. Completeness ─────────────────────────────────────────────────────

  // Completed/settled orders with 0 or >1 settlements
  const completedOrders = await prisma.order.findMany({
    where: { status: { in: ["SETTLED", "COMPLETED"] } },
    select: {
      id: true,
      status: true,
      settlements: { select: { id: true } },
    },
  })
  for (const o of completedOrders) {
    if (o.settlements.length === 0) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.SETTLEMENT,
          group: SettlementIntegrityGroup.COMPLETENESS,
          code: ReconciliationCode.SETTLEMENT_ORDER_COMPLETED_NONE,
          entityId: o.id,
          entityType: "Order",
          message: `Order ${o.id.slice(0, 8)} is ${o.status} but has no settlements`,
          metadata: { orderId: o.id },
          action: { type: "order", id: o.id },
        }),
      )
    } else if (o.settlements.length > 1) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.SETTLEMENT,
          group: SettlementIntegrityGroup.COMPLETENESS,
          code: ReconciliationCode.SETTLEMENT_ORDER_COMPLETED_MULTI,
          entityId: o.id,
          entityType: "Order",
          message: `Order ${o.id.slice(0, 8)} is ${o.status} but has ${o.settlements.length} settlements`,
          metadata: { duplicateCount: o.settlements.length, orderId: o.id },
          action: { type: "order", id: o.id },
        }),
      )
    }
  }

  // Orphan settlement (referenced order doesn't exist)
  for (const s of allSettlements) {
    if (!s.orderId) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.SETTLEMENT,
          group: SettlementIntegrityGroup.COMPLETENESS,
          code: ReconciliationCode.SETTLEMENT_MISSING_ORDER,
          entityId: s.id,
          entityType: "Settlement",
          message: `Settlement ${s.id.slice(0, 8)} has no orderId`,
          metadata: { settlementId: s.id },
          action: { type: "settlement", id: s.id },
        }),
      )
    }
    if (!s.publisherId) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.SETTLEMENT,
          group: SettlementIntegrityGroup.COMPLETENESS,
          code: ReconciliationCode.SETTLEMENT_MISSING_PUBLISHER,
          entityId: s.id,
          entityType: "Settlement",
          message: `Settlement ${s.id.slice(0, 8)} has no publisherId`,
          metadata: { settlementId: s.id },
          action: { type: "settlement", id: s.id },
        }),
      )
    }
  }

  return drift
}

// ─── 4. Order Payment Reconciliation ──────────────────────────────────────

async function checkOrderPaymentReconciliation(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
  const drift: DriftRow[] = []

  const [purchaseTxs, paidOrders] = await Promise.all([
    prisma.transaction.findMany({
      where: { type: "PURCHASE" as any },
      select: {
        id: true,
        amount: true,
        walletId: true,
        orderId: true,
      },
    }),
    prisma.order.findMany({
      where: { paymentStatus: "PAID" },
      select: { id: true, amount: true },
    }),
  ])
  stats.checkedTransactions += purchaseTxs.length
  stats.checkedOrders += paidOrders.length

  const paidOrderIds = new Set(paidOrders.map((o: any) => o.id))

  // Group PURCHASE txs by orderId
  const txsByOrder = new Map<
    string,
    { count: number; sum: bigint; txs: any[] }
  >()
  const orphanTxs: any[] = []

  for (const tx of purchaseTxs) {
    if (!tx.orderId) {
      orphanTxs.push(tx)
      continue
    }
    if (!tx.walletId) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_MISSING_WALLET,
          entityId: tx.id,
          entityType: "Transaction",
          amount: String(tx.amount ?? 0),
          message: `PURCHASE transaction ${tx.id.slice(0, 8)} has no walletId`,
          metadata: { transactionId: tx.id },
        }),
      )
    }
    const entry = txsByOrder.get(tx.orderId) ?? { count: 0, sum: 0n, txs: [] }
    entry.count++
    entry.sum += toScaled(tx.amount)
    entry.txs.push(tx)
    txsByOrder.set(tx.orderId, entry)
  }

  // Unmatched payments
  for (const tx of orphanTxs) {
    drift.push(
      makeRow({
        severity: "critical",
        category: ReconciliationCategory.PAYMENT,
        code: ReconciliationCode.PAYMENT_UNMATCHED,
        entityId: tx.id,
        entityType: "Transaction",
        amount: String(tx.amount ?? 0),
        message: `PURCHASE transaction ${tx.id.slice(0, 8)} has no orderId`,
        metadata: { transactionId: tx.id },
      }),
    )
  }

  // Orders marked PAID but no PURCHASE transaction
  for (const o of paidOrders) {
    if (!txsByOrder.has(o.id)) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_ORDER_PAID_NO_TX,
          entityId: o.id,
          entityType: "Order",
          message: `Order ${o.id.slice(0, 8)} is PAID but has no PURCHASE transaction`,
          metadata: { orderId: o.id },
          action: { type: "order", id: o.id },
        }),
      )
    }
  }

  // Duplicate payments and amount mismatches
  for (const [orderId, entry] of txsByOrder) {
    if (entry.count > 1) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYMENT,
          code: ReconciliationCode.PAYMENT_DUPLICATE,
          entityId: orderId,
          entityType: "Order",
          amount: fromScaled(entry.sum),
          message: `Order ${orderId.slice(0, 8)} has ${entry.count} PURCHASE transactions`,
          metadata: { duplicateCount: entry.count, orderId },
          action: { type: "order", id: orderId },
        }),
      )
    }
    if (paidOrderIds.has(orderId)) {
      const order = paidOrders.find((o: any) => o.id === orderId)
      if (order) {
        const orderAmount = toScaled(order.amount ?? 0)
        // PURCHASE transactions are stored as negative amounts (debits).
        const txnSum = entry.sum < 0n ? -entry.sum : entry.sum
        if (txnSum !== orderAmount) {
          drift.push(
            makeRow({
              severity: "critical",
              category: ReconciliationCategory.PAYMENT,
              code: ReconciliationCode.PAYMENT_AMOUNT_MISMATCH,
              entityId: orderId,
              entityType: "Order",
              amount: fromScaled(txnSum - orderAmount),
              message: `Order ${orderId.slice(0, 8)} amount (${fromScaled(orderAmount)}) ≠ sum of PURCHASE transactions (${fromScaled(txnSum)})`,
              metadata: {
                expectedAmount: fromScaled(orderAmount),
                actualAmount: fromScaled(txnSum),
                orderId,
              },
              action: { type: "order", id: orderId },
            }),
          )
        }
      }
    }
  }

  return drift
}

// ─── 5. Refund Reconciliation ─────────────────────────────────────────────

async function checkRefundReconciliation(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
  const drift: DriftRow[] = []

  const [refundedOrders, refundTxs] = await Promise.all([
    prisma.order.findMany({
      where: { status: "REFUNDED" },
      select: {
        id: true,
        amount: true,
        settlements: {
          where: { status: "RELEASED" },
          select: { id: true },
        },
      },
    }),
    prisma.transaction.findMany({
      where: { type: "REFUND" as any },
      select: { id: true, amount: true, orderId: true },
    }),
  ])
  stats.checkedOrders += refundedOrders.length
  stats.checkedTransactions += refundTxs.length

  const refundedOrderIds = new Set(refundedOrders.map((o: any) => o.id))
  const refundTxsByOrder = new Map<string, { count: number; sum: bigint }>()
  const orphanRefundTxs: any[] = []

  for (const tx of refundTxs) {
    if (!tx.orderId) {
      orphanRefundTxs.push(tx)
      continue
    }
    const entry = refundTxsByOrder.get(tx.orderId) ?? { count: 0, sum: 0n }
    entry.count++
    entry.sum += toScaled(tx.amount)
    refundTxsByOrder.set(tx.orderId, entry)
  }

  // Order REFUNDED but no REFUND transaction
  for (const o of refundedOrders) {
    if (!refundTxsByOrder.has(o.id)) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.REFUND,
          code: ReconciliationCode.REFUND_NO_TRANSACTION,
          entityId: o.id,
          entityType: "Order",
          message: `Order ${o.id.slice(0, 8)} is REFUNDED but has no REFUND transaction`,
          metadata: { orderId: o.id },
          action: { type: "order", id: o.id },
        }),
      )
    }
  }

  // Orphan REFUND transaction (order not REFUNDED)
  for (const tx of orphanRefundTxs) {
    drift.push(
      makeRow({
        severity: "critical",
        category: ReconciliationCategory.REFUND,
        code: ReconciliationCode.REFUND_ORPHAN_TX,
        entityId: tx.id,
        entityType: "Transaction",
        amount: String(tx.amount ?? 0),
        message: `REFUND transaction ${tx.id.slice(0, 8)} has no orderId`,
        metadata: { transactionId: tx.id },
      }),
    )
  }
  for (const [orderId, _entry] of refundTxsByOrder) {
    if (!refundedOrderIds.has(orderId)) {
      const txSample = refundTxs.find((tx: any) => tx.orderId === orderId)
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.REFUND,
          code: ReconciliationCode.REFUND_ORPHAN_TX,
          entityId: orderId,
          entityType: "Order",
          message: `REFUND transaction exists for order ${orderId.slice(0, 8)} but order is not REFUNDED`,
          metadata: {
            transactionId: txSample?.id,
            orderId,
          },
          action: { type: "order", id: orderId },
        }),
      )
    }
  }

  // Duplicate refund and partial refund
  for (const [orderId, entry] of refundTxsByOrder) {
    if (entry.count > 1) {
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.REFUND,
          code: ReconciliationCode.REFUND_DUPLICATE,
          entityId: orderId,
          entityType: "Order",
          amount: fromScaled(entry.sum),
          message: `Order ${orderId.slice(0, 8)} has ${entry.count} REFUND transactions`,
          metadata: { duplicateCount: entry.count, orderId },
          action: { type: "order", id: orderId },
        }),
      )
    }
    const o = refundedOrders.find((o: any) => o.id === orderId)
    if (o && entry.sum !== toScaled(o.amount ?? 0)) {
      const isWarning = entry.sum < toScaled(o.amount ?? 0)
      drift.push(
        makeRow({
          severity: isWarning ? "warning" : "critical",
          category: ReconciliationCategory.REFUND,
          code: isWarning
            ? ReconciliationCode.REFUND_PARTIAL
            : ReconciliationCode.REFUND_PARTIAL,
          entityId: orderId,
          entityType: "Order",
          amount: fromScaled(toScaled(o.amount ?? 0) - entry.sum),
          message: `Order ${orderId.slice(0, 8)} refund sum (${fromScaled(entry.sum)}) ${isWarning ? "is less than" : "exceeds"} order amount (${fromScaled(toScaled(o.amount ?? 0))})`,
          metadata: {
            expectedAmount: fromScaled(toScaled(o.amount ?? 0)),
            actualAmount: fromScaled(entry.sum),
            orderId,
          },
          action: { type: "order", id: orderId },
        }),
      )
    }
  }

  // REFUNDED order with active RELEASED settlement
  for (const o of refundedOrders) {
    if (o.settlements.length > 0) {
      for (const s of o.settlements) {
        drift.push(
          makeRow({
            severity: "critical",
            category: ReconciliationCategory.REFUND,
            code: ReconciliationCode.REFUND_SETTLEMENT_NOT_REVERSED,
            entityId: s.id,
            entityType: "Settlement",
            message: `Order ${o.id.slice(0, 8)} is REFUNDED but settlement ${s.id.slice(0, 8)} is still RELEASED`,
            metadata: { settlementId: s.id, orderId: o.id },
            action: { type: "settlement", id: s.id },
          }),
        )
      }
    }
  }

  return drift
}

// ─── 6. Stuck Financial Orders ────────────────────────────────────────────

async function checkStuckFinancialOrders(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
  const drift: DriftRow[] = []

  // DELIVERED orders with no active settlement and no unreversed platform revenue
  const delivered = await prisma.order.findMany({
    where: { status: "DELIVERED" },
    select: {
      id: true,
      deliveredAt: true,
      settlements: {
        where: { status: { not: "CANCELLED" } },
        select: { id: true },
      },
      platformRevenue: { select: { id: true, reversedAt: true } },
    },
  })
  stats.checkedOrders += delivered.length

  for (const o of delivered) {
    const hasSettlement = o.settlements.length > 0
    const hasRevenue = o.platformRevenue && !o.platformRevenue.reversedAt
    if (!hasSettlement && !hasRevenue) {
      drift.push(
        makeRow({
          severity: "warning",
          category: ReconciliationCategory.ORDER,
          code: ReconciliationCode.ORDER_DELIVERED_NO_SETTLEMENT,
          entityId: o.id,
          entityType: "Order",
          message: `Order ${o.id.slice(0, 8)} is DELIVERED but has no active settlement or unreversed platform revenue`,
          metadata: { orderId: o.id },
          action: { type: "order", id: o.id },
        }),
      )
    }
  }

  // PAID for >N days with no settlement
  const staleDays = Math.max(
    Number(process.env.ORDER_SETTLEMENT_STALE_DAYS ?? 7),
    1,
  )
  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000)
  const paidNoSettlement = await prisma.order.findMany({
    where: {
      paymentStatus: "PAID",
      status: { notIn: ["SETTLED", "COMPLETED", "CANCELLED", "REFUNDED"] },
      updatedAt: { lt: cutoff },
      settlements: { none: { status: { not: "CANCELLED" } } },
    },
    select: { id: true, amount: true, updatedAt: true },
  })
  stats.checkedOrders += paidNoSettlement.length

  for (const o of paidNoSettlement) {
    drift.push(
      makeRow({
        severity: "warning",
        category: ReconciliationCategory.ORDER,
        code: ReconciliationCode.ORDER_PAID_NO_SETTLEMENT,
        entityId: o.id,
        entityType: "Order",
        amount: String(o.amount ?? 0),
        message: `Order ${o.id.slice(0, 8)} is PAID for >${staleDays}d with no settlement created`,
        metadata: { orderId: o.id },
        action: { type: "order", id: o.id },
      }),
    )
  }

  // VERIFIED for >N days with no settlement
  const verifiedNoSettlement = await prisma.order.findMany({
    where: {
      status: "VERIFIED",
      updatedAt: { lt: cutoff },
      settlements: { none: { status: { not: "CANCELLED" } } },
    },
    select: { id: true, amount: true, verifiedAt: true },
  })
  stats.checkedOrders += verifiedNoSettlement.length

  for (const o of verifiedNoSettlement) {
    drift.push(
      makeRow({
        severity: "warning",
        category: ReconciliationCategory.ORDER,
        code: ReconciliationCode.ORDER_VERIFIED_NO_SETTLEMENT,
        entityId: o.id,
        entityType: "Order",
        amount: String(o.amount ?? 0),
        message: `Order ${o.id.slice(0, 8)} is VERIFIED for >${staleDays}d with no settlement created`,
        metadata: { orderId: o.id },
        action: { type: "order", id: o.id },
      }),
    )
  }

  return drift
}

// ─── 7. Stuck Payouts ─────────────────────────────────────────────────────

async function checkStuckPayouts(
  prisma: AnyPrisma,
  stats: DriftStats,
): Promise<DriftRow[]> {
  const drift: DriftRow[] = []
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)

  // Stale PROCESSING withdrawals (>1h with no recent execution)
  const staleProcessing = await prisma.withdrawal.findMany({
    where: { status: "PROCESSING", updatedAt: { lt: oneHourAgo } },
    select: { id: true, publisherId: true, amount: true, updatedAt: true },
  })
  stats.checkedOrders += staleProcessing.length

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
        drift.push(
          makeRow({
            severity: "warning",
            category: ReconciliationCategory.PAYOUT,
            code: ReconciliationCode.PAYOUT_STALE_PROCESSING,
            entityId: w.id,
            entityType: "Withdrawal",
            amount: String(w.amount),
            message: `Withdrawal ${w.id.slice(0, 8)} PROCESSING for >1h with no recent payout execution`,
            metadata: { publisherId: w.publisherId },
            action: { type: "payout", id: w.id },
          }),
        )
      }
    }
  }

  // Stale PROCESSING executions (>2h)
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
    drift.push(
      makeRow({
        severity: "warning",
        category: ReconciliationCategory.PAYOUT,
        code: ReconciliationCode.PAYOUT_STALE_EXECUTION,
        entityId: e.id,
        entityType: "PayoutExecution",
        message: `Payout execution ${e.id.slice(0, 8)} PROCESSING for >2h — manual intervention required`,
        metadata: { transactionId: e.providerExecutionId ?? undefined },
        action: { type: "payout", id: e.withdrawalId },
      }),
    )
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
      drift.push(
        makeRow({
          severity: "warning",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.PAYOUT_FAILED_ORPHAN,
          entityId: w.id,
          entityType: "Withdrawal",
          amount: String(w.amount),
          message: `Withdrawal ${w.id.slice(0, 8)} is FAILED but has no FAILED PayoutExecution record`,
          metadata: { publisherId: w.publisherId },
          action: { type: "payout", id: w.id },
        }),
      )
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
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.PAYOUT_DUPLICATE_COMPLETED,
          entityId: withdrawalId,
          entityType: "Withdrawal",
          amount: withdrawal ? String(withdrawal.amount) : undefined,
          message: `Found ${count} COMPLETED executions for single withdrawal — potential double payout`,
          metadata: {
            duplicateCount: count,
            publisherId: withdrawal?.publisherId,
          },
          action: withdrawal ? { type: "payout", id: withdrawalId } : undefined,
        }),
      )
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
      drift.push(
        makeRow({
          severity: "critical",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.PAYOUT_LIFETIME_DRIFT,
          entityId: b.publisherId,
          entityType: "PublisherBalance",
          amount: fromScaled(actual - expected),
          message: `Publisher ${b.publisherId.slice(0, 8)} lifetimePaid (${fromScaled(actual)}) ≠ sum of COMPLETED withdrawals (${fromScaled(expected)})`,
          metadata: {
            expectedAmount: fromScaled(expected),
            actualAmount: fromScaled(actual),
            publisherId: b.publisherId,
          },
          action: { type: "publisher", id: b.publisherId },
        }),
      )
    }
  }

  // COMPLETED withdrawal with no COMPLETED execution
  const completedWithdrawals = await prisma.withdrawal.findMany({
    where: { status: "COMPLETED" },
    select: { id: true, publisherId: true, amount: true },
  })
  for (const w of completedWithdrawals) {
    if (!hasCompletedExec.has(w.id)) {
      drift.push(
        makeRow({
          severity: "warning",
          category: ReconciliationCategory.PAYOUT,
          code: ReconciliationCode.PAYOUT_COMPLETED_NO_EXECUTION,
          entityId: w.id,
          entityType: "Withdrawal",
          amount: String(w.amount),
          message: `Withdrawal ${w.id.slice(0, 8)} is COMPLETED but has no COMPLETED PayoutExecution record`,
          metadata: { publisherId: w.publisherId },
          action: { type: "payout", id: w.id },
        }),
      )
    }
  }

  return drift
}

// ─── Orchestrator ─────────────────────────────────────────────────────────

export async function runReconciliation(
  prisma: AnyPrisma,
): Promise<ReconciliationReport> {
  const startedAt = Date.now()
  const stats: DriftStats = {
    checkedWallets: 0,
    checkedSettlements: 0,
    checkedOrders: 0,
    checkedTransactions: 0,
    checkedPublishers: 0,
  }

  const [
    walletDrift,
    publisherDrift,
    settlementDrift,
    orderPaymentRecon,
    refundRecon,
    stuckFinancialOrders,
    stuckPayouts,
  ] = await Promise.all([
    checkWallets(prisma, stats),
    checkPublisherBalances(prisma, stats),
    checkSettlementDrift(prisma, stats),
    checkOrderPaymentReconciliation(prisma, stats),
    checkRefundReconciliation(prisma, stats),
    checkStuckFinancialOrders(prisma, stats),
    checkStuckPayouts(prisma, stats),
  ])

  const allIssues = [
    ...walletDrift,
    ...publisherDrift,
    ...settlementDrift,
    ...orderPaymentRecon,
    ...refundRecon,
    ...stuckFinancialOrders,
    ...stuckPayouts,
  ]

  let critical = 0
  let warning = 0
  let info = 0
  for (const issue of allIssues) {
    if (issue.severity === "critical") critical++
    else if (issue.severity === "warning") warning++
    else info++
  }

  return {
    version: 1,
    ranAt: new Date().toISOString(),
    scanDurationMs: Date.now() - startedAt,
    ok: allIssues.length === 0,
    summary: { critical, warning, info, totalIssues: allIssues.length },
    stats,
    walletDrift,
    publisherDrift,
    settlementDrift,
    orderPaymentRecon,
    refundRecon,
    stuckFinancialOrders,
    stuckPayouts,
  }
}
