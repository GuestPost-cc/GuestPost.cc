import {
  ReconciliationCategory,
  ReconciliationCode,
  runReconciliation,
  SettlementIntegrityGroup,
} from "../reconciliation-core"

function mockPrisma() {
  const txGroupBy = jest.fn().mockResolvedValue([])

  return {
    wallet: { findMany: jest.fn().mockResolvedValue([]) },
    transaction: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: txGroupBy,
    },
    publisherBalance: { findMany: jest.fn().mockResolvedValue([]) },
    settlement: { findMany: jest.fn().mockResolvedValue([]) },
    order: { findMany: jest.fn().mockResolvedValue([]) },
    withdrawal: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    payoutExecution: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    platformRevenue: { findMany: jest.fn().mockResolvedValue([]) },
  }
}

describe("ReconciliationCode enum", () => {
  it("has all expected codes", () => {
    expect(ReconciliationCode.WALLET_DRIFT).toBe("WALLET_DRIFT")
    expect(ReconciliationCode.PUBLISHER_DRIFT).toBe("PUBLISHER_DRIFT")
    expect(ReconciliationCode.SETTLEMENT_AMOUNT_MISMATCH).toBe(
      "SETTLEMENT_AMOUNT_MISMATCH",
    )
    expect(ReconciliationCode.SETTLEMENT_RELEASED_NO_TX).toBe(
      "SETTLEMENT_RELEASED_NO_TX",
    )
    expect(ReconciliationCode.SETTLEMENT_RELEASE_AMOUNT).toBe(
      "SETTLEMENT_RELEASE_AMOUNT",
    )
    expect(ReconciliationCode.SETTLEMENT_ORDER_COMPLETED_NONE).toBe(
      "SETTLEMENT_ORDER_COMPLETED_NONE",
    )
    expect(ReconciliationCode.PAYMENT_UNMATCHED).toBe("PAYMENT_UNMATCHED")
    expect(ReconciliationCode.REFUND_DUPLICATE).toBe("REFUND_DUPLICATE")
    expect(ReconciliationCode.PAYOUT_STALE_PROCESSING).toBe(
      "PAYOUT_STALE_PROCESSING",
    )
    expect(Object.keys(ReconciliationCode).length).toBeGreaterThanOrEqual(20)
  })
})

describe("ReconciliationCategory enum", () => {
  it("has all expected categories", () => {
    expect(ReconciliationCategory.WALLET).toBe("wallet")
    expect(ReconciliationCategory.PUBLISHER).toBe("publisher")
    expect(ReconciliationCategory.SETTLEMENT).toBe("settlement")
    expect(ReconciliationCategory.PAYMENT).toBe("payment")
    expect(ReconciliationCategory.REFUND).toBe("refund")
    expect(ReconciliationCategory.ORDER).toBe("order")
    expect(ReconciliationCategory.PAYOUT).toBe("payout")
  })
})

describe("SettlementIntegrityGroup enum", () => {
  it("has amount, sync, completeness", () => {
    expect(SettlementIntegrityGroup.AMOUNT).toBe("amount")
    expect(SettlementIntegrityGroup.SYNC).toBe("sync")
    expect(SettlementIntegrityGroup.COMPLETENESS).toBe("completeness")
  })
})

describe("runReconciliation with mock prisma", () => {
  it("returns ok=true with empty data", async () => {
    const prisma = mockPrisma()
    const report = await runReconciliation(prisma as any)
    expect(report.ok).toBe(true)
    expect(report.version).toBe(1)
    expect(report.summary.totalIssues).toBe(0)
    expect(report.scanDurationMs).toBeGreaterThanOrEqual(0)
    expect(report.ranAt).toBeDefined()
    expect(report.walletDrift).toEqual([])
    expect(report.publisherDrift).toEqual([])
    expect(report.settlementDrift).toEqual([])
    expect(report.orderPaymentRecon).toEqual([])
    expect(report.refundRecon).toEqual([])
    expect(report.stuckFinancialOrders).toEqual([])
    expect(report.stuckPayouts).toEqual([])
    expect(report.stats.checkedWallets).toBe(0)
    expect(report.stats.checkedSettlements).toBe(0)
    expect(report.stats.checkedOrders).toBe(0)
    expect(report.stats.checkedTransactions).toBe(0)
    expect(report.stats.checkedPublishers).toBe(0)
  })

  it("detects wallet drift", async () => {
    const prisma = mockPrisma()
    prisma.wallet.findMany.mockResolvedValue([
      {
        id: "wallet-1",
        organizationId: "org-1",
        availableBalance: "50.00",
        reservedBalance: "25.00",
      },
    ])
    prisma.transaction.groupBy.mockResolvedValue([
      { walletId: "wallet-1", type: "PURCHASE", _sum: { amount: -100.0 } },
    ])

    const report = await runReconciliation(prisma as any)
    expect(report.ok).toBe(false)
    expect(report.walletDrift.length).toBe(1)
    expect(report.walletDrift[0].code).toBe("WALLET_DRIFT")
    expect(report.walletDrift[0].severity).toBe("critical")
    expect(report.walletDrift[0].entityId).toBe("wallet-1")
  })

  it("detects settlement amount mismatch", async () => {
    const prisma = mockPrisma()
    prisma.settlement.findMany.mockResolvedValue([
      {
        id: "settle-1",
        grossAmount: "100.00",
        platformFee: "10.00",
        publisherAmount: "80.00",
        publisherId: "pub-1",
        orderId: "order-1",
        status: "RELEASED",
      },
    ])

    const report = await runReconciliation(prisma as any)
    expect(report.ok).toBe(false)
    const amountIssues = report.settlementDrift.filter(
      (r) => r.code === "SETTLEMENT_AMOUNT_MISMATCH",
    )
    expect(amountIssues.length).toBe(1)
    expect(amountIssues[0].severity).toBe("critical")
    expect(amountIssues[0].group).toBe("amount")
  })

  it("detects settlement released with no transaction (sync)", async () => {
    const prisma = mockPrisma()
    prisma.settlement.findMany.mockResolvedValue([
      {
        id: "settle-2",
        grossAmount: "100.00",
        platformFee: "10.00",
        publisherAmount: "90.00",
        publisherId: "pub-1",
        orderId: "order-1",
        status: "RELEASED",
      },
    ])

    const report = await runReconciliation(prisma as any)
    const syncIssues = report.settlementDrift.filter(
      (r) => r.code === "SETTLEMENT_RELEASED_NO_TX",
    )
    expect(syncIssues.length).toBe(1)
    expect(syncIssues[0].group).toBe("sync")
  })

  it("detects completed order with no settlements (completeness)", async () => {
    const prisma = mockPrisma()
    prisma.order.findMany.mockResolvedValue([
      {
        id: "order-complete-1",
        status: "COMPLETED",
        settlements: [],
      },
    ])

    const report = await runReconciliation(prisma as any)
    const completenessIssues = report.settlementDrift.filter(
      (r) => r.code === "SETTLEMENT_ORDER_COMPLETED_NONE",
    )
    expect(completenessIssues.length).toBe(1)
    expect(completenessIssues[0].group).toBe("completeness")
    expect(completenessIssues[0].severity).toBe("critical")
  })

  it("detects unmatched PURCHASE transactions", async () => {
    const prisma = mockPrisma()
    prisma.transaction.findMany.mockResolvedValue([
      { id: "tx-orphan", amount: -50.0, walletId: "w-1", orderId: null },
    ])

    const report = await runReconciliation(prisma as any)
    const unmatched = report.orderPaymentRecon.filter(
      (r) => r.code === "PAYMENT_UNMATCHED",
    )
    expect(unmatched.length).toBe(1)
    expect(unmatched[0].severity).toBe("critical")
  })

  it("handles negative PURCHASE convention (no false PAYMENT_AMOUNT_MISMATCH)", async () => {
    const prisma = mockPrisma()
    prisma.transaction.findMany.mockResolvedValue([
      { id: "tx-p1", amount: -250.0, walletId: "w-1", orderId: "order-paid-1" },
    ])
    prisma.order.findMany.mockResolvedValue([
      {
        id: "order-paid-1",
        amount: 250.0,
        settlements: [],
        platformRevenue: null,
        status: "PAID",
      },
    ])

    const report = await runReconciliation(prisma as any)
    const mismatch = report.orderPaymentRecon.filter(
      (r) => r.code === "PAYMENT_AMOUNT_MISMATCH",
    )
    expect(mismatch.length).toBe(0)
  })

  it("detects refunded order with no REFUND transaction", async () => {
    const prisma = mockPrisma()
    prisma.order.findMany.mockResolvedValue([
      {
        id: "order-refund-1",
        amount: 100.0,
        status: "REFUNDED",
        settlements: [],
      },
    ])

    const report = await runReconciliation(prisma as any)
    const noTxIssues = report.refundRecon.filter(
      (r) => r.code === "REFUND_NO_TRANSACTION",
    )
    expect(noTxIssues.length).toBe(1)
    expect(noTxIssues[0].severity).toBe("critical")
  })

  it("computes summary correctly", async () => {
    const prisma = mockPrisma()
    prisma.wallet.findMany.mockResolvedValue([
      {
        id: "w-1",
        organizationId: "o-1",
        availableBalance: "10.00",
        reservedBalance: "0.00",
      },
    ])
    prisma.transaction.groupBy.mockResolvedValue([
      { walletId: "w-1", type: "PURCHASE", _sum: { amount: -20.0 } },
    ])

    const report = await runReconciliation(prisma as any)
    expect(report.summary.critical).toBeGreaterThanOrEqual(1)
    expect(report.summary.warning).toBeGreaterThanOrEqual(0)
    expect(report.summary.totalIssues).toBe(
      report.summary.critical + report.summary.warning + report.summary.info,
    )
    expect(report.stats.checkedWallets).toBe(1)
  })
})
