import { isPrismaUniqueConstraintError } from "./prisma-transaction-retry"
import { runSerializableTransactionWithRetry } from "./settlement-transaction"

export const DEVELOPMENT_SEED_FUNDING = Object.freeze({
  amount: "5000",
  currency: "USD",
  description: "Seed initial funding",
  reference: "seed-initial-funding",
})

type DevelopmentSeedFundingArgs = {
  organizationId: string
  userId: string
}

type DevelopmentSeedFundingResult = {
  created: boolean
  walletId: string
}

type LockedSeedWallet = {
  id: string
  availableBalance: any
  reservedBalance: any
  currency: string
  organizationId: string | null
  userId: string | null
  version: number
}

type SeedFundingEvidence = {
  walletId: string | null
  type: string
  amount: any
  currency: string
  description: string | null
  provider: string | null
  providerRef: string | null
  orderId: string | null
  publisherId: string | null
  settlementId: string | null
  depositAttempt: { id: string } | null
  paymentDisputeHold: { id: string } | null
  paymentDisputeResolution: { id: string } | null
  _count: {
    withdrawalAllocations: number
    originatingPaymentDisputes: number
  }
}

class SeedFundingInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SeedFundingInvariantError"
  }
}

function assertSeedWalletIdentity(
  wallet: LockedSeedWallet,
  args: DevelopmentSeedFundingArgs,
): void {
  if (
    wallet.organizationId !== args.organizationId ||
    wallet.userId !== args.userId ||
    wallet.currency !== DEVELOPMENT_SEED_FUNDING.currency
  ) {
    throw new SeedFundingInvariantError(
      "Seed wallet identity or currency conflicts with the expected local fixture",
    )
  }
}

function isExactSeedFundingEvidence(
  evidence: SeedFundingEvidence | null,
  walletId: string,
): evidence is SeedFundingEvidence {
  return Boolean(
    evidence &&
      evidence.walletId === walletId &&
      evidence.type === "DEPOSIT" &&
      evidence.amount.toString() === DEVELOPMENT_SEED_FUNDING.amount &&
      evidence.currency === DEVELOPMENT_SEED_FUNDING.currency &&
      evidence.description === DEVELOPMENT_SEED_FUNDING.description &&
      evidence.provider === null &&
      evidence.providerRef === null &&
      evidence.orderId === null &&
      evidence.publisherId === null &&
      evidence.settlementId === null &&
      evidence.depositAttempt === null &&
      evidence.paymentDisputeHold === null &&
      evidence.paymentDisputeResolution === null &&
      evidence._count.withdrawalAllocations === 0 &&
      evidence._count.originatingPaymentDisputes === 0,
  )
}

async function lockAndReadSeedWallet(
  tx: any,
  organizationId: string,
): Promise<LockedSeedWallet | null> {
  const lockedRows = (await tx.$queryRaw`
    SELECT "id"
    FROM "Wallet"
    WHERE "organizationId" = ${organizationId}
    FOR UPDATE
  `) as Array<{ id: string }>

  if (lockedRows.length === 0) return null
  if (lockedRows.length !== 1) {
    throw new SeedFundingInvariantError(
      "Seed organization has multiple wallets despite its uniqueness constraint",
    )
  }

  return tx.wallet.findUnique({ where: { id: lockedRows[0].id } })
}

async function lockAndReadSeedFundingEvidence(
  tx: any,
): Promise<SeedFundingEvidence | null> {
  const lockedRows = (await tx.$queryRaw`
    SELECT "id"
    FROM "Transaction"
    WHERE "reference" = ${DEVELOPMENT_SEED_FUNDING.reference}
    FOR UPDATE
  `) as Array<{ id: string }>
  if (lockedRows.length === 0) return null
  if (lockedRows.length !== 1) {
    throw new SeedFundingInvariantError(
      "Seed funding reference is not unique in the ledger",
    )
  }

  const evidence = await tx.transaction.findUnique({
    where: { reference: DEVELOPMENT_SEED_FUNDING.reference },
    select: {
      walletId: true,
      type: true,
      amount: true,
      currency: true,
      description: true,
      provider: true,
      providerRef: true,
      orderId: true,
      publisherId: true,
      settlementId: true,
      depositAttempt: { select: { id: true } },
      paymentDisputeHold: { select: { id: true } },
      paymentDisputeResolution: { select: { id: true } },
      _count: {
        select: {
          withdrawalAllocations: true,
          originatingPaymentDisputes: true,
        },
      },
    },
  })
  if (!evidence) {
    throw new SeedFundingInvariantError(
      "Seed funding evidence disappeared while acquiring its row lock",
    )
  }
  return evidence
}

async function assertWalletLedgerParity(
  tx: any,
  wallet: LockedSeedWallet,
): Promise<void> {
  const ledger = await tx.transaction.aggregate({
    where: {
      walletId: wallet.id,
      type: { not: "RESERVATION" },
    },
    _sum: { amount: true },
  })
  const ledgerTotal = ledger._sum.amount ?? wallet.availableBalance.mul(0)
  const walletTotal = wallet.availableBalance.add(wallet.reservedBalance)
  if (!walletTotal.equals(ledgerTotal)) {
    throw new SeedFundingInvariantError(
      "Seed wallet balance does not match its ledger; refusing to change money",
    )
  }
}

async function verifyCommittedSeedFunding(
  prisma: any,
  args: DevelopmentSeedFundingArgs,
): Promise<DevelopmentSeedFundingResult> {
  return runSerializableTransactionWithRetry(prisma, async (tx) => {
    const wallet = await lockAndReadSeedWallet(tx, args.organizationId)
    if (!wallet) {
      throw new SeedFundingInvariantError(
        "Concurrent seed collision committed without the expected wallet",
      )
    }
    assertSeedWalletIdentity(wallet, args)

    const evidence = await lockAndReadSeedFundingEvidence(tx)
    if (!isExactSeedFundingEvidence(evidence, wallet.id)) {
      throw new SeedFundingInvariantError(
        "Concurrent seed collision did not commit exact synthetic evidence",
      )
    }
    await assertWalletLedgerParity(tx, wallet)
    return { created: false, walletId: wallet.id }
  })
}

/**
 * Creates the fixed local seed deposit and its wallet increment atomically.
 *
 * The wallet row is the aggregate lock. A concurrent first-time wallet or
 * reference insert can still surface as a unique violation; that transaction
 * is already rolled back before we perform a fresh, locked exact-evidence and
 * ledger-parity read. Only that exact committed replay is accepted.
 */
export async function ensureDevelopmentSeedFunding(
  prisma: any,
  args: DevelopmentSeedFundingArgs,
): Promise<DevelopmentSeedFundingResult> {
  try {
    return await runSerializableTransactionWithRetry(prisma, async (tx) => {
      await tx.wallet.upsert({
        where: { organizationId: args.organizationId },
        create: {
          organizationId: args.organizationId,
          userId: args.userId,
          availableBalance: 0,
          currency: DEVELOPMENT_SEED_FUNDING.currency,
        },
        update: {},
      })

      const wallet = await lockAndReadSeedWallet(tx, args.organizationId)
      if (!wallet) {
        throw new SeedFundingInvariantError(
          "Seed wallet disappeared while acquiring its aggregate lock",
        )
      }
      assertSeedWalletIdentity(wallet, args)

      const existing = await lockAndReadSeedFundingEvidence(tx)
      if (existing && !isExactSeedFundingEvidence(existing, wallet.id)) {
        throw new SeedFundingInvariantError(
          "Seed funding reference exists with conflicting ledger evidence",
        )
      }
      await assertWalletLedgerParity(tx, wallet)
      if (existing) return { created: false, walletId: wallet.id }

      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: "DEPOSIT",
          amount: DEVELOPMENT_SEED_FUNDING.amount,
          currency: DEVELOPMENT_SEED_FUNDING.currency,
          description: DEVELOPMENT_SEED_FUNDING.description,
          reference: DEVELOPMENT_SEED_FUNDING.reference,
        },
      })
      const updated = await tx.wallet.updateMany({
        where: { id: wallet.id, version: wallet.version },
        data: {
          availableBalance: {
            increment: DEVELOPMENT_SEED_FUNDING.amount,
          },
          version: { increment: 1 },
        },
      })
      if (updated.count !== 1) {
        throw new SeedFundingInvariantError(
          "Seed wallet changed after its aggregate lock was acquired",
        )
      }

      return { created: true, walletId: wallet.id }
    })
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) throw error

    try {
      return await verifyCommittedSeedFunding(prisma, args)
    } catch {
      // A uniqueness collision is idempotent only after fresh exact-evidence
      // and parity verification. Preserve every other collision as an error.
      throw error
    }
  }
}
