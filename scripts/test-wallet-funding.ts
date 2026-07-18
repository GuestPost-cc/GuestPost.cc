type PrismaLike = {
  $transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>
}

function assertTestFundingAllowed(amount: number) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Test wallet funding is disabled in production")
  }
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for test wallet funding")
  }
  const databaseHost = new URL(databaseUrl).hostname
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "postgres"])
  if (
    !localHosts.has(databaseHost) &&
    process.env.ALLOW_REMOTE_TEST_WALLET_FUNDING !== "true"
  ) {
    throw new Error(
      "Remote test wallet funding requires ALLOW_REMOTE_TEST_WALLET_FUNDING=true",
    )
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Test wallet funding amount must be positive and finite")
  }
}

/** Test/seed setup only. Never expose this operation through an HTTP route. */
export async function fundExistingWalletForTest(
  prisma: PrismaLike,
  walletId: string,
  amount: number,
  reference: string,
) {
  assertTestFundingAllowed(amount)
  await prisma.$transaction(async (tx: any) => {
    const wallet = await tx.wallet.findUniqueOrThrow({
      where: { id: walletId },
    })
    const updated = await tx.wallet.updateMany({
      where: { id: walletId, version: wallet.version },
      data: {
        availableBalance: { increment: amount },
        version: { increment: 1 },
      },
    })
    if (updated.count !== 1) {
      throw new Error("Wallet changed during test funding; retry the test")
    }
    await tx.transaction.create({
      data: {
        walletId,
        amount,
        currency: wallet.currency,
        type: "DEPOSIT",
        description: `Test funding ${reference}`,
        reference,
      },
    })
  })
}

/** Load-test setup only. Creates the organization wallet if needed. */
export async function fundOrganizationWalletForTest(
  prisma: PrismaLike,
  args: {
    organizationId: string
    userId: string
    amount: number
    reference: string
  },
) {
  assertTestFundingAllowed(args.amount)
  await prisma.$transaction(async (tx: any) => {
    const wallet = await tx.wallet.upsert({
      where: { organizationId: args.organizationId },
      create: {
        organizationId: args.organizationId,
        userId: args.userId,
        availableBalance: args.amount,
        reservedBalance: 0,
        currency: "USD",
      },
      update: { availableBalance: { increment: args.amount } },
    })
    await tx.transaction.create({
      data: {
        walletId: wallet.id,
        amount: args.amount,
        currency: wallet.currency,
        type: "DEPOSIT",
        description: `Test funding ${args.reference}`,
        reference: args.reference,
      },
    })
  })
}
