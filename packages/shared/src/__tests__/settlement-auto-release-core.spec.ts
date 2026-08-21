import {
  AUTO_RELEASE_RECHECK_MAX_AGE_MS,
  isFreshSuccessfulAutoReleaseEvidence,
  runSettlementAutoRelease,
} from "../settlement-auto-release-core"

const RELEASE_AT = new Date("2026-08-02T12:00:00.000Z")

function successfulEvidence(over: Record<string, unknown> = {}) {
  return {
    checkedAt: new Date(RELEASE_AT.getTime() - 60_000),
    createdAt: new Date(RELEASE_AT.getTime() - 59_000),
    httpStatus: 200,
    linkFound: true,
    targetUrlMatched: true,
    anchorFound: true,
    ...over,
  }
}

function dueSettlement(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    orderId: "o1",
    publisherId: "p1",
    publisherAmount: "80.00",
    currency: "USD",
    version: 2,
    status: "CUSTOMER_APPROVED",
    releasePolicy: "AUTO",
    order: {
      id: "o1",
      organizationId: "org1",
      amount: "100.00",
      version: 7,
    },
    ...over,
  }
}

function makeTx() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    order: {
      findUnique: jest.fn().mockResolvedValue({
        id: "o1",
        organizationId: "org1",
        customerId: "customer1",
        status: "DELIVERED",
        version: 7,
        currency: "USD",
        paymentStatus: "PAID",
        verifyMethod: "AUTO",
        amount: "100.00",
        activeDeliveryVersionId: "v1",
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    orderDeliveryVersion: {
      findUnique: jest.fn().mockResolvedValue({
        id: "v1",
        orderId: "o1",
        normalizedUrl: "https://publisher.example/article",
        supersededByVersion: null,
        verificationStatus: "VERIFIED",
        interventionStatus: "NONE",
      }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    orderDispute: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    revision: { findFirst: jest.fn().mockResolvedValue(null) },
    orderCancellationRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    deliveryFraudFlag: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    deliveryFraudHold: {
      count: jest.fn().mockResolvedValue(0),
    },
    deliveryVerificationEvidence: {
      findFirst: jest.fn().mockResolvedValue(successfulEvidence()),
    },
    settlement: {
      findUnique: jest.fn().mockResolvedValue(dueSettlement()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    publisher: {
      findUnique: jest.fn().mockResolvedValue({ tier: "VERIFIED" }),
    },
    paymentDispute: { count: jest.fn().mockResolvedValue(0) },
    settlementApproval: { upsert: jest.fn().mockResolvedValue({}) },
    publisherBalance: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    transaction: { create: jest.fn().mockResolvedValue({}) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  }
}

function makePrisma(tx: ReturnType<typeof makeTx>) {
  return {
    settlement: {
      findMany: jest.fn().mockResolvedValue([dueSettlement()]),
    },
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(tx)),
  }
}

describe("runSettlementAutoRelease canonical money boundary", () => {
  it("re-checks all live blockers before approval or money writes", async () => {
    const tx = makeTx()
    tx.deliveryFraudHold.count.mockResolvedValue(1)
    const prisma = makePrisma(tx)

    const result = await runSettlementAutoRelease(prisma as any, {
      now: RELEASE_AT,
    })

    expect(result).toMatchObject({
      scanned: 1,
      released: 0,
      skipped: 1,
      freshnessBlocked: 0,
    })
    expect(tx.settlementApproval.upsert).not.toHaveBeenCalled()
    expect(tx.settlement.updateMany).not.toHaveBeenCalled()
    expect(tx.publisherBalance.create).not.toHaveBeenCalled()
    expect(tx.transaction.create).not.toHaveBeenCalled()
  })

  it("treats an order CAS loss as an error so no later balance or ledger write can run", async () => {
    const tx = makeTx()
    tx.order.updateMany.mockResolvedValue({ count: 0 })
    const prisma = makePrisma(tx)
    const onError = jest.fn()

    const result = await runSettlementAutoRelease(prisma as any, {
      now: RELEASE_AT,
      onError,
    })

    expect(result).toMatchObject({
      scanned: 1,
      released: 0,
      skipped: 1,
      freshnessBlocked: 0,
    })
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ name: "SettlementAutoReleaseRaceError" }),
      "s1",
    )
    expect(tx.publisherBalance.create).not.toHaveBeenCalled()
    expect(tx.publisherBalance.updateMany).not.toHaveBeenCalled()
    expect(tx.transaction.create).not.toHaveBeenCalled()
  })

  it.each([
    [
      "non-USD settlement",
      (tx: ReturnType<typeof makeTx>) =>
        tx.settlement.findUnique.mockResolvedValue(
          dueSettlement({ currency: "EUR" }),
        ),
    ],
    [
      "non-USD publisher balance",
      (tx: ReturnType<typeof makeTx>) =>
        tx.$queryRaw.mockImplementation(
          async (strings: TemplateStringsArray) =>
            strings.join("").includes("PublisherBalance")
              ? [
                  {
                    publisherId: "p1",
                    version: 1,
                    currency: "GBP",
                    debtBalance: 0,
                  },
                ]
              : [],
        ),
    ],
  ])("fails closed on %s", async (_label, arrange) => {
    const tx = makeTx()
    arrange(tx)
    const prisma = makePrisma(tx)
    const onError = jest.fn()

    const result = await runSettlementAutoRelease(prisma as any, {
      now: RELEASE_AT,
      onError,
    })

    expect(result).toMatchObject({ scanned: 1, released: 0, skipped: 1 })
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/currency/i) }),
      "s1",
    )
    expect(tx.publisherBalance.create).not.toHaveBeenCalled()
    expect(tx.publisherBalance.updateMany).not.toHaveBeenCalled()
    expect(tx.transaction.create).not.toHaveBeenCalled()
  })

  it("writes only explicit USD financial rows on the happy path", async () => {
    const tx = makeTx()
    const prisma = makePrisma(tx)

    const result = await runSettlementAutoRelease(prisma as any, {
      now: RELEASE_AT,
    })

    expect(result).toMatchObject({ scanned: 1, released: 1, skipped: 0 })
    expect(tx.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currency: "USD" }),
      }),
    )
    expect(tx.publisherBalance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ currency: "USD" }),
    })
    expect(tx.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        currency: "USD",
        type: "SETTLEMENT_RELEASE",
      }),
    })
  })

  it.each([
    [
      "a customer chargeback",
      (tx: ReturnType<typeof makeTx>) =>
        tx.paymentDispute.count.mockResolvedValue(1),
    ],
    [
      "a publisher downgrade",
      (tx: ReturnType<typeof makeTx>) =>
        tx.publisher.findUnique.mockResolvedValue({ tier: "NEW" }),
    ],
  ])("re-checks %s and leaves the settlement for explicit Finance review", async (_label, arrange) => {
    const tx = makeTx()
    arrange(tx)
    const prisma = makePrisma(tx)

    const result = await runSettlementAutoRelease(prisma as any, {
      now: RELEASE_AT,
    })

    expect(result).toMatchObject({
      scanned: 1,
      released: 0,
      skipped: 1,
      freshnessBlocked: 0,
      riskBlocked: 1,
    })
    expect(tx.settlementApproval.upsert).not.toHaveBeenCalled()
    expect(tx.settlement.updateMany).not.toHaveBeenCalled()
    expect(tx.order.updateMany).not.toHaveBeenCalled()
    expect(tx.publisherBalance.create).not.toHaveBeenCalled()
    expect(tx.transaction.create).not.toHaveBeenCalled()
  })

  it("retries a trusted serialization failure with a bounded fresh transaction", async () => {
    const tx = makeTx()
    const prisma = makePrisma(tx)
    prisma.$transaction
      .mockRejectedValueOnce({ code: "P2034" })
      .mockImplementationOnce(async (fn: any) => fn(tx))

    const result = await runSettlementAutoRelease(prisma as any, {
      now: RELEASE_AT,
    })

    expect(result).toMatchObject({ scanned: 1, released: 1, skipped: 0 })
    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
  })

  it("reloads customer risk on a serialization retry instead of reusing a clean result", async () => {
    const tx = makeTx()
    const prisma = makePrisma(tx)
    prisma.$transaction
      .mockRejectedValueOnce({ code: "P2034" })
      .mockImplementationOnce(async (fn: any) => {
        tx.paymentDispute.count.mockResolvedValue(1)
        return fn(tx)
      })

    const result = await runSettlementAutoRelease(prisma as any, {
      now: RELEASE_AT,
    })

    expect(result).toMatchObject({
      scanned: 1,
      released: 0,
      skipped: 1,
      riskBlocked: 1,
    })
    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
    expect(tx.settlementApproval.upsert).not.toHaveBeenCalled()
    expect(tx.transaction.create).not.toHaveBeenCalled()
  })

  it("nets debt in exact cents without binary floating-point arithmetic", async () => {
    const tx = makeTx()
    tx.settlement.findUnique.mockResolvedValue(
      dueSettlement({ publisherAmount: "0.10" }),
    )
    let balanceReads = 0
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (!strings.join("").includes("PublisherBalance")) return []
      balanceReads++
      return balanceReads === 1
        ? [
            {
              publisherId: "p1",
              version: 1,
              currency: "USD",
              debtBalance: "0.03",
            },
          ]
        : [
            {
              withdrawableBalance: "0.07",
              debtBalance: "0.00",
            },
          ]
    })
    const prisma = makePrisma(tx)

    const result = await runSettlementAutoRelease(prisma as any, {
      now: RELEASE_AT,
    })

    expect(result.released).toBe(1)
    expect(tx.publisherBalance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          withdrawableBalance: { increment: "0.07" },
          debtBalance: { decrement: "0.03" },
          lifetimeEarnings: { increment: "0.10" },
        }),
      }),
    )
    expect(tx.transaction.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ amount: "0.10" }),
      }),
    )
    expect(tx.transaction.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ amount: "-0.03" }),
      }),
    )
  })

  it.each([
    ["missing", null],
    [
      "stale",
      successfulEvidence({
        checkedAt: new Date(
          RELEASE_AT.getTime() - AUTO_RELEASE_RECHECK_MAX_AGE_MS - 1,
        ),
      }),
    ],
    [
      "future-dated",
      successfulEvidence({
        checkedAt: new Date(RELEASE_AT.getTime() + 1),
      }),
    ],
    ["HTTP-failed", successfulEvidence({ httpStatus: 500 })],
    ["link-missing", successfulEvidence({ linkFound: false })],
    ["target-mismatched", successfulEvidence({ targetUrlMatched: false })],
    ["anchor-missing", successfulEvidence({ anchorFound: false })],
  ])("fails closed before approval or money writes when the newest recheck is %s", async (_label, evidence) => {
    const tx = makeTx()
    tx.deliveryVerificationEvidence.findFirst.mockResolvedValue(evidence)
    const prisma = makePrisma(tx)

    const result = await runSettlementAutoRelease(prisma as any, {
      now: RELEASE_AT,
    })

    expect(result).toMatchObject({
      scanned: 1,
      released: 0,
      skipped: 1,
      freshnessBlocked: 1,
    })
    expect(tx.deliveryVerificationEvidence.findFirst).toHaveBeenCalledWith({
      where: { deliveryVersionId: "v1" },
      orderBy: [{ checkedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: {
        checkedAt: true,
        createdAt: true,
        httpStatus: true,
        linkFound: true,
        targetUrlMatched: true,
        anchorFound: true,
      },
    })
    expect(tx.settlementApproval.upsert).not.toHaveBeenCalled()
    expect(tx.settlement.updateMany).not.toHaveBeenCalled()
    expect(tx.publisherBalance.create).not.toHaveBeenCalled()
    expect(tx.publisherBalance.updateMany).not.toHaveBeenCalled()
    expect(tx.transaction.create).not.toHaveBeenCalled()
  })

  it("accepts an exact twelve-hour-old successful observation", () => {
    expect(
      isFreshSuccessfulAutoReleaseEvidence(
        successfulEvidence({
          checkedAt: new Date(
            RELEASE_AT.getTime() - AUTO_RELEASE_RECHECK_MAX_AGE_MS,
          ),
        }),
        RELEASE_AT,
      ),
    ).toBe(true)
  })
})
