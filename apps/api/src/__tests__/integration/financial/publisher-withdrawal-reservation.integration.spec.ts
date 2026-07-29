import { makeOrganization, makePublisher, makeUser } from "../factories"
import { createTestDatabase, type TestDatabase } from "../helpers/test-db"

// This spec exercises the reservation/approval service boundary only. Avoid
// loading the unrelated external-send implementation (and its provider-runtime
// dependencies) when PublisherPayoutsService is required below.
jest.mock(
  "../../../modules/publisher-payouts/payout-execution.service",
  () => ({ PayoutExecutionService: class PayoutExecutionService {} }),
)

interface WithdrawalFixture {
  publisherId: string
  ownerId: string
  financeId: string
  payoutMethodId: string
  amount: number
}

describe("[INTEGRATION] Financial — publisher withdrawal reservation", () => {
  let database: TestDatabase | undefined
  let previousDatabaseUrl: string | undefined
  let previousHoldDays: string | undefined
  let previousLegacyMethods: string | undefined
  let prisma: any
  let payouts: any
  let queue: { addJob: jest.Mock }

  beforeAll(async () => {
    database = await createTestDatabase()
    previousDatabaseUrl = process.env.DATABASE_URL
    previousHoldDays = process.env.WITHDRAWAL_HOLD_DAYS
    previousLegacyMethods = process.env.PAYOUT_LEGACY_METHODS_ENABLED
    process.env.DATABASE_URL = database.url
    process.env.WITHDRAWAL_HOLD_DAYS = "0"
    process.env.PAYOUT_LEGACY_METHODS_ENABLED = "true"

    const { PrismaService } = require("../../../common/prisma.service") as any
    const { AuditService } =
      require("../../../modules/audit/audit.service") as any
    const { PublisherPayoutsService } =
      require("../../../modules/publisher-payouts/publisher-payouts.service") as any

    prisma = new PrismaService()
    await prisma.$connect()
    queue = { addJob: jest.fn().mockResolvedValue(undefined) }
    payouts = new PublisherPayoutsService(
      prisma,
      new AuditService(prisma),
      queue,
      {},
      {},
    )
  })

  afterAll(async () => {
    try {
      await prisma?.$disconnect()
    } finally {
      await database?.teardown()
      if (previousDatabaseUrl !== undefined) {
        process.env.DATABASE_URL = previousDatabaseUrl
      } else {
        delete process.env.DATABASE_URL
      }
      if (previousHoldDays !== undefined) {
        process.env.WITHDRAWAL_HOLD_DAYS = previousHoldDays
      } else {
        delete process.env.WITHDRAWAL_HOLD_DAYS
      }
      if (previousLegacyMethods !== undefined) {
        process.env.PAYOUT_LEGACY_METHODS_ENABLED = previousLegacyMethods
      } else {
        delete process.env.PAYOUT_LEGACY_METHODS_ENABLED
      }
    }
  })

  async function makeWithdrawalFixture(
    amount = 100,
  ): Promise<WithdrawalFixture> {
    const organization = await makeOrganization(prisma)
    const publisher = await makePublisher(prisma, {
      organizationId: organization.id,
    })
    const owner = await makeUser(prisma, { userType: "PUBLISHER" })
    const finance = await makeUser(prisma, { userType: "STAFF" })
    await prisma.publisherMembership.create({
      data: {
        publisherId: publisher.id,
        userId: owner.id,
        role: "PUBLISHER_OWNER",
      },
    })
    await prisma.staffMembership.create({
      data: {
        userId: finance.id,
        role: "FINANCE",
      },
    })
    await prisma.publisherBalance.create({
      data: {
        publisherId: publisher.id,
        withdrawableBalance: amount,
        lifetimeEarnings: amount,
        allocationCutoverAt: new Date(),
        allocationCarryForward: amount,
        allocationCarryForwardUsed: 0,
      },
    })
    const payoutMethod = await prisma.payoutMethod.create({
      data: {
        publisherId: publisher.id,
        type: "bank_transfer",
        label: "Integration bank account",
        details: "encrypted-test-placeholder",
        encryptionKeyVersion: 1,
        isDefault: true,
        isActive: true,
      },
    })
    return {
      publisherId: publisher.id,
      ownerId: owner.id,
      financeId: finance.id,
      payoutMethodId: payoutMethod.id,
      amount,
    }
  }

  async function request(
    fixture: WithdrawalFixture,
    amount: number,
    idempotencyKey: string,
  ) {
    return payouts.requestWithdrawal(
      fixture.publisherId,
      amount,
      "bank_transfer",
      fixture.ownerId,
      idempotencyKey,
      fixture.payoutMethodId,
    )
  }

  it("reserves the exact full balance and approves without checking it twice", async () => {
    const fixture = await makeWithdrawalFixture(100)
    const withdrawal = await request(fixture, 100, "full-balance-request")

    const [reservedBalance, allocations, withdrawalLedger] = await Promise.all([
      prisma.publisherBalance.findUniqueOrThrow({
        where: { publisherId: fixture.publisherId },
      }),
      prisma.withdrawalAllocation.findMany({
        where: { withdrawalId: withdrawal.id },
      }),
      prisma.transaction.findMany({
        where: {
          publisherId: fixture.publisherId,
          type: "WITHDRAWAL",
        },
      }),
    ])
    expect(reservedBalance.withdrawableBalance.toString()).toBe("0")
    expect(reservedBalance.allocationCarryForwardUsed.toString()).toBe("100")
    expect(reservedBalance.version).toBe(1)
    expect(allocations).toHaveLength(1)
    expect(allocations[0]).toMatchObject({
      sourceType: "CARRY_FORWARD",
      currency: "USD",
      releasedAt: null,
    })
    expect(allocations[0].amount.toString()).toBe("100")
    expect(withdrawalLedger).toHaveLength(1)
    expect(withdrawalLedger[0].amount.toString()).toBe("-100")

    const approved = await payouts.approveWithdrawal(
      withdrawal.id,
      fixture.financeId,
    )

    expect(approved).toMatchObject({
      id: withdrawal.id,
      status: "APPROVED",
      approvedBy: fixture.financeId,
    })
    const [afterApproval, persistedAllocations, ledgersAfterApproval] =
      await Promise.all([
        prisma.publisherBalance.findUniqueOrThrow({
          where: { publisherId: fixture.publisherId },
        }),
        prisma.withdrawalAllocation.findMany({
          where: { withdrawalId: withdrawal.id },
        }),
        prisma.transaction.findMany({
          where: {
            publisherId: fixture.publisherId,
            type: { in: ["WITHDRAWAL", "WITHDRAWAL_REVERSAL"] },
          },
        }),
      ])
    expect(afterApproval.withdrawableBalance.toString()).toBe("0")
    expect(afterApproval.lifetimePaid.toString()).toBe("0")
    expect(afterApproval.version).toBe(1)
    expect(persistedAllocations).toHaveLength(1)
    expect(persistedAllocations[0].releasedAt).toBeNull()
    expect(ledgersAfterApproval).toHaveLength(1)
  }, 30_000)

  it("serializes distinct-key requests so concurrent callers cannot over-reserve", async () => {
    const fixture = await makeWithdrawalFixture(100)

    const outcomes = await Promise.allSettled([
      request(fixture, 60, "concurrent-request-a"),
      request(fixture, 60, "concurrent-request-b"),
    ])

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1)

    const [balance, withdrawals, allocations, ledger] = await Promise.all([
      prisma.publisherBalance.findUniqueOrThrow({
        where: { publisherId: fixture.publisherId },
      }),
      prisma.withdrawal.findMany({
        where: { publisherId: fixture.publisherId },
      }),
      prisma.withdrawalAllocation.findMany({
        where: { withdrawal: { publisherId: fixture.publisherId } },
      }),
      prisma.transaction.findMany({
        where: {
          publisherId: fixture.publisherId,
          type: "WITHDRAWAL",
        },
      }),
    ])
    expect(balance.withdrawableBalance.toString()).toBe("40")
    expect(balance.allocationCarryForwardUsed.toString()).toBe("60")
    expect(balance.version).toBe(1)
    expect(withdrawals).toHaveLength(1)
    expect(withdrawals[0].amount.toString()).toBe("60")
    expect(allocations).toHaveLength(1)
    expect(allocations[0].amount.toString()).toBe("60")
    expect(allocations[0].releasedAt).toBeNull()
    expect(ledger).toHaveLength(1)
    expect(ledger[0].amount.toString()).toBe("-60")
  }, 30_000)

  it("serializes approval against rejection with one consistent winner", async () => {
    const fixture = await makeWithdrawalFixture(100)
    const rejector = await makeUser(prisma, { userType: "STAFF" })
    await prisma.staffMembership.create({
      data: {
        userId: rejector.id,
        role: "FINANCE",
      },
    })
    const withdrawal = await request(fixture, 70, "approve-reject-race-request")

    const outcomes = await Promise.allSettled([
      payouts.approveWithdrawal(withdrawal.id, fixture.financeId),
      payouts.rejectWithdrawal(
        withdrawal.id,
        rejector.id,
        "Concurrent finance review rejected this withdrawal",
      ),
    ])

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1)

    const [persisted, balance, allocations, ledger] = await Promise.all([
      prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } }),
      prisma.publisherBalance.findUniqueOrThrow({
        where: { publisherId: fixture.publisherId },
      }),
      prisma.withdrawalAllocation.findMany({
        where: { withdrawalId: withdrawal.id },
      }),
      prisma.transaction.findMany({
        where: {
          publisherId: fixture.publisherId,
          type: { in: ["WITHDRAWAL", "WITHDRAWAL_REVERSAL"] },
        },
        orderBy: { createdAt: "asc" },
      }),
    ])

    if (persisted.status === "APPROVED") {
      expect(persisted.approvedBy).toBe(fixture.financeId)
      expect(persisted.approvedAt).not.toBeNull()
      expect(persisted.rejectedBy).toBeNull()
      expect(persisted.rejectedAt).toBeNull()
      expect(balance.withdrawableBalance.toString()).toBe("30")
      expect(balance.allocationCarryForwardUsed.toString()).toBe("70")
      expect(balance.version).toBe(1)
      expect(allocations).toHaveLength(1)
      expect(allocations[0].releasedAt).toBeNull()
      expect(ledger).toHaveLength(1)
      expect(ledger[0].amount.toString()).toBe("-70")
    } else {
      expect(persisted.status).toBe("REJECTED")
      expect(persisted.approvedBy).toBeNull()
      expect(persisted.approvedAt).toBeNull()
      expect(persisted.rejectedBy).toBe(rejector.id)
      expect(persisted.rejectedAt).not.toBeNull()
      expect(balance.withdrawableBalance.toString()).toBe("100")
      expect(balance.allocationCarryForwardUsed.toString()).toBe("0")
      expect(balance.version).toBe(2)
      expect(allocations).toHaveLength(1)
      expect(allocations[0].releasedAt).not.toBeNull()
      expect(ledger).toHaveLength(2)
      expect(ledger.map((row: any) => row.amount.toString())).toEqual([
        "-70",
        "70",
      ])
    }
  }, 30_000)

  it("rejects sub-cent, negative-fee, inconsistent-net, and under-allocated direct writes", async () => {
    const fixture = await makeWithdrawalFixture(100)
    const base = {
      publisherId: fixture.publisherId,
      currency: "USD",
      method: "bank_transfer",
      status: "PENDING" as const,
      feePolicyVersion: "integration-v1",
      payoutMethodId: fixture.payoutMethodId,
      requestedBy: fixture.ownerId,
      availableAt: new Date(),
    }

    await expect(
      prisma.withdrawal.create({
        data: {
          ...base,
          amount: 10.001,
          netAmount: 10.001,
          payoutFee: 0,
          publicReference: "WD-SUB-CENT",
          idempotencyKey: "direct-sub-cent",
        },
      }),
    ).rejects.toThrow(/canonical provenance-backed requests/)
    await expect(
      prisma.withdrawal.create({
        data: {
          ...base,
          amount: 10,
          netAmount: 10.01,
          payoutFee: -0.01,
          publicReference: "WD-NEGATIVE-FEE",
          idempotencyKey: "direct-negative-fee",
        },
      }),
    ).rejects.toThrow(/canonical provenance-backed requests/)
    await expect(
      prisma.withdrawal.create({
        data: {
          ...base,
          amount: 10,
          netAmount: 10,
          payoutFee: 0.01,
          publicReference: "WD-INCONSISTENT-NET",
          idempotencyKey: "direct-inconsistent-net",
        },
      }),
    ).rejects.toThrow(/canonical provenance-backed requests/)

    const canonical = await request(fixture, 10, "allocation-sub-cent-parent")
    await expect(
      prisma.withdrawalAllocation.create({
        data: {
          withdrawalId: canonical.id,
          sourceType: "CARRY_FORWARD",
          amount: 0.001,
          currency: "USD",
          sequence: 1,
        },
      }),
    ).rejects.toThrow(/active evidence for a pending request/)

    await expect(
      prisma.$transaction(async (tx: any) => {
        const malformed = await tx.withdrawal.create({
          data: {
            ...base,
            amount: 10,
            netAmount: 10,
            payoutFee: 0,
            publicReference: "WD-UNDER-ALLOCATED",
            idempotencyKey: "direct-under-allocated",
          },
        })
        await tx.withdrawalAllocation.create({
          data: {
            withdrawalId: malformed.id,
            sourceType: "CARRY_FORWARD",
            amount: 9,
            currency: "USD",
            sequence: 0,
          },
        })
      }),
    ).rejects.toThrow(/exact active allocation coverage/)
  }, 30_000)

  it.each([
    ["approval", "APPROVED"],
    ["rejection", "REJECTED"],
  ] as const)(
    "serializes a concurrent allocation insert against %s",
    async (operation, expectedStatus) => {
      const fixture = await makeWithdrawalFixture(100)
      const withdrawal = await request(
        fixture,
        40,
        `allocation-${operation}-race`,
      )
      let releaseInsert!: () => void
      let notifyInsertLocked!: () => void
      const insertLocked = new Promise<void>((resolve) => {
        notifyInsertLocked = resolve
      })
      const release = new Promise<void>((resolve) => {
        releaseInsert = resolve
      })
      const insert = prisma.$transaction(async (tx: any) => {
        await tx.withdrawalAllocation.create({
          data: {
            withdrawalId: withdrawal.id,
            sourceType: "CARRY_FORWARD",
            amount: 1,
            currency: "USD",
            sequence: 1,
          },
        })
        notifyInsertLocked()
        await release
      })
      await insertLocked
      const stateChange =
        operation === "approval"
          ? payouts.approveWithdrawal(withdrawal.id, fixture.financeId)
          : payouts.rejectWithdrawal(
              withdrawal.id,
              fixture.financeId,
              "Finance rejected the withdrawal after allocation review",
            )
      await new Promise((resolve) => setTimeout(resolve, 50))
      releaseInsert()

      const outcomes = await Promise.allSettled([insert, stateChange])
      expect(outcomes[0].status).toBe("rejected")
      expect(outcomes[1].status).toBe("fulfilled")

      const [persisted, allocations] = await Promise.all([
        prisma.withdrawal.findUniqueOrThrow({
          where: { id: withdrawal.id },
        }),
        prisma.withdrawalAllocation.findMany({
          where: { withdrawalId: withdrawal.id },
        }),
      ])
      expect(persisted.status).toBe(expectedStatus)
      expect(allocations).toHaveLength(1)
      expect(allocations[0].amount.toString()).toBe("40")
      expect(allocations[0].releasedAt === null).toBe(
        expectedStatus === "APPROVED",
      )
    },
    30_000,
  )
})
