import { evaluateSettlementReleaseEvidence } from "../settlement-release-evidence"

const exactEvidence = () => ({
  settlement: {
    id: "settlement-1",
    orderId: "order-1",
    publisherId: "publisher-1",
    publisherAmount: "90.00",
    currency: "USD",
    status: "RELEASED",
    settledAt: new Date("2026-08-12T00:00:00.000Z"),
  },
  transactions: [
    {
      type: "SETTLEMENT_RELEASE",
      settlementId: "settlement-1",
      orderId: "order-1",
      publisherId: "publisher-1",
      amount: "90.00",
      currency: "USD",
      walletId: null,
      provider: null,
      providerRef: null,
    },
  ],
  events: [
    {
      eventType: "SETTLEMENT_RELEASED",
      settlementId: "settlement-1",
      orderId: "order-1",
    },
  ],
})

describe("evaluateSettlementReleaseEvidence", () => {
  it("accepts one exact released state, ledger row, and event", () => {
    expect(evaluateSettlementReleaseEvidence(exactEvidence())).toMatchObject({
      valid: true,
      stateValid: true,
      ledgerValid: true,
      eventValid: true,
      issues: [],
    })
  })

  it("rejects an unreleased settlement with no release timestamp", () => {
    const input = exactEvidence()
    input.settlement.status = "ADMIN_APPROVED"
    input.settlement.settledAt = null as any

    const result = evaluateSettlementReleaseEvidence(input)

    expect(result.stateValid).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "SETTLEMENT_NOT_RELEASED",
        "SETTLEMENT_SETTLED_AT_MISSING",
      ]),
    )
  })

  it("rejects duplicate ledger rows and a mismatched event", () => {
    const input = exactEvidence()
    input.transactions.push({ ...input.transactions[0] })
    input.events[0].orderId = "other-order"

    const result = evaluateSettlementReleaseEvidence(input)

    expect(result.ledgerValid).toBe(false)
    expect(result.eventValid).toBe(false)
    expect(result.valid).toBe(false)
  })
})
