import crypto from "node:crypto"
import {
  DEVELOPMENT_SEED_FUNDING,
  ensureDevelopmentSeedFunding,
} from "@guestpost/shared/dist/development-seed-funding"
import { createTestDatabase, type TestDatabase } from "../helpers/test-db"

describe("[INTEGRATION] Financial — development seed funding", () => {
  let database: TestDatabase | undefined
  let previousDatabaseUrl: string | undefined
  let firstClient: any
  let secondClient: any

  beforeEach(async () => {
    database = await createTestDatabase()
    previousDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = database.url

    const { PrismaService } = require("../../../common/prisma.service") as any
    firstClient = new PrismaService()
    secondClient = new PrismaService()
    await Promise.all([firstClient.$connect(), secondClient.$connect()])
  })

  afterEach(async () => {
    await Promise.allSettled([
      firstClient?.$disconnect(),
      secondClient?.$disconnect(),
    ])
    await database?.teardown()

    if (previousDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = previousDatabaseUrl
    } else {
      delete process.env.DATABASE_URL
    }
  })

  async function createSeedOwner() {
    const suffix = crypto.randomUUID()
    const organization = await firstClient.organization.create({
      data: {
        name: `Seed concurrency ${suffix}`,
        slug: `seed-concurrency-${suffix}`,
      },
    })
    const user = await firstClient.user.create({
      data: {
        email: `seed-concurrency-${suffix}@test.local`,
        name: "Seed concurrency customer",
        userType: "CUSTOMER",
        emailVerified: true,
      },
    })
    return { organization, user }
  }

  it("credits exactly once when two independent clients seed concurrently", async () => {
    const { organization, user } = await createSeedOwner()
    const args = { organizationId: organization.id, userId: user.id }

    const [firstConnection, secondConnection] = await Promise.all([
      firstClient.$queryRaw`SELECT pg_backend_pid()::text AS pid`,
      secondClient.$queryRaw`SELECT pg_backend_pid()::text AS pid`,
    ])
    expect(firstConnection[0].pid).not.toBe(secondConnection[0].pid)

    const outcomes = await Promise.allSettled([
      ensureDevelopmentSeedFunding(firstClient, args),
      ensureDevelopmentSeedFunding(secondClient, args),
    ])

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(
      true,
    )
    const results = outcomes.map(
      (outcome) => (outcome as PromiseFulfilledResult<any>).value,
    )
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(results.filter((result) => !result.created)).toHaveLength(1)
    expect(new Set(results.map((result) => result.walletId)).size).toBe(1)

    const wallet = await firstClient.wallet.findUniqueOrThrow({
      where: { organizationId: organization.id },
    })
    const seedTransactions = await firstClient.transaction.findMany({
      where: { reference: DEVELOPMENT_SEED_FUNDING.reference },
    })
    const walletLedger = await firstClient.transaction.aggregate({
      where: {
        walletId: wallet.id,
        type: { not: "RESERVATION" },
      },
      _sum: { amount: true },
    })

    expect(seedTransactions).toHaveLength(1)
    expect(seedTransactions[0]).toMatchObject({
      walletId: wallet.id,
      type: "DEPOSIT",
      amount: expect.anything(),
      currency: DEVELOPMENT_SEED_FUNDING.currency,
      description: DEVELOPMENT_SEED_FUNDING.description,
      reference: DEVELOPMENT_SEED_FUNDING.reference,
      provider: null,
      providerRef: null,
      orderId: null,
      publisherId: null,
      settlementId: null,
    })
    expect(seedTransactions[0].amount.toString()).toBe(
      DEVELOPMENT_SEED_FUNDING.amount,
    )
    expect(wallet).toMatchObject({
      organizationId: organization.id,
      userId: user.id,
      currency: DEVELOPMENT_SEED_FUNDING.currency,
      version: 1,
    })
    expect(wallet.availableBalance.toString()).toBe(
      DEVELOPMENT_SEED_FUNDING.amount,
    )
    expect(wallet.reservedBalance.toString()).toBe("0")
    expect(wallet.availableBalance.add(wallet.reservedBalance).toString()).toBe(
      DEVELOPMENT_SEED_FUNDING.amount,
    )
    expect(walletLedger._sum.amount?.toString()).toBe(
      DEVELOPMENT_SEED_FUNDING.amount,
    )
  })

  it("rejects provider-linked conflicting evidence without changing the wallet balance", async () => {
    const { organization, user } = await createSeedOwner()
    const wallet = await firstClient.wallet.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        availableBalance: 0,
        reservedBalance: 0,
        currency: DEVELOPMENT_SEED_FUNDING.currency,
      },
    })
    const providerRef = `pi_seed_conflict_${crypto.randomUUID()}`
    await firstClient.transaction.create({
      data: {
        type: "DEPOSIT",
        amount: DEVELOPMENT_SEED_FUNDING.amount,
        currency: DEVELOPMENT_SEED_FUNDING.currency,
        description: DEVELOPMENT_SEED_FUNDING.description,
        reference: DEVELOPMENT_SEED_FUNDING.reference,
        provider: "stripe",
        providerRef,
      },
    })

    await expect(
      ensureDevelopmentSeedFunding(secondClient, {
        organizationId: organization.id,
        userId: user.id,
      }),
    ).rejects.toThrow(
      "Seed funding reference exists with conflicting ledger evidence",
    )

    const [persistedWallet, walletTransactions, conflictingTransactions] =
      await Promise.all([
        firstClient.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
        firstClient.transaction.count({ where: { walletId: wallet.id } }),
        firstClient.transaction.findMany({
          where: { reference: DEVELOPMENT_SEED_FUNDING.reference },
        }),
      ])

    expect(persistedWallet.availableBalance.toString()).toBe("0")
    expect(persistedWallet.reservedBalance.toString()).toBe("0")
    expect(persistedWallet.version).toBe(0)
    expect(walletTransactions).toBe(0)
    expect(conflictingTransactions).toHaveLength(1)
    expect(conflictingTransactions[0]).toMatchObject({
      walletId: null,
      provider: "stripe",
      providerRef,
      reference: DEVELOPMENT_SEED_FUNDING.reference,
    })
  })

  it("rejects deposit-attempt provenance even when every transaction scalar is exact", async () => {
    const { organization, user } = await createSeedOwner()
    const wallet = await firstClient.wallet.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        availableBalance: DEVELOPMENT_SEED_FUNDING.amount,
        reservedBalance: 0,
        currency: DEVELOPMENT_SEED_FUNDING.currency,
      },
    })
    const transaction = await firstClient.transaction.create({
      data: {
        walletId: wallet.id,
        type: "DEPOSIT",
        amount: DEVELOPMENT_SEED_FUNDING.amount,
        currency: DEVELOPMENT_SEED_FUNDING.currency,
        description: DEVELOPMENT_SEED_FUNDING.description,
        reference: DEVELOPMENT_SEED_FUNDING.reference,
      },
    })
    const suffix = crypto.randomUUID().replaceAll("-", "")
    await firstClient.depositAttempt.create({
      data: {
        publicReference: `seed${suffix.slice(0, 28)}`,
        walletId: wallet.id,
        organizationId: organization.id,
        createdByUserId: user.id,
        method: "card",
        provider: "stripe",
        amount: DEVELOPMENT_SEED_FUNDING.amount,
        walletCredit: DEVELOPMENT_SEED_FUNDING.amount,
        currency: DEVELOPMENT_SEED_FUNDING.currency,
        status: "SUCCEEDED",
        idempotencyKey: `seed-provenance-${suffix}`,
        ledgerTransactionId: transaction.id,
      },
    })

    await expect(
      ensureDevelopmentSeedFunding(secondClient, {
        organizationId: organization.id,
        userId: user.id,
      }),
    ).rejects.toThrow(
      "Seed funding reference exists with conflicting ledger evidence",
    )

    const [persistedWallet, persistedTransactions] = await Promise.all([
      firstClient.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
      firstClient.transaction.findMany({ where: { walletId: wallet.id } }),
    ])
    expect(persistedWallet.availableBalance.toString()).toBe(
      DEVELOPMENT_SEED_FUNDING.amount,
    )
    expect(persistedWallet.reservedBalance.toString()).toBe("0")
    expect(persistedWallet.version).toBe(0)
    expect(persistedTransactions).toHaveLength(1)
    expect(persistedTransactions[0].id).toBe(transaction.id)
  })
})
