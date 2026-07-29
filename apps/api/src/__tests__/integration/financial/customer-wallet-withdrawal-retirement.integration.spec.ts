import { makeOrganization, makePublisher, makeWallet } from "../factories"
import { createTestDatabase, type TestDatabase } from "../helpers/test-db"

describe("[INTEGRATION] Financial — customer wallet withdrawal retirement", () => {
  let database: TestDatabase | undefined
  let previousDatabaseUrl: string | undefined
  let prisma: any

  beforeAll(async () => {
    database = await createTestDatabase()
    previousDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = database.url

    const { PrismaService } = require("../../../common/prisma.service") as any
    prisma = new PrismaService()
    await prisma.$connect()
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
    }
  })

  it("rolls back an old-style wallet debit when its withdrawal ledger write is rejected", async () => {
    const organization = await makeOrganization(prisma)
    const wallet = await makeWallet(prisma, {
      organizationId: organization.id,
      availableBalance: 100,
    })
    const reference = `retired-wallet-withdrawal-${wallet.id}`

    await expect(
      prisma.$transaction(async (tx: any) => {
        const debited = await tx.wallet.updateMany({
          where: { id: wallet.id, version: wallet.version },
          data: {
            availableBalance: { decrement: 40 },
            version: { increment: 1 },
          },
        })
        expect(debited.count).toBe(1)

        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            amount: -40,
            currency: "USD",
            type: "WITHDRAWAL",
            reference,
            description: "Legacy customer wallet cash-out",
          },
        })
      }),
    ).rejects.toBeDefined()

    const [persistedWallet, ledger] = await Promise.all([
      prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
      prisma.transaction.findUnique({ where: { reference } }),
    ])
    expect(persistedWallet.availableBalance.toString()).toBe("100")
    expect(persistedWallet.version).toBe(0)
    expect(ledger).toBeNull()
  })

  it("rejects updates that would turn a wallet ledger row into a withdrawal", async () => {
    const organization = await makeOrganization(prisma)
    const wallet = await makeWallet(prisma, {
      organizationId: organization.id,
      availableBalance: 25,
    })
    const reference = `wallet-ledger-update-${wallet.id}`
    const deposit = await prisma.transaction.create({
      data: {
        walletId: wallet.id,
        amount: 25,
        currency: "USD",
        type: "DEPOSIT",
        reference,
      },
    })

    await expect(
      prisma.transaction.update({
        where: { id: deposit.id },
        data: { type: "WITHDRAWAL" },
      }),
    ).rejects.toBeDefined()

    const persisted = await prisma.transaction.findUniqueOrThrow({
      where: { id: deposit.id },
    })
    expect(persisted.type).toBe("DEPOSIT")
    expect(persisted.walletId).toBe(wallet.id)
  })

  it("prevents rewriting or deleting historical wallet withdrawal incident evidence", async () => {
    const organization = await makeOrganization(prisma)
    const wallet = await makeWallet(prisma, {
      organizationId: organization.id,
      availableBalance: 60,
    })
    const reference = `historical-wallet-withdrawal-${wallet.id}`

    // Simulate a row that existed before the retirement migration. The
    // disposable test database owns this table, and the write trigger is
    // re-enabled even if fixture creation fails.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Transaction" DISABLE TRIGGER "Transaction_customer_wallet_cash_out_retired_guard"',
    )
    let historical: any
    try {
      historical = await prisma.transaction.create({
        data: {
          walletId: wallet.id,
          amount: -15,
          currency: "USD",
          type: "WITHDRAWAL",
          reference,
          description: "Pre-migration wallet withdrawal incident evidence",
        },
      })
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "Transaction" ENABLE TRIGGER "Transaction_customer_wallet_cash_out_retired_guard"',
      )
    }

    await expect(
      prisma.transaction.update({
        where: { id: historical.id },
        data: {
          type: "DEPOSIT",
          walletId: null,
          description: "Attempted evidence rewrite",
        },
      }),
    ).rejects.toBeDefined()

    await expect(
      prisma.transaction.delete({ where: { id: historical.id } }),
    ).rejects.toBeDefined()

    const persisted = await prisma.transaction.findUnique({
      where: { id: historical.id },
    })
    expect(persisted).not.toBeNull()
    expect(persisted.type).toBe("WITHDRAWAL")
    expect(persisted.walletId).toBe(wallet.id)
    expect(persisted.description).toBe(
      "Pre-migration wallet withdrawal incident evidence",
    )
  })

  it("continues to allow publisher withdrawal reservation ledger rows", async () => {
    const organization = await makeOrganization(prisma)
    const publisher = await makePublisher(prisma, {
      organizationId: organization.id,
    })
    const reference = `publisher-withdrawal-${publisher.id}`

    const ledger = await prisma.transaction.create({
      data: {
        publisherId: publisher.id,
        walletId: null,
        amount: -30,
        currency: "USD",
        type: "WITHDRAWAL",
        reference,
        description: "Publisher payout reservation",
      },
    })

    expect(ledger.type).toBe("WITHDRAWAL")
    expect(ledger.publisherId).toBe(publisher.id)
    expect(ledger.walletId).toBeNull()
  })
})
