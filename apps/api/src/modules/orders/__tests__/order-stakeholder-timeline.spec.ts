import { buildOrderStakeholderTimeline } from "../order-stakeholder-timeline"

const order = {
  id: "order-1",
  status: "REFUNDED",
  fraudFlags: [
    {
      id: "flag-1",
      createdAt: new Date("2026-08-15T00:00:00Z"),
      hold: { fraudFlagId: "flag-1" },
      resolution: null,
      finding: {
        id: "finding-1",
        outcome: "CONFIRMED_FRAUD",
        internalReason: "Internal cross-order evidence and investigator notes",
        createdAt: new Date("2026-08-15T01:00:00Z"),
      },
    },
  ],
  transactions: [
    {
      id: "refund-1",
      type: "REFUND",
      amount: "125.40",
      currency: "USD",
      createdAt: new Date("2026-08-15T02:00:00Z"),
    },
  ],
  events: [
    {
      eventType: "REFUND_ISSUED",
      metadata: {
        refundTransactionId: "refund-1",
        reason: "Emergency cancellation: the publisher completed delivery.",
      },
    },
  ],
  publisherCompensation: {
    id: "compensation-1",
    refundTransactionId: "refund-1",
    disposition: "EXACT_AMOUNT",
    amount: "80.25",
    currency: "USD",
    reason: "Publisher completed verified publication work.",
    refundTransaction: {
      reference: "force-cancel:order-1:case-1",
    },
    createdAt: new Date("2026-08-15T02:00:01Z"),
    debtRepaymentTransaction: { amount: "-20.10" },
  },
}

describe("order stakeholder timeline", () => {
  it("shows the customer exact refund without internal or publisher finance data", () => {
    const timeline = buildOrderStakeholderTimeline(order, "CUSTOMER")
    const serialized = JSON.stringify(timeline)

    expect(serialized).not.toContain("Internal cross-order")
    expect(serialized).not.toContain("refund-1")
    expect(serialized).not.toContain("finding-1")
    expect(serialized).not.toContain("compensation-1")
    expect(serialized).not.toContain("publisherCompensation")
    expect(serialized).not.toContain("debtApplied")
    expect(
      timeline.find((entry) => entry.kind === "CUSTOMER_REFUND_COMPLETED")
        ?.financialImpact,
    ).toEqual({ currency: "USD", customerRefund: "125.40" })
    expect(serialized).toContain(
      "Publisher completed verified publication work.",
    )
    expect(serialized).toContain(
      "Emergency cancellation: the publisher completed delivery.",
    )
    expect(serialized).not.toContain('"publisherCompensation":"80.25"')
  })

  it("shows the publisher only its exact compensation and net credit", () => {
    const timeline = buildOrderStakeholderTimeline(order, "PUBLISHER")
    const serialized = JSON.stringify(timeline)

    expect(serialized).not.toContain("Internal cross-order")
    expect(
      timeline.find((entry) => entry.kind === "CUSTOMER_REFUND_COMPLETED")
        ?.financialImpact,
    ).toBeUndefined()
    expect(
      timeline.find((entry) => entry.kind === "PUBLISHER_COMPENSATION_DECIDED")
        ?.financialImpact,
    ).toEqual({
      currency: "USD",
      publisherCompensation: "80.25",
      debtApplied: "20.10",
      netPublisherCredit: "60.15",
    })
    expect(
      timeline.find((entry) => entry.kind === "PUBLISHER_COMPENSATION_DECIDED")
        ?.reason,
    ).toBe("Publisher completed verified publication work.")
    expect(
      timeline.find((entry) => entry.kind === "PUBLISHER_COMPENSATION_DECIDED")
        ?.decisionReason,
    ).toBe("Emergency cancellation: the publisher completed delivery.")
  })

  it("shows a zero customer refund when compensation consumes the full order payment", () => {
    const timeline = buildOrderStakeholderTimeline(
      {
        ...order,
        transactions: [{ ...order.transactions[0], amount: "0.00" }],
      },
      "CUSTOMER",
    )
    const refund = timeline.find(
      (entry) => entry.kind === "CUSTOMER_REFUND_COMPLETED",
    )

    expect(refund?.title).toBe("No customer refund was issued")
    expect(refund?.summary).toContain("No money was returned to your wallet")
    expect(refund?.financialImpact?.customerRefund).toBe("0.00")
  })

  it("keeps Operations free of customer and publisher amounts", () => {
    const timeline = buildOrderStakeholderTimeline(order, "OPERATIONS")
    expect(timeline.every((entry) => !entry.financialImpact)).toBe(true)
    expect(JSON.stringify(timeline)).not.toContain("Internal cross-order")
  })

  it("shows Finance the internal finding and canonical financial outcomes", () => {
    const timeline = buildOrderStakeholderTimeline(order, "FINANCE")
    expect(JSON.stringify(timeline)).toContain("Internal cross-order")
    expect(
      timeline.find((entry) => entry.kind === "CUSTOMER_REFUND_COMPLETED")
        ?.financialImpact?.customerRefund,
    ).toBe("125.40")
    expect(
      timeline.find((entry) => entry.kind === "PUBLISHER_COMPENSATION_DECIDED")
        ?.financialImpact?.publisherCompensation,
    ).toBe("80.25")
  })

  it("does not claim that an unrelated terminal outcome enforced the finding", () => {
    const serialized = JSON.stringify(
      buildOrderStakeholderTimeline(order, "SUPER_ADMIN"),
    )

    expect(serialized).not.toContain("was enforced")
    expect(serialized).toContain("separate authoritative record")
  })

  it("keeps a cleared signal partial while another security hold remains", () => {
    const timeline = buildOrderStakeholderTimeline(
      {
        ...order,
        status: "PUBLISHED",
        fraudFlags: [
          {
            id: "cleared-flag",
            createdAt: new Date("2026-08-15T00:00:00Z"),
            hold: null,
            finding: null,
            resolution: {
              id: "cleared-resolution",
              reason: "Internal clearance evidence",
              evidence: { disposition: "FALSE_POSITIVE" },
              createdAt: new Date("2026-08-15T01:00:00Z"),
            },
          },
          order.fraudFlags[0],
        ],
      },
      "CUSTOMER",
    )

    expect(
      timeline.find((entry) => entry.kind === "SECURITY_REVIEW_CLEARED")
        ?.summary,
    ).toContain("another security review still blocks")
  })

  it("uses the authoritative hold projection instead of an unresolved historical flag", () => {
    const timeline = buildOrderStakeholderTimeline(
      {
        ...order,
        status: "PUBLISHED",
        fraudFlags: [
          {
            id: "cleared-flag",
            createdAt: new Date("2026-08-15T00:00:00Z"),
            hold: null,
            finding: null,
            resolution: {
              id: "cleared-resolution",
              reason: "Internal clearance evidence",
              evidence: { disposition: "FALSE_POSITIVE" },
              createdAt: new Date("2026-08-15T01:00:00Z"),
            },
          },
          {
            id: "legacy-unresolved-flag",
            createdAt: new Date("2026-08-15T00:30:00Z"),
            hold: null,
            finding: null,
            resolution: null,
          },
        ],
      },
      "CUSTOMER",
    )

    expect(
      timeline.find((entry) => entry.kind === "SECURITY_REVIEW_CLEARED")
        ?.summary,
    ).toContain("No security holds remain")
  })
})
