import {
  groupReconciliationOrderFindings,
  persistReconciliationCases,
} from "../reconciliation-case-core"

describe("groupReconciliationOrderFindings", () => {
  it("groups related order findings and excludes non-order/provider details", () => {
    const grouped = groupReconciliationOrderFindings({
      walletDrift: [
        {
          id: "wallet-drift",
          severity: "critical",
          category: "wallet",
          code: "WALLET_DRIFT",
          entityId: "wallet-1",
          entityType: "Wallet",
          message: "not persisted",
          detectedAt: "2026-09-30T00:00:00.000Z",
          metadata: { walletId: "wallet-1" },
        },
      ],
      refundRecon: [
        {
          id: "refund-a",
          severity: "critical",
          category: "refund",
          code: "REFUND_DUPLICATE",
          entityId: "order-1",
          entityType: "Order",
          message: "not persisted",
          detectedAt: "2026-09-30T00:00:00.000Z",
          action: { type: "order", id: "order-1" },
          metadata: {
            orderId: "order-1",
            transactionId: "refund-1",
            providerStatus: "must-not-be-persisted",
          },
        },
        {
          id: "refund-b",
          severity: "warning",
          category: "refund",
          code: "REFUND_PARTIAL",
          entityId: "order-1",
          entityType: "Order",
          message: "not persisted",
          detectedAt: "2026-09-30T00:00:00.000Z",
          metadata: { orderId: "order-1", actualAmount: "5.00" },
        },
      ],
      publisherDrift: [],
      settlementDrift: [],
      orderPaymentRecon: [],
      stuckFinancialOrders: [],
      stuckPayouts: [],
    } as any)

    expect([...grouped.keys()]).toEqual(["order-1"])
    expect(grouped.get("order-1")).toEqual([
      expect.objectContaining({ code: "REFUND_DUPLICATE", orderId: "order-1" }),
      expect.objectContaining({ code: "REFUND_PARTIAL", orderId: "order-1" }),
    ])
    expect(grouped.get("order-1")?.[0].metadata).not.toHaveProperty(
      "providerStatus",
    )
  })
})

describe("persistReconciliationCases", () => {
  it("deduplicates unchanged evidence across scans", async () => {
    let currentFingerprint: string | null = null
    let scanNumber = 0
    const snapshotFingerprints = new Set<string>()
    const prisma = {
      $transaction: (run: (tx: any) => unknown) =>
        run({
          reconciliationScan: {
            create: async () => ({ id: `scan-${++scanNumber}` }),
          },
          reconciliationCase: {
            upsert: async ({ create, update }: any) => {
              currentFingerprint ??= create.currentFingerprint
              if (update) {
                expect(update.currentFingerprint).toBe(currentFingerprint)
                expect(update.version).toEqual({ increment: 1 })
              }
              return { id: "case-1" }
            },
          },
          reconciliationCaseSnapshot: {
            createMany: async ({ data, skipDuplicates }: any) => {
              expect(skipDuplicates).toBe(true)
              for (const snapshot of data) {
                snapshotFingerprints.add(
                  `${snapshot.caseId}:${snapshot.evidenceFingerprint}`,
                )
              }
              return { count: snapshotFingerprints.size }
            },
          },
        }),
    }
    const report = {
      version: 1,
      ranAt: "2026-09-30T00:00:00.000Z",
      walletDrift: [],
      publisherDrift: [],
      settlementDrift: [],
      orderPaymentRecon: [],
      refundRecon: [
        {
          id: "refund-1",
          severity: "warning",
          category: "refund",
          code: "REFUND_PARTIAL",
          entityId: "order-1",
          entityType: "Order",
          detectedAt: "2026-09-30T00:00:00.000Z",
          metadata: { orderId: "order-1" },
        },
      ],
      stuckFinancialOrders: [],
      stuckPayouts: [],
    } as any

    await persistReconciliationCases(prisma, report, { detector: "admin" })
    await persistReconciliationCases(prisma, report, { detector: "worker" })

    expect(snapshotFingerprints.size).toBe(1)
  })
})
