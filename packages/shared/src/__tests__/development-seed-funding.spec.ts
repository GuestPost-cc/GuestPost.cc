import {
  DEVELOPMENT_SEED_FUNDING,
  ensureDevelopmentSeedFunding,
} from "../development-seed-funding"

class TestDecimal {
  constructor(private readonly value: number) {}

  add(other: TestDecimal): TestDecimal {
    return new TestDecimal(this.value + other.value)
  }

  equals(other: TestDecimal): boolean {
    return this.value === other.value
  }

  mul(multiplier: number): TestDecimal {
    return new TestDecimal(this.value * multiplier)
  }

  toString(): string {
    return String(this.value)
  }
}

const args = { organizationId: "org-1", userId: "user-1" }

function wallet(balance = 5000) {
  return {
    id: "wallet-1",
    organizationId: args.organizationId,
    userId: args.userId,
    currency: "USD",
    availableBalance: new TestDecimal(balance),
    reservedBalance: new TestDecimal(0),
    version: balance === 0 ? 0 : 1,
  }
}

function exactEvidence(overrides: Record<string, unknown> = {}) {
  return {
    walletId: "wallet-1",
    type: "DEPOSIT",
    amount: new TestDecimal(5000),
    currency: "USD",
    description: DEVELOPMENT_SEED_FUNDING.description,
    provider: null,
    providerRef: null,
    orderId: null,
    publisherId: null,
    settlementId: null,
    depositAttempt: null,
    paymentDisputeHold: null,
    paymentDisputeResolution: null,
    _count: {
      withdrawalAllocations: 0,
      originatingPaymentDisputes: 0,
    },
    ...overrides,
  }
}

function transactionClient(options: {
  balance?: number
  evidence?: ReturnType<typeof exactEvidence> | null
}) {
  const currentWallet = wallet(options.balance ?? 5000)
  return {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) =>
      strings.join(" ").includes('FROM "Transaction"')
        ? options.evidence
          ? [{ id: "transaction-1" }]
          : []
        : [{ id: currentWallet.id }],
    ),
    wallet: {
      upsert: jest.fn().mockResolvedValue(currentWallet),
      findUnique: jest.fn().mockResolvedValue(currentWallet),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    transaction: {
      findUnique: jest.fn().mockResolvedValue(options.evidence ?? null),
      aggregate: jest.fn().mockResolvedValue({
        _sum: { amount: new TestDecimal(options.balance ?? 5000) },
      }),
      create: jest.fn().mockResolvedValue({ id: "transaction-1" }),
    },
  }
}

describe("development seed funding", () => {
  it("treats only the complete provider-free evidence shape as an exact replay", async () => {
    const tx = transactionClient({ evidence: exactEvidence() })
    const prisma = {
      $transaction: jest.fn(
        async (operation: (db: typeof tx) => Promise<unknown>) => operation(tx),
      ),
    }

    await expect(ensureDevelopmentSeedFunding(prisma, args)).resolves.toEqual({
      created: false,
      walletId: "wallet-1",
    })
    expect(tx.transaction.create).not.toHaveBeenCalled()
    expect(tx.wallet.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    { provider: "stripe" },
    { providerRef: "pi_not_seed_evidence" },
    { orderId: "order-1" },
    { publisherId: "publisher-1" },
    { settlementId: "settlement-1" },
    { depositAttempt: { id: "attempt-1" } },
    { paymentDisputeHold: { id: "dispute-1" } },
    { paymentDisputeResolution: { id: "dispute-1" } },
    {
      _count: { withdrawalAllocations: 1, originatingPaymentDisputes: 0 },
    },
    {
      _count: { withdrawalAllocations: 0, originatingPaymentDisputes: 1 },
    },
    { description: "unrelated deposit" },
  ])("rejects conflicting linked evidence: %o", async (override) => {
    const tx = transactionClient({ evidence: exactEvidence(override) })
    const prisma = {
      $transaction: jest.fn(
        async (operation: (db: typeof tx) => Promise<unknown>) => operation(tx),
      ),
    }

    await expect(ensureDevelopmentSeedFunding(prisma, args)).rejects.toThrow(
      "conflicting ledger evidence",
    )
    expect(tx.transaction.create).not.toHaveBeenCalled()
    expect(tx.wallet.updateMany).not.toHaveBeenCalled()
  })

  it("commits the ledger evidence and wallet increment in one transaction", async () => {
    const tx = transactionClient({ balance: 0, evidence: null })
    const prisma = {
      $transaction: jest.fn(
        async (operation: (db: typeof tx) => Promise<unknown>) => operation(tx),
      ),
    }

    await expect(ensureDevelopmentSeedFunding(prisma, args)).resolves.toEqual({
      created: true,
      walletId: "wallet-1",
    })
    expect(tx.transaction.create).toHaveBeenCalledWith({
      data: {
        walletId: "wallet-1",
        type: "DEPOSIT",
        amount: "5000",
        currency: "USD",
        description: "Seed initial funding",
        reference: "seed-initial-funding",
      },
    })
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: "wallet-1", version: 0 },
      data: {
        availableBalance: { increment: "5000" },
        version: { increment: 1 },
      },
    })
  })

  it("accepts a unique race only after a fresh locked exact-evidence read", async () => {
    const collision = Object.assign(new Error("unique"), { code: "P2002" })
    const verificationTx = transactionClient({ evidence: exactEvidence() })
    const prisma = {
      $transaction: jest
        .fn()
        .mockRejectedValueOnce(collision)
        .mockImplementationOnce(
          async (operation: (db: typeof verificationTx) => Promise<unknown>) =>
            operation(verificationTx),
        ),
    }

    await expect(ensureDevelopmentSeedFunding(prisma, args)).resolves.toEqual({
      created: false,
      walletId: "wallet-1",
    })
    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
    expect(verificationTx.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it("preserves the unique error when post-collision evidence is not exact", async () => {
    const collision = Object.assign(new Error("unique"), { code: "P2002" })
    const verificationTx = transactionClient({
      evidence: exactEvidence({ provider: "stripe" }),
    })
    const prisma = {
      $transaction: jest
        .fn()
        .mockRejectedValueOnce(collision)
        .mockImplementationOnce(
          async (operation: (db: typeof verificationTx) => Promise<unknown>) =>
            operation(verificationTx),
        ),
    }

    await expect(ensureDevelopmentSeedFunding(prisma, args)).rejects.toBe(
      collision,
    )
    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
  })
})
