import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { PublisherPayoutsService } from "../publisher-payouts.service"

describe("PublisherPayoutsService", () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalFinanceRuntimeMode = process.env.FINANCE_RUNTIME_MODE
  const originalStripeConnectEnabled = process.env.STRIPE_CONNECT_ENABLED
  let service: PublisherPayoutsService
  let prismaMock: any
  let auditMock: any
  let queueMock: any
  let encryptionMock: any
  let executionMock: any

  const publisher = { id: "pub-1", tier: "NEW", organizationId: "org-1" }
  const balance = {
    publisherId: "pub-1",
    currency: "USD",
    withdrawableBalance: new Decimal(500),
    debtBalance: new Decimal(0),
    lifetimePaid: new Decimal(0),
    allocationCarryForward: new Decimal(500),
    allocationCarryForwardUsed: new Decimal(0),
    allocationCutoverAt: new Date(),
    version: 1,
  }

  beforeEach(() => {
    auditMock = { log: jest.fn().mockResolvedValue(undefined) }
    queueMock = { addJob: jest.fn().mockResolvedValue(undefined) }
    encryptionMock = {
      encrypt: jest
        .fn()
        .mockReturnValue({ ciphertext: "encrypted-data", version: 1 }),
      decrypt: jest.fn().mockReturnValue({ accountNumber: "1234" }),
      extractDisplayDetails: jest
        .fn()
        .mockReturnValue({ bankName: "Test Bank", last4: "1234" }),
      mask: jest
        .fn()
        .mockImplementation((d: any) => ({ ...d, accountNumber: "****" })),
    }
    executionMock = {
      executeWithdrawal: jest.fn(),
      retryExecution: jest.fn(),
      cancelExecution: jest.fn(),
      getExecutionsForWithdrawal: jest.fn(),
      getPendingStatusChecks: jest.fn(),
    }
    // Default payout method + execution mocks — approval re-validation
    // (FIN-04) needs both to pass before the transition is allowed.
    const payoutMethod = {
      id: "pm-1",
      publisherId: "pub-1",
      type: "bank_transfer",
      isActive: true,
      nonterminalWithdrawalCount: 0,
      version: 1,
      providerAccountId: null,
      publisher: { organizationId: "org-1" },
      providerAccount: null,
    }
    prismaMock = {
      publisherMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "mem-1" }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: "mem-1",
            userId: "owner-1",
            user: { banned: false, userType: "PUBLISHER" },
          },
        ]),
      },
      publisher: {
        findUnique: jest.fn().mockResolvedValue(publisher),
        findUniqueOrThrow: jest.fn().mockResolvedValue(publisher),
      },
      publisherBalance: {
        findUnique: jest.fn().mockResolvedValue(balance),
        upsert: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(balance),
        create: jest.fn(),
      },
      withdrawal: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payoutMethod: {
        findUnique: jest.fn().mockResolvedValue(payoutMethod),
        findFirst: jest.fn().mockResolvedValue(payoutMethod),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payoutExecution: {
        create: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payoutExecutionClaim: {
        count: jest.fn().mockResolvedValue(0),
      },
      publisherProviderAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: "provider-account-row-1",
          publisherId: "pub-1",
          provider: "stripe_connect",
          providerAccountId: "acct_ready",
          isActive: true,
          status: "ENABLED",
          transfersEnabled: true,
          payoutsEnabled: true,
          detailsSubmitted: true,
          payoutScheduleConfigured: true,
          defaultCurrency: "USD",
        }),
      },
      payoutProvider: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "manual-1", name: "manual" }),
      },
      staffMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "staff-membership-1" }),
      },
      transaction: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      withdrawalAllocation: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([
          {
            id: "allocation-1",
            amount: new Decimal(100),
            currency: "USD",
            sourceType: "SETTLEMENT_RELEASE",
            releasedAt: null,
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([balance]),
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
      $transaction: jest
        .fn()
        .mockImplementation(async (cb: any) => cb(prismaMock)),
    }
    service = new PublisherPayoutsService(
      prismaMock as any,
      auditMock as any,
      queueMock as any,
      encryptionMock as any,
      executionMock as any,
    )
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    if (originalFinanceRuntimeMode === undefined) {
      delete process.env.FINANCE_RUNTIME_MODE
    } else {
      process.env.FINANCE_RUNTIME_MODE = originalFinanceRuntimeMode
    }
    if (originalStripeConnectEnabled === undefined) {
      delete process.env.STRIPE_CONNECT_ENABLED
    } else {
      process.env.STRIPE_CONNECT_ENABLED = originalStripeConnectEnabled
    }
  })

  describe("getBalance", () => {
    it("returns an existing balance without writing", async () => {
      await expect(service.getBalance("pub-1")).resolves.toBe(balance)
      expect(prismaMock.publisherBalance.upsert).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.create).not.toHaveBeenCalled()
    })

    it("404s without mutating when a balance aggregate is missing", async () => {
      prismaMock.publisherBalance.findUnique.mockResolvedValue(null)

      await expect(service.getBalance("pub-1")).rejects.toThrow(
        "Publisher balance is not provisioned",
      )
      expect(prismaMock.publisherBalance.upsert).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.create).not.toHaveBeenCalled()
    })

    it("fails closed when a persisted balance is not canonical USD", async () => {
      prismaMock.publisherBalance.findUnique.mockResolvedValue({
        ...balance,
        currency: "usd",
      })

      await expect(service.getBalance("pub-1")).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "PUBLISHER_BALANCE_CURRENCY_INVALID",
        }),
      })
    })
  })

  describe("createPayoutMethod", () => {
    const validInput = {
      type: "bank_transfer",
      label: "Main bank",
      details: {
        bankName: "Example Bank",
        accountHolderName: "Publisher LLC",
        accountNumber: "12345678",
      },
      isDefault: true,
    }

    beforeEach(() => {
      process.env.NODE_ENV = "test"
      prismaMock.$queryRaw.mockResolvedValue([
        {
          membershipId: "membership-1",
          role: "PUBLISHER_OWNER",
          banned: false,
          userType: "PUBLISHER",
          organizationId: "org-1",
        },
      ])
      prismaMock.payoutMethod.create.mockResolvedValue({
        id: "pm-new",
        type: "bank_transfer",
        label: "Main bank",
        isDefault: true,
        isActive: true,
      })
    })

    it("locks current ownership and writes encrypted details atomically", async () => {
      await expect(
        service.createPayoutMethod("pub-1", "owner-1", validInput),
      ).resolves.toMatchObject({
        id: "pm-new",
        type: "bank_transfer",
        isDefault: true,
        withdrawalEligibility: {
          executable: true,
          canReactivate: false,
          code: "READY",
        },
      })

      expect(prismaMock.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: "Serializable" },
      )
      expect(encryptionMock.encrypt).toHaveBeenCalledWith(
        validInput.details,
        expect.objectContaining({
          kind: "payout-method-details",
          id: expect.any(String),
          publisherId: "pub-1",
          type: "bank_transfer",
        }),
      )
      const encryptionContext = encryptionMock.encrypt.mock.calls[0][1]
      expect(prismaMock.payoutMethod.updateMany).toHaveBeenCalledWith({
        where: { publisherId: "pub-1", isDefault: true },
        data: { isDefault: false },
      })
      expect(prismaMock.payoutMethod.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: encryptionContext.id,
          publisherId: "pub-1",
          details: "encrypted-data",
          isDefault: true,
        }),
      })
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "PAYOUT_METHOD_CREATED",
          userId: "owner-1",
          organizationId: "org-1",
        }),
        prismaMock,
      )
    })

    it.each([
      { ownerRows: [] },
      {
        ownerRows: [
          {
            membershipId: "membership-1",
            role: "PUBLISHER_OWNER",
            banned: true,
            userType: "PUBLISHER",
            organizationId: "org-1",
          },
        ],
      },
    ])("fails closed when current ownership is revoked or banned", async ({
      ownerRows,
    }) => {
      prismaMock.$queryRaw.mockResolvedValueOnce(ownerRows)

      await expect(
        service.createPayoutMethod("pub-1", "owner-1", validInput),
      ).rejects.toThrow(ForbiddenException)
      expect(encryptionMock.encrypt).not.toHaveBeenCalled()
      expect(prismaMock.payoutMethod.create).not.toHaveBeenCalled()
      expect(auditMock.log).not.toHaveBeenCalled()
    })

    it("validates direct service callers before opening a transaction", async () => {
      await expect(
        service.createPayoutMethod("pub-1", "owner-1", {
          ...validInput,
          details: {
            ...validInput.details,
            accessToken: "must-never-be-stored",
          },
        } as any),
      ).rejects.toThrow(BadRequestException)

      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(encryptionMock.encrypt).not.toHaveBeenCalled()
    })

    it.each([
      "paypal",
      "wise",
    ])("rejects creation of the uncertified %s route before opening a transaction", async (type) => {
      await expect(
        service.createPayoutMethod("pub-1", "owner-1", {
          type,
          label: "Unsupported route",
          details: { email: "publisher@example.test" },
        } as any),
      ).rejects.toThrow(BadRequestException)

      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(encryptionMock.encrypt).not.toHaveBeenCalled()
    })
  })

  describe("deactivatePayoutMethod", () => {
    it.each([
      "APPROVED",
      "PROCESSING",
    ])("blocks deactivation while a %s withdrawal keeps liability reserved", async () => {
      prismaMock.payoutMethod.findFirst.mockResolvedValue({
        id: "pm-1",
        publisherId: "pub-1",
        isActive: true,
        nonterminalWithdrawalCount: 1,
        version: 3,
        publisher: { organizationId: "org-1" },
      })

      await expect(
        service.deactivatePayoutMethod("pub-1", "owner-1", "pm-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "PAYOUT_METHOD_HAS_RESERVED_WITHDRAWALS",
        }),
      })
      expect(prismaMock.payoutMethod.updateMany).not.toHaveBeenCalled()
      expect(auditMock.log).not.toHaveBeenCalled()
    })

    it("deactivates and audits atomically when no liability remains", async () => {
      const result = await service.deactivatePayoutMethod(
        "pub-1",
        "owner-1",
        "pm-1",
      )

      expect(result).toEqual({
        id: "pm-1",
        isActive: false,
        replayed: false,
      })
      expect(prismaMock.payoutMethod.updateMany).toHaveBeenCalledWith({
        where: {
          id: "pm-1",
          publisherId: "pub-1",
          isActive: true,
          version: 1,
          nonterminalWithdrawalCount: 0,
        },
        data: {
          isActive: false,
          isDefault: false,
          version: { increment: 1 },
        },
      })
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "PAYOUT_METHOD_DEACTIVATED",
          entityId: "pm-1",
          userId: "owner-1",
        }),
        prismaMock,
      )
    })

    it("propagates audit failure from the same deactivation transaction", async () => {
      auditMock.log.mockRejectedValueOnce(new Error("audit unavailable"))

      await expect(
        service.deactivatePayoutMethod("pub-1", "owner-1", "pm-1"),
      ).rejects.toThrow("audit unavailable")
      expect(prismaMock.payoutMethod.updateMany).toHaveBeenCalledTimes(1)
    })

    it("audits an already-inactive deactivation replay without rewriting it", async () => {
      prismaMock.payoutMethod.findFirst.mockResolvedValue({
        id: "pm-1",
        publisherId: "pub-1",
        type: "bank_transfer",
        isActive: false,
        nonterminalWithdrawalCount: 0,
        version: 2,
        providerAccountId: null,
        publisher: { organizationId: "org-1" },
      })

      await expect(
        service.deactivatePayoutMethod("pub-1", "owner-1", "pm-1"),
      ).resolves.toEqual({
        id: "pm-1",
        isActive: false,
        replayed: true,
      })
      expect(prismaMock.payoutMethod.updateMany).not.toHaveBeenCalled()
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "PAYOUT_METHOD_DEACTIVATION_REPLAYED",
          entityId: "pm-1",
        }),
        prismaMock,
      )
    })
  })

  describe("reactivatePayoutMethod", () => {
    beforeEach(() => {
      process.env.STRIPE_CONNECT_ENABLED = "true"
    })

    const inactiveManagedMethod = {
      id: "pm-1",
      publisherId: "pub-1",
      type: "stripe_connect",
      isActive: false,
      nonterminalWithdrawalCount: 0,
      version: 3,
      providerAccountId: "provider-account-row-1",
      publisher: { organizationId: "org-1" },
    }

    it("locks the provider account before the method and reactivates only a fully ready route", async () => {
      prismaMock.payoutMethod.findFirst.mockResolvedValue(inactiveManagedMethod)

      await expect(
        service.reactivatePayoutMethod("pub-1", "owner-1", "pm-1"),
      ).resolves.toEqual({
        id: "pm-1",
        isActive: true,
        replayed: false,
      })
      const accountLock = prismaMock.$queryRawUnsafe.mock.calls.findIndex(
        (call: any[]) =>
          String(call[0]).includes('FROM "PublisherProviderAccount"'),
      )
      const methodLock = prismaMock.$queryRawUnsafe.mock.calls.findIndex(
        (call: any[]) => String(call[0]).includes('FROM "PayoutMethod"'),
      )
      expect(accountLock).toBeGreaterThanOrEqual(0)
      expect(methodLock).toBeGreaterThan(accountLock)
      expect(prismaMock.payoutMethod.updateMany).toHaveBeenCalledWith({
        where: {
          id: "pm-1",
          publisherId: "pub-1",
          isActive: false,
          version: 3,
          nonterminalWithdrawalCount: 0,
        },
        data: {
          isActive: true,
          version: { increment: 1 },
        },
      })
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "PAYOUT_METHOD_REACTIVATED",
          entityId: "pm-1",
          metadata: expect.objectContaining({
            providerAccountId: "provider-account-row-1",
            previousVersion: 3,
            version: 4,
          }),
        }),
        prismaMock,
      )
    })

    it("rejects reactivation when any Stripe readiness fact is false", async () => {
      prismaMock.payoutMethod.findFirst.mockResolvedValue(inactiveManagedMethod)
      prismaMock.publisherProviderAccount.findUnique.mockResolvedValue({
        id: "provider-account-row-1",
        publisherId: "pub-1",
        provider: "stripe_connect",
        providerAccountId: "acct_restricted",
        isActive: true,
        status: "RESTRICTED",
        transfersEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        payoutScheduleConfigured: true,
        defaultCurrency: "USD",
      })

      await expect(
        service.reactivatePayoutMethod("pub-1", "owner-1", "pm-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "PAYOUT_METHOD_PROVIDER_NOT_READY",
        }),
      })
      expect(prismaMock.payoutMethod.updateMany).not.toHaveBeenCalled()
      expect(auditMock.log).not.toHaveBeenCalled()
    })

    it("audits an already-active reactivation replay without rewriting it", async () => {
      prismaMock.payoutMethod.findFirst.mockResolvedValue({
        ...inactiveManagedMethod,
        isActive: true,
      })

      await expect(
        service.reactivatePayoutMethod("pub-1", "owner-1", "pm-1"),
      ).resolves.toEqual({
        id: "pm-1",
        isActive: true,
        replayed: true,
      })
      expect(prismaMock.payoutMethod.updateMany).not.toHaveBeenCalled()
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "PAYOUT_METHOD_REACTIVATION_REPLAYED",
          entityId: "pm-1",
        }),
        prismaMock,
      )
    })

    it("fails closed if the observed method binding changes before its lock", async () => {
      prismaMock.payoutMethod.findFirst
        .mockResolvedValueOnce(inactiveManagedMethod)
        .mockResolvedValueOnce({
          ...inactiveManagedMethod,
          version: 4,
        })

      await expect(
        service.reactivatePayoutMethod("pub-1", "owner-1", "pm-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "PAYOUT_METHOD_REACTIVATION_RACE",
        }),
      })
      expect(prismaMock.payoutMethod.updateMany).not.toHaveBeenCalled()
    })
  })

  describe("finance runtime lifecycle gates", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "production"
      process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    })

    it("blocks payout-method creation as new liability", async () => {
      await expect(
        service.createPayoutMethod("pub-1", "owner-1", {
          type: "bank_transfer",
          label: "Main",
          details: { accountNumber: "1234" },
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "FINANCE_OPERATION_BLOCKED",
        }),
      })
      expect(prismaMock.publisherMembership.findFirst).not.toHaveBeenCalled()
      expect(encryptionMock.encrypt).not.toHaveBeenCalled()
    })

    it("blocks payout-method reactivation as new liability", async () => {
      await expect(
        service.reactivatePayoutMethod("pub-1", "owner-1", "pm-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "FINANCE_OPERATION_BLOCKED",
        }),
      })
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })

    it("blocks payout-method deactivation as an operator decision", async () => {
      await expect(
        service.deactivatePayoutMethod("pub-1", "owner-1", "pm-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "FINANCE_OPERATION_BLOCKED",
        }),
      })
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })
  })

  describe("requestWithdrawal", () => {
    it("sets availableAt from tier hold and writes a WITHDRAWAL ledger row", async () => {
      const created = {
        id: "wd-1",
        publisherId: "pub-1",
        amount: new Decimal(100),
      }
      prismaMock.withdrawal.create.mockResolvedValue(created)

      const before = Date.now()
      await service.requestWithdrawal(
        "pub-1",
        100,
        "bank_transfer",
        "user-1",
        "key-create",
        "pm-1",
      )

      const createCall = prismaMock.withdrawal.create.mock.calls[0][0]
      // NEW tier = 30 day hold
      const expectedMs = before + 30 * 24 * 60 * 60 * 1000
      expect(
        Math.abs(createCall.data.availableAt.getTime() - expectedMs),
      ).toBeLessThan(5000)

      const txCall = prismaMock.transaction.create.mock.calls[0][0]
      expect(txCall.data.type).toBe("WITHDRAWAL")
      expect(txCall.data.reference).toBe("withdrawal-wd-1")
      expect(txCall.data.amount.equals(new Decimal(-100))).toBe(true)
      expect(txCall.data.currency).toBe("USD")
    })

    it("returns existing withdrawal on idempotency key replay without moving balance", async () => {
      prismaMock.withdrawal.findFirst.mockResolvedValue({
        id: "wd-existing",
        amount: new Decimal(100),
        currency: "USD",
        method: "bank_transfer",
        payoutMethodId: "pm-1",
        requestedBy: "user-1",
      })

      const result = await service.requestWithdrawal(
        "pub-1",
        100,
        "bank_transfer",
        "user-1",
        "key-1",
        "pm-1",
      )

      expect(result).toMatchObject({ id: "wd-existing" })
      expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.transaction.create).not.toHaveBeenCalled()
    })

    it("replays a committed withdrawal after its payout method is deactivated", async () => {
      const existing = {
        id: "wd-existing",
        amount: new Decimal(100),
        currency: "USD",
        method: "bank_transfer",
        payoutMethodId: "pm-1",
        requestedBy: "user-1",
      }
      prismaMock.withdrawal.findFirst.mockResolvedValue(existing)
      prismaMock.payoutMethod.findFirst.mockResolvedValue(null)

      await expect(
        service.requestWithdrawal(
          "pub-1",
          100,
          "bank_transfer",
          "user-1",
          "key-after-deactivation",
          "pm-1",
        ),
      ).resolves.toBe(existing)

      expect(prismaMock.payoutMethod.findFirst).not.toHaveBeenCalled()
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
    })

    it("rejects idempotency-key reuse with different payout details", async () => {
      prismaMock.withdrawal.findFirst.mockResolvedValue({
        id: "wd-existing",
        amount: new Decimal(100),
        currency: "USD",
        method: "bank_transfer",
        payoutMethodId: "pm-1",
        requestedBy: "user-1",
      })

      await expect(
        service.requestWithdrawal(
          "pub-1",
          101,
          "bank_transfer",
          "user-1",
          "key-1",
          "pm-1",
        ),
      ).rejects.toThrow(ConflictException)
      expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
    })

    it("rejects an idempotency replay whose stored currency is not canonical USD", async () => {
      prismaMock.withdrawal.findFirst.mockResolvedValue({
        id: "wd-existing",
        amount: new Decimal(100),
        currency: "usd",
        method: "bank_transfer",
        payoutMethodId: "pm-1",
        requestedBy: "user-1",
      })

      await expect(
        service.requestWithdrawal(
          "pub-1",
          100,
          "bank_transfer",
          "user-1",
          "key-lowercase-currency",
          "pm-1",
        ),
      ).rejects.toThrow(ConflictException)
      expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.transaction.create).not.toHaveBeenCalled()
    })

    it("rejects sub-cent withdrawal amounts at the service boundary", async () => {
      await expect(
        service.requestWithdrawal(
          "pub-1",
          10.001,
          "bank_transfer",
          "user-1",
          "key-subcent",
          "pm-1",
        ),
      ).rejects.toThrow(BadRequestException)
      expect(prismaMock.withdrawal.create).not.toHaveBeenCalled()
    })

    it("rejects amounts above withdrawable", async () => {
      await expect(
        service.requestWithdrawal(
          "pub-1",
          9999,
          "bank_transfer",
          "user-1",
          "key-large",
          "pm-1",
        ),
      ).rejects.toThrow(BadRequestException)
    })

    it("rejects a non-USD publisher balance before reserving liability", async () => {
      prismaMock.publisherBalance.findUnique.mockResolvedValue({
        ...balance,
        currency: "EUR",
      })

      await expect(
        service.requestWithdrawal(
          "pub-1",
          100,
          "bank_transfer",
          "user-1",
          "key-invalid-balance-currency",
          "pm-1",
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "PUBLISHER_BALANCE_CURRENCY_INVALID",
        }),
      })
      expect(prismaMock.withdrawal.create).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.transaction.create).not.toHaveBeenCalled()
    })

    it("rejects unsupported methods before reserving publisher funds", async () => {
      await expect(
        service.requestWithdrawal(
          "pub-1",
          100,
          "paypal",
          "user-1",
          "key-paypal",
          "pm-1",
        ),
      ).rejects.toThrow(/unsupported payout method/i)
      expect(prismaMock.withdrawal.create).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
    })

    it("requires a validated idempotency key at the service boundary", async () => {
      await expect(
        service.requestWithdrawal(
          "pub-1",
          100,
          "bank_transfer",
          "user-1",
          "",
          "pm-1",
        ),
      ).rejects.toThrow(/idempotency key/i)
      expect(prismaMock.withdrawal.create).not.toHaveBeenCalled()
    })

    it("revalidates requester owner eligibility inside the reservation transaction", async () => {
      prismaMock.publisherMembership.findFirst
        .mockResolvedValueOnce({ id: "mem-1" })
        .mockResolvedValueOnce(null)

      await expect(
        service.requestWithdrawal(
          "pub-1",
          100,
          "bank_transfer",
          "user-1",
          "key-owner-race",
          "pm-1",
        ),
      ).rejects.toThrow(/eligibility changed/i)
      expect(prismaMock.withdrawal.create).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
    })

    it("recovers a concurrent idempotency winner from a nested PostgreSQL unique error", async () => {
      const winner = {
        id: "wd-winner",
        amount: new Decimal(100),
        currency: "USD",
        method: "bank_transfer",
        payoutMethodId: "pm-1",
        requestedBy: "user-1",
      }
      prismaMock.$transaction.mockRejectedValueOnce({
        code: "P2010",
        meta: {
          driverAdapterError: {
            cause: { originalCode: "23505" },
          },
        },
      })
      prismaMock.withdrawal.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner)

      await expect(
        service.requestWithdrawal(
          "pub-1",
          100,
          "bank_transfer",
          "user-1",
          "same-key",
          "pm-1",
        ),
      ).resolves.toBe(winner)
      expect(prismaMock.withdrawal.findFirst).toHaveBeenCalledTimes(2)
    })
  })

  describe("approveWithdrawal", () => {
    // Shared fixtures — the happy path plus every FIN-04 blocked reason.
    const baseWithdrawal = {
      id: "wd-1",
      status: "PENDING",
      version: 0,
      publisherId: "pub-1",
      amount: new Decimal(100),
      currency: "USD",
      method: "bank_transfer",
      payoutMethodId: "pm-1",
      availableAt: new Date(Date.now() - 1000),
      requestedBy: "owner-1",
      publisher: { organizationId: "org-1" },
    }

    it("rejects approval while tier hold is active (TIER_HOLD_ACTIVE)", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue({
        ...baseWithdrawal,
        availableAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).rejects.toThrow(/tier hold/i)
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      // FIN-04: every blocked path must emit a structured audit event so
      // finance investigations can query by reason code later.
      const blocked = auditMock.log.mock.calls.find(
        (c: any) => c[0]?.action === "WITHDRAWAL_APPROVAL_BLOCKED",
      )
      expect(blocked?.[0].metadata.reason).toBe("TIER_HOLD_ACTIVE")
    })

    it("approves once the hold has elapsed after every re-validation passes", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue(baseWithdrawal)
      prismaMock.withdrawal.findUniqueOrThrow.mockResolvedValue({
        id: "wd-1",
        status: "APPROVED",
        publisher: { organizationId: "org-1" },
      })

      const result = await service.approveWithdrawal("wd-1", "staff-1")
      expect(result.status).toBe("APPROVED")
      expect(prismaMock.withdrawal.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "wd-1", status: "PENDING", version: 0 },
        }),
      )
      expect(prismaMock.publisherMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { publisherId: "pub-1" } }),
      )
      expect(prismaMock.withdrawalAllocation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { withdrawalId: "wd-1" } }),
      )
      expect(prismaMock.publisherBalance.findUnique).not.toHaveBeenCalled()
      expect(prismaMock.payoutMethod.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "pm-1",
            publisherId: "pub-1",
            isActive: true,
            type: "bank_transfer",
          }),
        }),
      )
      expect(prismaMock.payoutExecution.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { withdrawalId: "wd-1" } }),
      )
    })

    it("blocks approval when the withdrawal currency is not canonical USD", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue({
        ...baseWithdrawal,
        currency: "EUR",
      })

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "CURRENCY_INVALID" }),
      })
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
    })

    it("blocks with NOT_PENDING when a concurrent approve/reject already moved the status", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue({
        ...baseWithdrawal,
        status: "APPROVED",
      })

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).rejects.toThrow(/no longer pending/i)
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      const blocked = auditMock.log.mock.calls.find(
        (c: any) => c[0]?.action === "WITHDRAWAL_APPROVAL_BLOCKED",
      )
      expect(blocked?.[0].metadata.reason).toBe("NOT_PENDING")
    })

    it("blocks with PUBLISHER_BANNED when the publisher was banned after request", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue(baseWithdrawal)
      prismaMock.publisherMembership.findMany.mockResolvedValueOnce([
        {
          id: "mem-1",
          userId: "owner-1",
          user: { banned: true, userType: "PUBLISHER" },
        },
      ])

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).rejects.toThrow(/banned/i)
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      const blocked = auditMock.log.mock.calls.find(
        (c: any) => c[0]?.action === "WITHDRAWAL_APPROVAL_BLOCKED",
      )
      expect(blocked?.[0].metadata.reason).toBe("PUBLISHER_BANNED")
    })

    it("blocks with MEMBERSHIP_REVOKED when the publisher membership was deleted", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue(baseWithdrawal)
      prismaMock.publisherMembership.findMany.mockResolvedValueOnce([])

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).rejects.toThrow(/membership/i)
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      const blocked = auditMock.log.mock.calls.find(
        (c: any) => c[0]?.action === "WITHDRAWAL_APPROVAL_BLOCKED",
      )
      expect(blocked?.[0].metadata.reason).toBe("MEMBERSHIP_REVOKED")
    })

    it("allows full-balance approval because request already reserved the funds", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue(baseWithdrawal)
      prismaMock.withdrawal.findUniqueOrThrow.mockResolvedValue({
        id: "wd-1",
        status: "APPROVED",
      })
      prismaMock.publisherBalance.findUnique.mockResolvedValueOnce({
        ...balance,
        withdrawableBalance: new Decimal(0),
      })

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).resolves.toMatchObject({ status: "APPROVED" })
      expect(prismaMock.publisherBalance.findUnique).not.toHaveBeenCalled()
    })

    it("blocks when the active reservation does not exactly cover the withdrawal", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue(baseWithdrawal)
      prismaMock.withdrawalAllocation.findMany.mockResolvedValueOnce([])

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).rejects.toThrow(/reservation/i)
      const blocked = auditMock.log.mock.calls.find(
        (c: any) => c[0]?.action === "WITHDRAWAL_APPROVAL_BLOCKED",
      )
      expect(blocked?.[0].metadata.reason).toBe("RESERVATION_INVALID")
    })

    it("blocks with PAYOUT_METHOD_INVALID when the payout method was retired", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue(baseWithdrawal)
      prismaMock.payoutMethod.findFirst.mockResolvedValueOnce(null)

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).rejects.toThrow(/payout method/i)
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      const blocked = auditMock.log.mock.calls.find(
        (c: any) => c[0]?.action === "WITHDRAWAL_APPROVAL_BLOCKED",
      )
      expect(blocked?.[0].metadata.reason).toBe("PAYOUT_METHOD_INVALID")
    })

    it("blocks with ALREADY_EXECUTING when a payout execution is in flight", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue(baseWithdrawal)
      prismaMock.payoutExecution.count.mockResolvedValueOnce(1)

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).rejects.toThrow(/in flight/i)
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      const blocked = auditMock.log.mock.calls.find(
        (c: any) => c[0]?.action === "WITHDRAWAL_APPROVAL_BLOCKED",
      )
      expect(blocked?.[0].metadata.reason).toBe("ALREADY_EXECUTING")
    })

    it("commits a blocked audit before throwing the approval error", async () => {
      let transactionCommitted = false
      prismaMock.withdrawal.findUnique.mockResolvedValue({
        ...baseWithdrawal,
        status: "REJECTED",
      })
      prismaMock.$transaction.mockImplementationOnce(async (cb: any) => {
        const transactionResult = await cb(prismaMock)
        transactionCommitted = true
        return transactionResult
      })

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).rejects.toThrow(/no longer pending/i)
      expect(transactionCommitted).toBe(true)
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "WITHDRAWAL_APPROVAL_BLOCKED",
          metadata: expect.objectContaining({ reason: "NOT_PENDING" }),
        }),
        prismaMock,
      )
    })

    it("records a durable NOT_PENDING denial when the guarded status CAS loses", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue(baseWithdrawal)
      prismaMock.withdrawal.updateMany.mockResolvedValueOnce({ count: 0 })

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).rejects.toThrow(/no longer pending/i)
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "WITHDRAWAL_APPROVAL_BLOCKED",
          metadata: expect.objectContaining({ reason: "NOT_PENDING" }),
        }),
        prismaMock,
      )
    })

    it("retries PostgreSQL serialization failures before approving", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue(baseWithdrawal)
      prismaMock.withdrawal.findUniqueOrThrow.mockResolvedValue({
        id: "wd-1",
        status: "APPROVED",
      })
      prismaMock.$transaction
        .mockRejectedValueOnce({
          code: "P2010",
          meta: {
            driverAdapterError: {
              cause: { originalCode: "40001" },
            },
          },
        })
        .mockImplementationOnce(async (cb: any) => cb(prismaMock))

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).resolves.toMatchObject({ status: "APPROVED" })
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    })
  })

  describe("manual payout completion", () => {
    const paidAt = new Date("2026-07-29T08:00:00.000Z")
    const evidence = {
      withdrawalPublicReference: "GP-WD-ABCD2345",
      executionId: "exec-1",
      bankReference: "BANK-TRACE-123",
      paidAt: paidAt.toISOString(),
      reason: "Verified against the bank transfer receipt",
    }
    const manualWithdrawal = {
      id: "wd-1",
      publisherId: "pub-1",
      amount: new Decimal(100),
      netAmount: new Decimal(100),
      currency: "USD",
      publicReference: "GP-WD-ABCD2345",
      method: "bank_transfer",
      payoutMethodId: "pm-1",
      status: "PROCESSING",
      version: 4,
      requestedBy: "requester-1",
      approvedBy: "approver-1",
      approvedAt: new Date("2026-07-29T07:00:00.000Z"),
      publisher: { organizationId: "org-1" },
      payoutMethod: {
        id: "pm-1",
        publisherId: "pub-1",
        type: "bank_transfer",
        isActive: true,
      },
    }
    const manualExecution = {
      id: "exec-1",
      withdrawalId: "wd-1",
      providerId: "manual-1",
      livemode: null,
      status: "PROCESSING",
      stage: "PROVIDER_SENT",
      version: 2,
      initiatedByUserId: "initiator-1",
      providerExecutionId: "manual-payout-wd-1-v4",
      bankTraceReference: null,
      amount: new Decimal(100),
      sourceCurrency: "USD",
      destinationCurrency: "USD",
      destinationAmount: new Decimal(100),
      providerMetadata: { note: "Manual payout" },
      completionSource: null,
      completionEvidenceRef: null,
      completionEvidenceAt: null,
      completedAt: null,
      completionActorUserId: null,
      completionWebhookEventId: null,
      createdAt: new Date("2026-07-29T07:30:00.000Z"),
      provider: { id: "manual-1", name: "manual" },
      withdrawal: {
        ...manualWithdrawal,
        allocations: [
          {
            id: "allocation-1",
            amount: new Decimal(100),
            currency: "USD",
            releasedAt: null,
          },
        ],
      },
    }

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date("2026-07-29T09:00:00.000Z"))
      prismaMock.payoutExecution.findUnique.mockResolvedValue(manualExecution)
      prismaMock.withdrawal.findUniqueOrThrow.mockResolvedValue({
        ...manualWithdrawal,
        status: "COMPLETED",
        version: 5,
      })
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it("completes only the existing manual execution with bank evidence", async () => {
      const result = await service.completeManualWithdrawal(
        "wd-1",
        "checker-1",
        evidence,
      )

      expect(result).toMatchObject({ id: "wd-1", status: "COMPLETED" })
      const executionData =
        prismaMock.payoutExecution.updateMany.mock.calls[0][0].data
      expect(executionData).toEqual(
        expect.objectContaining({
          status: "COMPLETED",
          stage: "MANUAL_CONFIRMED",
          bankTraceReference: "BANK-TRACE-123",
          acceptedReference: "BANK-TRACE-123",
          version: { increment: 1 },
        }),
      )
      const withdrawalData =
        prismaMock.withdrawal.updateMany.mock.calls[0][0].data
      expect(withdrawalData).toEqual({
        status: "COMPLETED",
        version: { increment: 1 },
      })
      expect(withdrawalData).not.toHaveProperty("approvedBy")
      expect(withdrawalData).not.toHaveProperty("approvedAt")
      expect(prismaMock.publisherBalance.update).toHaveBeenCalledWith({
        where: { publisherId: "pub-1" },
        data: {
          lifetimePaid: { increment: new Decimal(100) },
          version: { increment: 1 },
        },
      })
    })

    it.each([
      {
        label: "does not match",
        canonicalReference: "GP-WD-ABCD2345",
        submittedReference: "GP-WD-DIFFERENT",
      },
      {
        label: "is missing from the legacy withdrawal",
        canonicalReference: null,
        submittedReference: "GP-WD-ABCD2345",
      },
    ])("fails closed when the public reference $label", async ({
      canonicalReference,
      submittedReference,
    }) => {
      prismaMock.payoutExecution.findUnique.mockResolvedValueOnce({
        ...manualExecution,
        withdrawal: {
          ...manualExecution.withdrawal,
          publicReference: canonicalReference,
        },
      })

      await expect(
        service.completeManualWithdrawal("wd-1", "checker-1", {
          ...evidence,
          withdrawalPublicReference: submittedReference,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "WITHDRAWAL_REFERENCE_MISMATCH",
        }),
      })
      expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "PAYOUT_COMPLETION_EVIDENCE_CONFLICT",
            metadata: expect.objectContaining({
              code: "WITHDRAWAL_REFERENCE_MISMATCH",
            }),
          }),
        }),
      )
      expect(prismaMock.payoutExecution.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.update).not.toHaveBeenCalled()
    })

    it("rejects automated executions without changing liability", async () => {
      prismaMock.payoutExecution.findUnique.mockResolvedValueOnce({
        ...manualExecution,
        provider: { id: "wise-1", name: "wise" },
      })

      await expect(
        service.completeManualWithdrawal("wd-1", "checker-1", evidence),
      ).rejects.toThrow(/provider/i)
      expect(prismaMock.payoutExecution.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.update).not.toHaveBeenCalled()
    })

    it("enforces maker-checker and commits the blocked audit", async () => {
      let transactionCommitted = false
      prismaMock.$transaction.mockImplementationOnce(async (cb: any) => {
        const transactionResult = await cb(prismaMock)
        transactionCommitted = true
        return transactionResult
      })

      await expect(
        service.completeManualWithdrawal("wd-1", "approver-1", evidence),
      ).rejects.toThrow(ForbiddenException)
      expect(transactionCommitted).toBe(true)
      expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "PAYOUT_COMPLETION_EVIDENCE_CONFLICT",
            metadata: expect.objectContaining({
              code: "MAKER_CHECKER_VIOLATION",
            }),
          }),
        }),
      )
      expect(prismaMock.publisherBalance.update).not.toHaveBeenCalled()
    })

    it("prevents the withdrawal requester from confirming their own manual payment", async () => {
      await expect(
        service.completeManualWithdrawal("wd-1", "requester-1", evidence),
      ).rejects.toThrow(ForbiddenException)
      expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "PAYOUT_COMPLETION_EVIDENCE_CONFLICT",
            metadata: expect.objectContaining({
              code: "MAKER_CHECKER_VIOLATION",
            }),
          }),
        }),
      )
      expect(prismaMock.publisherBalance.update).not.toHaveBeenCalled()
    })

    it("prevents the execution initiator from self-attesting manual payment", async () => {
      await expect(
        service.completeManualWithdrawal("wd-1", "initiator-1", evidence),
      ).rejects.toThrow(ForbiddenException)
      expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "PAYOUT_COMPLETION_EVIDENCE_CONFLICT",
            metadata: expect.objectContaining({
              code: "MAKER_CHECKER_VIOLATION",
            }),
          }),
        }),
      )
      expect(prismaMock.publisherBalance.update).not.toHaveBeenCalled()
    })

    it("blocks legacy manual payouts with missing requester provenance", async () => {
      prismaMock.payoutExecution.findUnique.mockResolvedValueOnce({
        ...manualExecution,
        withdrawal: {
          ...manualExecution.withdrawal,
          requestedBy: null,
        },
      })

      await expect(
        service.completeManualWithdrawal("wd-1", "checker-1", evidence),
      ).rejects.toThrow(ForbiddenException)
      expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "PAYOUT_COMPLETION_EVIDENCE_CONFLICT",
            metadata: expect.objectContaining({
              code: "MAKER_CHECKER_VIOLATION",
            }),
          }),
        }),
      )
      expect(prismaMock.payoutExecution.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.update).not.toHaveBeenCalled()
    })

    it("rejects a manual checker who is no longer eligible Finance staff", async () => {
      prismaMock.staffMembership.findFirst.mockResolvedValueOnce(null)

      await expect(
        service.completeManualWithdrawal("wd-1", "checker-1", evidence),
      ).rejects.toThrow(ConflictException)
      expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              code: "MANUAL_ACTOR_UNAUTHORIZED",
            }),
          }),
        }),
      )
      expect(prismaMock.publisherBalance.update).not.toHaveBeenCalled()
    })

    it("records terminal bank truth after the payout method is deactivated", async () => {
      prismaMock.payoutExecution.findUnique.mockResolvedValueOnce({
        ...manualExecution,
        withdrawal: {
          ...manualExecution.withdrawal,
          payoutMethod: {
            ...manualWithdrawal.payoutMethod,
            isActive: false,
          },
        },
      })

      await expect(
        service.completeManualWithdrawal("wd-1", "checker-1", evidence),
      ).resolves.toMatchObject({ status: "COMPLETED" })
      expect(prismaMock.publisherBalance.update).toHaveBeenCalledTimes(1)
    })

    it("treats an exact completed-evidence retry as idempotent", async () => {
      prismaMock.payoutExecution.findUnique.mockResolvedValueOnce({
        ...manualExecution,
        status: "COMPLETED",
        stage: "MANUAL_CONFIRMED",
        bankTraceReference: evidence.bankReference,
        completionSource: "MANUAL_BANK_CONFIRMATION",
        completionEvidenceRef: evidence.bankReference,
        completionEvidenceAt: paidAt,
        completedAt: new Date("2026-07-29T08:01:00.000Z"),
        completionActorUserId: "checker-1",
        providerMetadata: {
          completion: {
            reason: evidence.reason,
          },
        },
        withdrawal: {
          ...manualExecution.withdrawal,
          status: "COMPLETED",
        },
      })

      await expect(
        service.completeManualWithdrawal("wd-1", "checker-1", evidence),
      ).resolves.toMatchObject({ status: "COMPLETED" })
      expect(prismaMock.payoutExecution.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.update).not.toHaveBeenCalled()
    })

    it("rolls back when the execution CAS loses a status race", async () => {
      prismaMock.payoutExecution.updateMany.mockResolvedValueOnce({ count: 0 })

      await expect(
        service.completeManualWithdrawal("wd-1", "checker-1", evidence),
      ).rejects.toThrow(/changed during canonical completion/i)
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.update).not.toHaveBeenCalled()
    })
  })

  describe("rejectWithdrawal", () => {
    it("restores balance and writes WITHDRAWAL_REVERSAL ledger row", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue({
        id: "wd-1",
        status: "PENDING",
        version: 0,
        publisherId: "pub-1",
        amount: new Decimal(100),
        currency: "USD",
        publisher,
      })
      prismaMock.withdrawal.findUniqueOrThrow.mockResolvedValue({
        id: "wd-1",
        status: "REJECTED",
      })

      await service.rejectWithdrawal(
        "wd-1",
        "staff-1",
        "Risk review rejected this withdrawal",
      )

      const txCall = prismaMock.transaction.create.mock.calls[0][0]
      expect(txCall.data.type).toBe("WITHDRAWAL_REVERSAL")
      expect(txCall.data.reference).toBe("withdrawal-reject-wd-1")
      expect(txCall.data.currency).toBe("USD")
      const restored = prismaMock.publisherBalance.updateMany.mock.calls[0][0]
      expect(
        restored.data.withdrawableBalance.increment.equals(new Decimal(100)),
      ).toBe(true)
      const withdrawalLockCall =
        prismaMock.$queryRawUnsafe.mock.calls.findIndex((call: any[]) =>
          String(call[0]).includes('FROM "Withdrawal"'),
        )
      const executionLockCall = prismaMock.$queryRawUnsafe.mock.calls.findIndex(
        (call: any[]) => String(call[0]).includes('FROM "PayoutExecution"'),
      )
      const balanceLockCall = prismaMock.$queryRawUnsafe.mock.calls.findIndex(
        (call: any[]) => String(call[0]).includes('FROM "PublisherBalance"'),
      )
      expect(withdrawalLockCall).toBeGreaterThanOrEqual(0)
      expect(executionLockCall).toBeGreaterThan(withdrawalLockCall)
      expect(balanceLockCall).toBeGreaterThan(executionLockCall)
      expect(
        prismaMock.$queryRawUnsafe.mock.invocationCallOrder[balanceLockCall],
      ).toBeLessThan(
        prismaMock.withdrawal.updateMany.mock.invocationCallOrder[0],
      )
    })

    it("does not reinterpret stale pending-rejection intent after approval", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue({
        id: "wd-1",
        status: "APPROVED",
        version: 1,
        publisherId: "pub-1",
        amount: new Decimal(100),
        currency: "USD",
        approvedBy: "approver-1",
        approvedAt: new Date(),
        publisher,
      })

      await expect(
        service.rejectWithdrawal(
          "wd-1",
          "staff-1",
          "Finance intended to reject the still-pending request.",
        ),
      ).rejects.toThrow("Only pending withdrawals can be rejected")
      expect(prismaMock.payoutExecution.findMany).not.toHaveBeenCalled()
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
      expect(auditMock.log).not.toHaveBeenCalled()
    })

    it("does not restore funds for a non-USD withdrawal", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue({
        id: "wd-1",
        status: "PENDING",
        version: 0,
        publisherId: "pub-1",
        amount: new Decimal(100),
        currency: "EUR",
        publisher,
      })

      await expect(
        service.rejectWithdrawal(
          "wd-1",
          "staff-1",
          "Reject corrupt withdrawal currency safely.",
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "WITHDRAWAL_CURRENCY_INVALID",
        }),
      })
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.transaction.create).not.toHaveBeenCalled()
    })

    it("safely abandons an approved withdrawal with only pre-provider-aborted history", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue({
        id: "wd-1",
        status: "APPROVED",
        version: 2,
        publisherId: "pub-1",
        amount: new Decimal(100),
        currency: "USD",
        approvedBy: "approver-1",
        approvedAt: new Date(),
        publisher,
      })
      prismaMock.payoutExecution.findMany.mockResolvedValue([
        {
          id: "exec-1",
          status: "CANCELLED",
          stage: "PRE_PROVIDER_ABORTED",
          cancellationSource: "PRE_PROVIDER_ABORT",
          providerExecutionId: null,
          providerTransferId: null,
          providerPayoutId: null,
          acceptedReference: null,
          bankTraceReference: null,
        },
      ])
      prismaMock.withdrawal.findUniqueOrThrow.mockResolvedValue({
        id: "wd-1",
        status: "REJECTED",
        approvedBy: "approver-1",
      })

      await expect(
        service.abandonApprovedWithdrawal(
          "wd-1",
          "staff-1",
          "Destination is no longer usable; abandon before provider send.",
        ),
      ).resolves.toMatchObject({
        status: "REJECTED",
        approvedBy: "approver-1",
      })
      expect(prismaMock.withdrawal.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "APPROVED", version: 2 }),
          data: expect.not.objectContaining({
            approvedBy: expect.anything(),
            approvedAt: expect.anything(),
          }),
        }),
      )
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "WITHDRAWAL_PRE_PROVIDER_ABANDONED",
          metadata: expect.objectContaining({
            decision: "PRE_PROVIDER_ABANDONMENT",
            preservedApproverUserId: "approver-1",
          }),
        }),
        prismaMock,
      )
    })

    it("never abandons an approved withdrawal after any durable send claim", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue({
        id: "wd-1",
        status: "APPROVED",
        version: 2,
        publisherId: "pub-1",
        amount: new Decimal(100),
        currency: "USD",
        approvedBy: "approver-1",
        approvedAt: new Date(),
        publisher,
      })
      prismaMock.payoutExecutionClaim.count.mockResolvedValue(1)

      await expect(
        service.abandonApprovedWithdrawal(
          "wd-1",
          "staff-1",
          "Attempted abandonment after a durable provider claim.",
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "WITHDRAWAL_ABANDONMENT_NOT_PROVABLY_PRE_PROVIDER",
        }),
      })
      expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
    })
  })
})
