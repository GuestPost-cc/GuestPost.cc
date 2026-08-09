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
    depositAttempt: { findMany: jest.fn().mockResolvedValue([]) },
    paymentDispute: { findMany: jest.fn().mockResolvedValue([]) },
    paymentProviderEvent: { findMany: jest.fn().mockResolvedValue([]) },
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

  it("accepts a completed platform order with balanced platform revenue", async () => {
    const prisma = mockPrisma()
    prisma.order.findMany.mockResolvedValue([
      {
        id: "platform-complete-1",
        status: "COMPLETED",
        amount: "100.00",
        fulfillmentChannel: "PLATFORM",
        website: { ownershipType: "PLATFORM" },
        settlements: [],
        platformRevenue: {
          id: "revenue-1",
          amount: "100.00",
          platformFee: "10.00",
          netRevenue: "90.00",
          reversedAt: null,
        },
      },
    ])

    const report = await runReconciliation(prisma as any)
    expect(
      report.settlementDrift.some(
        (row) => row.entityId === "platform-complete-1",
      ),
    ).toBe(false)
  })

  it("reports the platform revenue discrepancy rather than the gross amount", async () => {
    const prisma = mockPrisma()
    prisma.order.findMany.mockResolvedValue([
      {
        id: "platform-mismatch-1",
        status: "COMPLETED",
        amount: "100.00",
        fulfillmentChannel: "PLATFORM",
        website: { ownershipType: "PLATFORM" },
        settlements: [],
        platformRevenue: {
          id: "revenue-1",
          amount: "95.00",
          platformFee: "10.00",
          netRevenue: "90.00",
          reversedAt: null,
        },
      },
    ])

    const report = await runReconciliation(prisma as any)
    const issue = report.settlementDrift.find(
      (row) => row.code === ReconciliationCode.PLATFORM_REVENUE_AMOUNT_MISMATCH,
    )

    expect(issue).toMatchObject({
      entityId: "platform-mismatch-1",
      amount: "5.00",
      metadata: {
        expectedAmount: "100.00",
        actualAmount: "95.00",
      },
    })
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

  it("detects a succeeded provider deposit without a wallet ledger row", async () => {
    const prisma = mockPrisma()
    prisma.depositAttempt.findMany.mockResolvedValue([
      {
        id: "deposit-1",
        publicReference: "GP-DP-ABCD2345",
        status: "SUCCEEDED",
        walletCredit: "25.00",
        currency: "USD",
        ledgerTransactionId: null,
        ledgerTransaction: null,
      },
    ])

    const report = await runReconciliation(prisma as any)
    expect(
      report.orderPaymentRecon.some(
        (issue) => issue.code === "DEPOSIT_SUCCEEDED_NO_LEDGER",
      ),
    ).toBe(true)
    expect(report.ok).toBe(false)
  })

  it("accepts a disputed deposit whose original wallet-credit ledger still exists", async () => {
    const prisma = mockPrisma()
    prisma.depositAttempt.findMany.mockResolvedValue([
      {
        id: "deposit-disputed",
        publicReference: "GP-DP-DISPUTED",
        status: "DISPUTED",
        walletCredit: "25.00",
        currency: "USD",
        ledgerTransactionId: "tx-deposit",
        ledgerTransaction: {
          id: "tx-deposit",
          amount: "25.00",
          currency: "USD",
          type: "DEPOSIT",
        },
        paymentDisputes: [{ status: "OPEN" }],
      },
    ])

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (issue) =>
          issue.entityId === "deposit-disputed" &&
          issue.code === ReconciliationCode.DEPOSIT_LEDGER_WITHOUT_SUCCESS,
      ),
    ).toBe(false)
  })

  it.each([
    "SUCCEEDED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
    "DISPUTED",
    "CHARGEBACK",
  ])("accepts exact processed deposit evidence after the attempt becomes %s", async (status) => {
    const prisma = mockPrisma()
    prisma.paymentProviderEvent.findMany.mockResolvedValue([
      {
        id: `deposit-inbox-${status}`,
        provider: "stripe",
        providerEventId: `evt_deposit_${status}`,
        eventType: "checkout.session.completed",
        objectId: "cs_exact",
        depositAttemptId: "attempt-exact",
        livemode: false,
        status: "PROCESSED",
        receivedAt: new Date(),
        depositAttempt: {
          id: "attempt-exact",
          walletId: "wallet-1",
          provider: "stripe",
          providerSessionId: "cs_exact",
          providerPaymentId: "pi_exact",
          walletCredit: "10.00",
          currency: "USD",
          status,
          ledgerTransactionId: "tx-exact",
          ledgerTransaction: {
            id: "tx-exact",
            walletId: "wallet-1",
            amount: "10.00",
            currency: "USD",
            type: "DEPOSIT",
            provider: "stripe",
            providerRef: "pi_exact",
          },
        },
      },
    ])

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (row) =>
          row.entityId === `deposit-inbox-${status}` &&
          row.code === ReconciliationCode.DEPOSIT_PROCESSED_EVIDENCE_MISMATCH,
      ),
    ).toBe(false)
  })

  it("classifies a historical Stripe event with no persisted mode as unverified", async () => {
    const prisma = mockPrisma()
    prisma.paymentProviderEvent.findMany.mockResolvedValue([
      {
        id: "deposit-inbox-legacy-mode",
        provider: "stripe",
        providerEventId: "evt_legacy_mode",
        eventType: "checkout.session.completed",
        objectId: "cs_exact",
        depositAttemptId: "attempt-exact",
        livemode: null,
        status: "PROCESSED",
        receivedAt: new Date(),
        depositAttempt: {
          id: "attempt-exact",
          walletId: "wallet-1",
          provider: "stripe",
          providerSessionId: "cs_exact",
          providerPaymentId: "pi_exact",
          walletCredit: "10.00",
          currency: "USD",
          status: "SUCCEEDED",
          ledgerTransactionId: "tx-exact",
          ledgerTransaction: {
            id: "tx-exact",
            walletId: "wallet-1",
            amount: "10.00",
            currency: "USD",
            type: "DEPOSIT",
            provider: "stripe",
            providerRef: "pi_exact",
          },
        },
      },
    ])

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (row) =>
          row.entityId === "deposit-inbox-legacy-mode" &&
          row.code ===
            ReconciliationCode.PAYMENT_PROVIDER_EVENT_MODE_UNVERIFIED,
      ),
    ).toBe(true)
  })

  it("detects a disputed deposit status with no matching durable case", async () => {
    const prisma = mockPrisma()
    prisma.depositAttempt.findMany.mockResolvedValue([
      {
        id: "deposit-status-orphan",
        publicReference: "DP-ORPHAN",
        status: "DISPUTED",
        walletCredit: "25.00",
        currency: "USD",
        ledgerTransactionId: "tx-deposit-orphan",
        ledgerTransaction: {
          id: "tx-deposit-orphan",
          amount: "25.00",
          currency: "USD",
          type: "DEPOSIT",
        },
        paymentDisputes: [],
      },
    ])

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (issue) =>
          issue.entityId === "deposit-status-orphan" &&
          issue.code ===
            ReconciliationCode.PAYMENT_DISPUTE_DEPOSIT_EVIDENCE_MISMATCH,
      ),
    ).toBe(true)
  })

  it("alerts on failed, stale, and quarantined deposit-success inbox rows", async () => {
    const prisma = mockPrisma()
    const staleTime = new Date(Date.now() - 16 * 60 * 1000)
    prisma.paymentProviderEvent.findMany.mockResolvedValue([
      {
        id: "deposit-inbox-failed",
        providerEventId: "evt_deposit_failed",
        eventType: "checkout.session.completed",
        objectId: "cs_failed",
        status: "FAILED",
        receivedAt: new Date(),
      },
      {
        id: "deposit-inbox-stale",
        providerEventId: "evt_deposit_stale",
        eventType: "checkout.session.async_payment_succeeded",
        objectId: "cs_stale",
        status: "PROCESSING",
        lockedAt: staleTime,
        receivedAt: staleTime,
      },
      {
        id: "deposit-inbox-quarantined",
        providerEventId: "evt_deposit_quarantined",
        eventType: "checkout.session.completed",
        objectId: "cs_quarantined",
        status: "QUARANTINED",
        receivedAt: new Date(),
      },
    ])

    const report = await runReconciliation(prisma as any)

    expect(report.orderPaymentRecon.map((row) => row.code)).toEqual(
      expect.arrayContaining([
        ReconciliationCode.DEPOSIT_INBOX_FAILED,
        ReconciliationCode.DEPOSIT_INBOX_STALE,
        ReconciliationCode.DEPOSIT_INBOX_QUARANTINED,
      ]),
    )
  })

  it("detects processed deposit events without exact attempt-ledger evidence", async () => {
    const prisma = mockPrisma()
    prisma.paymentProviderEvent.findMany.mockResolvedValue([
      {
        id: "deposit-inbox-processed-mismatch",
        provider: "stripe",
        providerEventId: "evt_deposit_processed_mismatch",
        eventType: "checkout.session.completed",
        objectId: "cs_expected",
        depositAttemptId: "attempt-1",
        livemode: false,
        status: "PROCESSED",
        receivedAt: new Date(),
        depositAttempt: {
          id: "attempt-1",
          walletId: "wallet-1",
          provider: "stripe",
          providerSessionId: "cs_different",
          providerPaymentId: "pi_1",
          walletCredit: "10.00",
          currency: "USD",
          status: "SUCCEEDED",
          ledgerTransactionId: "tx-1",
          ledgerTransaction: {
            id: "tx-1",
            walletId: "wallet-1",
            amount: "10.00",
            currency: "USD",
            type: "DEPOSIT",
            provider: "stripe",
            providerRef: "pi_1",
          },
        },
      },
    ])

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (row) =>
          row.entityId === "deposit-inbox-processed-mismatch" &&
          row.code === ReconciliationCode.DEPOSIT_PROCESSED_EVIDENCE_MISMATCH,
      ),
    ).toBe(true)
  })

  it("detects a processed dispute webhook with no durable case", async () => {
    const prisma = mockPrisma()
    prisma.paymentProviderEvent.findMany.mockResolvedValue([
      {
        id: "inbox-1",
        provider: "stripe",
        providerEventId: "evt_dispute_1",
        eventType: "charge.dispute.created",
        objectId: "dp_missing",
        paymentDisputeId: null,
        status: "PROCESSED",
      },
    ])

    const report = await runReconciliation(prisma as any)
    const issue = report.orderPaymentRecon.find(
      (row) =>
        row.code === ReconciliationCode.PAYMENT_DISPUTE_PROCESSED_NO_CASE,
    )

    expect(issue).toMatchObject({
      severity: "critical",
      entityId: "inbox-1",
      metadata: {
        providerEventId: "evt_dispute_1",
        providerDisputeId: "dp_missing",
      },
    })
  })

  it("surfaces quarantined dispute inbox evidence as critical", async () => {
    const prisma = mockPrisma()
    prisma.paymentProviderEvent.findMany.mockResolvedValue([
      {
        id: "inbox-quarantined",
        provider: "stripe",
        providerEventId: "evt_quarantined",
        eventType: "charge.dispute.created",
        objectId: "dp_quarantined",
        paymentDisputeId: null,
        status: "QUARANTINED",
      },
    ])

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (row) =>
          row.entityId === "inbox-quarantined" &&
          row.code === ReconciliationCode.PAYMENT_DISPUTE_INBOX_QUARANTINED,
      ),
    ).toBe(true)
  })

  it("detects a processed inbox row whose normalized identity differs from its mapped case", async () => {
    const prisma = mockPrisma()
    prisma.paymentDispute.findMany.mockResolvedValue([
      {
        id: "case-event-mismatch",
        provider: "stripe",
        providerDisputeId: "dp_event_mismatch",
        providerPaymentId: "pi_expected",
        providerChargeId: "ch_1",
        depositAttemptId: "attempt-1",
        amount: "10.00",
        currency: "USD",
        heldAmount: "0.00",
        shortfallAmount: "10.00",
        currentExposureAmount: "10.00",
        status: "OPEN",
        walletId: "wallet-1",
        holdTransaction: null,
        resolutionTransaction: null,
      },
    ])
    prisma.paymentProviderEvent.findMany.mockResolvedValue([
      {
        id: "inbox-event-mismatch",
        provider: "stripe",
        providerEventId: "evt_event_mismatch",
        eventType: "charge.dispute.created",
        objectId: "dp_event_mismatch",
        paymentDisputeId: "case-event-mismatch",
        depositAttemptId: "attempt-1",
        providerPaymentId: "pi_wrong",
        providerChargeId: "ch_1",
        disputeAmountMinor: 1000n,
        disputeCurrency: "USD",
        providerStatus: "needs_response",
        livemode: false,
        eventFingerprint: "a".repeat(64),
        status: "PROCESSED",
      },
    ])

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (row) =>
          row.entityId === "inbox-event-mismatch" &&
          row.code ===
            ReconciliationCode.PAYMENT_DISPUTE_EVENT_EVIDENCE_MISMATCH,
      ),
    ).toBe(true)
  })

  it("detects cumulative disputes above one originating deposit", async () => {
    const prisma = mockPrisma()
    const paymentDispute = (id: string, amount: string) => ({
      id,
      provider: "stripe",
      providerDisputeId: `dp_${id}`,
      providerPaymentId: "pi_shared",
      providerChargeId: null,
      depositAttemptId: "attempt-shared",
      depositTransactionId: "deposit-shared",
      amount,
      currency: "USD",
      heldAmount: "0.00",
      shortfallAmount: amount,
      currentExposureAmount: amount,
      status: "OPEN",
      walletId: "wallet-1",
      depositAttempt: {
        id: "attempt-shared",
        walletId: "wallet-1",
        walletCredit: "100.00",
        currency: "USD",
        provider: "stripe",
        providerPaymentId: "pi_shared",
        ledgerTransactionId: "deposit-shared",
        status: "DISPUTED",
      },
      depositTransaction: {
        id: "deposit-shared",
        walletId: "wallet-1",
        amount: "100.00",
        currency: "USD",
        type: "DEPOSIT",
        provider: "stripe",
        providerRef: "pi_shared",
      },
      holdTransaction: null,
      resolutionTransaction: null,
    })
    prisma.paymentDispute.findMany.mockResolvedValue([
      paymentDispute("one", "60.00"),
      paymentDispute("two", "60.00"),
    ])

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (row) =>
          row.entityId === "deposit-shared" &&
          row.code ===
            ReconciliationCode.PAYMENT_DISPUTE_CUMULATIVE_AMOUNT_EXCEEDED,
      ),
    ).toBe(true)
  })

  it("detects a payment-dispute ledger row with no deferred case link", async () => {
    const prisma = mockPrisma()
    prisma.transaction.findMany.mockImplementation(({ where }: any) => {
      if (where?.reference?.startsWith !== "payment-dispute:") {
        return Promise.resolve([])
      }
      return Promise.resolve([
        {
          id: "orphan-hold",
          walletId: "wallet-1",
          amount: "-10.00",
          reference: "payment-dispute:stripe:dp_orphan:hold",
          paymentDisputeHold: null,
          paymentDisputeResolution: null,
        },
      ])
    })

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (row) =>
          row.entityId === "orphan-hold" &&
          row.code === ReconciliationCode.PAYMENT_DISPUTE_ORPHAN_LEDGER,
      ),
    ).toBe(true)
  })

  it("detects an open dispute whose reservation does not equal its hold", async () => {
    const prisma = mockPrisma()
    prisma.paymentDispute.findMany.mockResolvedValue([
      {
        id: "case-open",
        provider: "stripe",
        providerDisputeId: "dp_open",
        amount: "100.00",
        currency: "USD",
        heldAmount: "60.00",
        shortfallAmount: "40.00",
        currentExposureAmount: "40.00",
        status: "OPEN",
        walletId: "wallet-1",
        holdTransaction: {
          id: "hold-wrong",
          walletId: "wallet-1",
          amount: "-50.00",
          currency: "USD",
          type: "RESERVATION",
          reference: "payment-dispute:stripe:dp_open:hold",
        },
        resolutionTransaction: null,
      },
    ])

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (row) =>
          row.code === ReconciliationCode.PAYMENT_DISPUTE_OPEN_HOLD_MISMATCH,
      ),
    ).toBe(true)
  })

  it("accepts exact WON hold and resolution evidence with zero current exposure", async () => {
    const prisma = mockPrisma()
    prisma.paymentDispute.findMany.mockResolvedValue([
      {
        id: "case-won",
        provider: "stripe",
        providerDisputeId: "dp_won",
        amount: "100.00",
        currency: "USD",
        heldAmount: "60.00",
        shortfallAmount: "40.00",
        currentExposureAmount: "0.00",
        status: "WON",
        walletId: "wallet-1",
        holdTransaction: {
          id: "hold-1",
          walletId: "wallet-1",
          amount: "-60.00",
          currency: "USD",
          type: "RESERVATION",
          reference: "payment-dispute:stripe:dp_won:hold",
        },
        resolutionTransaction: {
          id: "release-1",
          walletId: "wallet-1",
          amount: "60.00",
          currency: "USD",
          type: "RESERVATION",
          reference: "payment-dispute:stripe:dp_won:won",
        },
      },
    ])

    const report = await runReconciliation(prisma as any)
    const caseIssues = report.orderPaymentRecon.filter(
      (row) => row.entityId === "case-won",
    )

    expect(caseIssues).toEqual([])
  })

  it("detects a WON dispute missing its immutable historical hold", async () => {
    const prisma = mockPrisma()
    prisma.paymentDispute.findMany.mockResolvedValue([
      {
        id: "case-won-no-hold",
        provider: "stripe",
        providerDisputeId: "dp_won_no_hold",
        amount: "100.00",
        currency: "USD",
        heldAmount: "60.00",
        shortfallAmount: "40.00",
        currentExposureAmount: "0.00",
        status: "WON",
        walletId: "wallet-1",
        holdTransaction: null,
        resolutionTransaction: {
          id: "release-1",
          walletId: "wallet-1",
          amount: "60.00",
          currency: "USD",
          type: "RESERVATION",
          reference: "payment-dispute:stripe:dp_won_no_hold:won",
        },
      },
    ])

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (row) =>
          row.entityId === "case-won-no-hold" &&
          row.code ===
            ReconciliationCode.PAYMENT_DISPUTE_TERMINAL_HOLD_MISMATCH,
      ),
    ).toBe(true)
  })

  it("accepts LOST-before-open direct recovery without a historical hold", async () => {
    const prisma = mockPrisma()
    prisma.paymentDispute.findMany.mockResolvedValue([
      {
        id: "case-lost-direct",
        provider: "stripe",
        providerDisputeId: "dp_lost_direct",
        amount: "100.00",
        currency: "USD",
        heldAmount: "60.00",
        shortfallAmount: "40.00",
        currentExposureAmount: "40.00",
        status: "LOST",
        walletId: "wallet-1",
        holdTransaction: null,
        resolutionTransaction: {
          id: "debit-1",
          walletId: "wallet-1",
          amount: "-60.00",
          currency: "USD",
          type: "CHARGEBACK",
          reference: "payment-dispute:stripe:dp_lost_direct:lost",
        },
      },
    ])

    const report = await runReconciliation(prisma as any)

    const caseIssues = report.orderPaymentRecon.filter(
      (row) => row.entityId === "case-lost-direct",
    )
    expect(
      caseIssues.some(
        (row) =>
          row.code ===
            ReconciliationCode.PAYMENT_DISPUTE_TERMINAL_HOLD_MISMATCH ||
          row.code ===
            ReconciliationCode.PAYMENT_DISPUTE_TERMINAL_RESOLUTION_MISMATCH,
      ),
    ).toBe(false)
    expect(
      caseIssues.some(
        (row) =>
          row.code === ReconciliationCode.PAYMENT_DISPUTE_UNCOVERED_EXPOSURE,
      ),
    ).toBe(true)
  })

  it("detects current exposure that diverges from status and booked shortfall", async () => {
    const prisma = mockPrisma()
    prisma.paymentDispute.findMany.mockResolvedValue([
      {
        id: "case-exposure-drift",
        provider: "stripe",
        providerDisputeId: "dp_exposure_drift",
        amount: "100.00",
        currency: "USD",
        heldAmount: "60.00",
        shortfallAmount: "40.00",
        currentExposureAmount: "25.00",
        status: "OPEN",
        walletId: "wallet-1",
        holdTransaction: {
          id: "hold-1",
          walletId: "wallet-1",
          amount: "-60.00",
          currency: "USD",
          type: "RESERVATION",
          reference: "payment-dispute:stripe:dp_exposure_drift:hold",
        },
        resolutionTransaction: null,
      },
    ])

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (row) =>
          row.entityId === "case-exposure-drift" &&
          row.code === ReconciliationCode.PAYMENT_DISPUTE_EXPOSURE_MISMATCH,
      ),
    ).toBe(true)
  })

  it("accepts zero-held cases only when they have no zero-value ledger rows", async () => {
    const prisma = mockPrisma()
    prisma.paymentDispute.findMany.mockResolvedValue([
      {
        id: "case-open-no-funds",
        provider: "stripe",
        providerDisputeId: "dp_open_no_funds",
        amount: "100.00",
        currency: "USD",
        heldAmount: "0.00",
        shortfallAmount: "100.00",
        currentExposureAmount: "100.00",
        status: "OPEN",
        walletId: "wallet-1",
        holdTransaction: null,
        resolutionTransaction: null,
      },
      {
        id: "case-won-before-open",
        provider: "stripe",
        providerDisputeId: "dp_won_before_open",
        amount: "100.00",
        currency: "USD",
        heldAmount: "0.00",
        shortfallAmount: "100.00",
        currentExposureAmount: "0.00",
        status: "WON",
        walletId: "wallet-1",
        holdTransaction: null,
        resolutionTransaction: null,
      },
      {
        id: "case-lost-no-funds",
        provider: "stripe",
        providerDisputeId: "dp_lost_no_funds",
        amount: "100.00",
        currency: "USD",
        heldAmount: "0.00",
        shortfallAmount: "100.00",
        currentExposureAmount: "100.00",
        status: "LOST",
        walletId: "wallet-1",
        holdTransaction: null,
        resolutionTransaction: null,
      },
    ])

    const report = await runReconciliation(prisma as any)
    const zeroHeldCaseIds = new Set([
      "case-open-no-funds",
      "case-won-before-open",
      "case-lost-no-funds",
    ])

    const zeroHeldEvidenceIssues = report.orderPaymentRecon.filter(
      (row) =>
        zeroHeldCaseIds.has(row.entityId) &&
        [
          ReconciliationCode.PAYMENT_DISPUTE_OPEN_HOLD_MISMATCH,
          ReconciliationCode.PAYMENT_DISPUTE_TERMINAL_HOLD_MISMATCH,
          ReconciliationCode.PAYMENT_DISPUTE_TERMINAL_RESOLUTION_MISMATCH,
        ].includes(row.code),
    )
    expect(zeroHeldEvidenceIssues).toEqual([])
  })

  it("flags a zero-value ledger row attached to a zero-held case", async () => {
    const prisma = mockPrisma()
    prisma.paymentDispute.findMany.mockResolvedValue([
      {
        id: "case-zero-ledger",
        provider: "stripe",
        providerDisputeId: "dp_zero_ledger",
        amount: "100.00",
        currency: "USD",
        heldAmount: "0.00",
        shortfallAmount: "100.00",
        currentExposureAmount: "100.00",
        status: "OPEN",
        walletId: "wallet-1",
        holdTransaction: {
          id: "hold-zero",
          walletId: "wallet-1",
          amount: "0.00",
          currency: "USD",
          type: "RESERVATION",
          reference: "payment-dispute:stripe:dp_zero_ledger:hold",
        },
        resolutionTransaction: null,
      },
    ])

    const report = await runReconciliation(prisma as any)

    expect(
      report.orderPaymentRecon.some(
        (row) =>
          row.entityId === "case-zero-ledger" &&
          row.code === ReconciliationCode.PAYMENT_DISPUTE_OPEN_HOLD_MISMATCH,
      ),
    ).toBe(true)
  })

  it("surfaces every legacy wallet-backed withdrawal as critical evidence debt", async () => {
    const prisma = mockPrisma()
    prisma.transaction.findMany.mockImplementation(({ where }: any) => {
      if (where?.type !== "WITHDRAWAL") return Promise.resolve([])
      return Promise.resolve([
        {
          id: "wallet-withdrawal-1",
          type: "WITHDRAWAL",
          walletId: "wallet-1",
          amount: "-75.00",
          reference: "withdrawal:legacy-1",
          createdAt: new Date(),
        },
      ])
    })

    const report = await runReconciliation(prisma as any)
    const issue = report.orderPaymentRecon.find(
      (row) =>
        row.code === ReconciliationCode.WALLET_WITHDRAWAL_WITHOUT_EXECUTION,
    )

    expect(issue).toMatchObject({
      severity: "critical",
      entityId: "wallet-withdrawal-1",
      metadata: {
        transactionId: "wallet-withdrawal-1",
        walletId: "wallet-1",
      },
    })
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

  it("flags completed payouts with missing canonical evidence", async () => {
    const prisma = mockPrisma()
    prisma.payoutExecution.findMany.mockImplementation(async (args: any) =>
      args?.where?.status === "COMPLETED"
        ? [
            {
              id: "execution-bad-evidence",
              completionSource: "PROVIDER_RESPONSE",
              completionEvidenceRef: null,
              completionEvidenceAt: null,
              completedAt: new Date(),
              completionActorUserId: null,
              completionWebhookEventId: null,
              bankTraceReference: null,
              providerExecutionId: "wise-1",
              providerPayoutId: null,
              provider: { name: "wise" },
              withdrawal: {
                id: "withdrawal-1",
                status: "COMPLETED",
                publisherId: "publisher-1",
                amount: "100.00",
              },
            },
          ]
        : [],
    )

    const report = await runReconciliation(prisma as any)

    expect(
      report.stuckPayouts.some(
        (row) =>
          row.code === ReconciliationCode.PAYOUT_COMPLETION_EVIDENCE_INVALID,
      ),
    ).toBe(true)
  })

  it("flags every legacy-unverified payout completion for Finance substantiation", async () => {
    const prisma = mockPrisma()
    prisma.payoutExecution.findMany.mockImplementation(async (args: any) =>
      args?.where?.status === "COMPLETED"
        ? [
            {
              id: "execution-legacy",
              completionSource: "LEGACY_UNVERIFIED",
              completionEvidenceRef: "po_legacy",
              completionEvidenceAt: null,
              completedAt: new Date(),
              completionActorUserId: null,
              completionWebhookEventId: null,
              bankTraceReference: null,
              providerExecutionId: "po_legacy",
              providerPayoutId: "po_legacy",
              provider: { name: "stripe_connect" },
              withdrawal: {
                id: "withdrawal-legacy-completed",
                status: "COMPLETED",
                publisherId: "publisher-1",
                amount: "100.00",
              },
            },
          ]
        : [],
    )

    const report = await runReconciliation(prisma as any)

    expect(
      report.stuckPayouts.find(
        (row) =>
          row.code === ReconciliationCode.PAYOUT_LEGACY_COMPLETION_UNVERIFIED,
      ),
    ).toMatchObject({
      severity: "critical",
      entityId: "execution-legacy",
      metadata: { completionSource: "LEGACY_UNVERIFIED" },
    })
  })

  it("distinguishes stale recoverable claims from expired review-only claims", async () => {
    const prisma = mockPrisma()
    prisma.payoutExecution.findMany.mockImplementation(async (args: any) => {
      if (Array.isArray(args?.where?.OR)) {
        return [
          {
            id: "execution-stale-claim",
            withdrawalId: "withdrawal-stale",
            stage: "BANK_PAYOUT_SEND_CLAIMED",
            updatedAt: new Date(Date.now() - 20 * 60 * 1000),
            providerExecutionId: "tr_1",
            providerPayoutId: null,
          },
          {
            id: "execution-expired-claim",
            withdrawalId: "withdrawal-expired",
            stage: "BANK_PAYOUT_CLAIM_EXPIRED",
            updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
            providerExecutionId: "tr_2",
            providerPayoutId: null,
          },
        ]
      }
      return []
    })

    const report = await runReconciliation(prisma as any)

    expect(
      report.stuckPayouts.find(
        (row) => row.code === ReconciliationCode.PAYOUT_CLAIM_STALE,
      ),
    ).toMatchObject({
      severity: "warning",
      entityId: "execution-stale-claim",
    })
    expect(
      report.stuckPayouts.find(
        (row) => row.code === ReconciliationCode.PAYOUT_CLAIM_EXPIRED,
      ),
    ).toMatchObject({
      severity: "critical",
      entityId: "execution-expired-claim",
    })
  })

  it("flags pending withdrawals with missing requester provenance", async () => {
    const prisma = mockPrisma()
    prisma.withdrawal.findMany.mockImplementation(async (args: any) =>
      args?.where?.requestedBy === null
        ? [
            {
              id: "withdrawal-legacy",
              publisherId: "publisher-1",
              amount: "25.00",
              status: "PENDING",
            },
          ]
        : [],
    )

    const report = await runReconciliation(prisma as any)

    expect(
      report.stuckPayouts.some(
        (row) =>
          row.code === ReconciliationCode.PAYOUT_REQUESTER_PROVENANCE_MISSING,
      ),
    ).toBe(true)
  })

  it("flags quarantined payout webhooks as critical", async () => {
    const prisma = {
      ...mockPrisma(),
      payoutWebhookEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "webhook-quarantined",
            provider: "wise",
            providerExecutionId: "transfer-1",
          },
        ]),
      },
    }

    const report = await runReconciliation(prisma as any)
    const issue = report.stuckPayouts.find(
      (row) => row.code === ReconciliationCode.PAYOUT_WEBHOOK_QUARANTINED,
    )

    expect(issue?.severity).toBe("critical")
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
