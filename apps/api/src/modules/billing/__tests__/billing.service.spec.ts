import { createHash } from "node:crypto"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { BillingService } from "../billing.service"
import { DepositProviderError } from "../providers/deposit-provider.interface"

describe("BillingService", () => {
  let service: BillingService
  let prismaMock: any
  let auditMock: any

  const mockWallet = {
    id: "wallet-1",
    organizationId: "org-1",
    userId: "user-1",
    availableBalance: new Decimal(1000),
    reservedBalance: new Decimal(200),
    currency: "USD",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const mockUser = { id: "user-1", organizationId: "org-1" }

  beforeEach(() => {
    auditMock = { log: jest.fn().mockResolvedValue(undefined) }

    prismaMock = {
      wallet: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: "order-1",
          organizationId: "org-1",
          currency: "USD",
        }),
      },
      transaction: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
      depositAttempt: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      paymentProviderEvent: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      auditLog: {
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      paymentDispute: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (work: any) =>
        typeof work === "function" ? work(prismaMock) : Promise.all(work),
      ),
    }

    service = new BillingService(prismaMock as any, auditMock as any)
  })

  describe("Stripe deposit attempts", () => {
    const previousFlag = process.env.STRIPE_DEPOSITS_ENABLED
    const previousStripeKey = process.env.STRIPE_SECRET_KEY

    const depositAttemptFixture = (
      overrides: Record<string, unknown> = {},
    ) => ({
      id: "dp-1",
      publicReference: "GP-DP-ABCD2345",
      walletId: "wallet-1",
      organizationId: "org-1",
      createdByUserId: "user-1",
      method: "CARD",
      provider: "stripe",
      amount: new Decimal(25),
      walletCredit: new Decimal(25),
      customerFee: new Decimal(0),
      providerFee: null,
      currency: "USD",
      status: "CREATED",
      idempotencyKey: "request-1",
      providerSessionId: null,
      providerPaymentId: null,
      providerChargeId: null,
      intendedOrderId: null,
      ledgerTransactionId: null,
      expiresAt: null,
      completedAt: null,
      failedAt: null,
      failureCode: null,
      ...overrides,
    })

    const depositSessionFixture = (
      overrides: Record<string, unknown> = {},
    ) => ({
      providerSessionId: "cs_1",
      providerObjectType: "checkout.session",
      providerPaymentId: "pi_1",
      clientReferenceId: "dp-1",
      metadata: {
        depositAttemptId: "dp-1",
        publicReference: "GP-DP-ABCD2345",
        walletId: "wallet-1",
        userId: "user-1",
        organizationId: "org-1",
      },
      amountTotalMinor: 2500,
      currency: "USD",
      mode: "payment",
      status: "open",
      url: "https://checkout.stripe.test/session",
      expiresAt: new Date("2026-08-04T00:00:00.000Z"),
      livemode: false,
      ...overrides,
    })

    beforeEach(() => {
      process.env.STRIPE_DEPOSITS_ENABLED = "true"
      process.env.STRIPE_SECRET_KEY = "sk_test_example"
      prismaMock.wallet.findUnique.mockResolvedValue(mockWallet)
    })

    afterAll(() => {
      if (previousFlag == null) delete process.env.STRIPE_DEPOSITS_ENABLED
      else process.env.STRIPE_DEPOSITS_ENABLED = previousFlag
      if (previousStripeKey == null) delete process.env.STRIPE_SECRET_KEY
      else process.env.STRIPE_SECRET_KEY = previousStripeKey
    })

    it("rejects idempotency-key reuse with a different amount", async () => {
      prismaMock.depositAttempt.findUnique.mockResolvedValue(
        depositAttemptFixture({
          amount: new Decimal(10),
          walletCredit: new Decimal(10),
        }),
      )
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        retrieveSession: jest.fn(),
      }

      await expect(
        service.createCheckoutSession("wallet-1", 20, mockUser, "request-1"),
      ).rejects.toThrow(ConflictException)
      expect(
        (service as any).depositProvider.retrieveSession,
      ).not.toHaveBeenCalled()
    })

    it.each([
      ["blank", "   "],
      ["oversized", "a".repeat(192)],
      ["unsafe characters", "deposit:key"],
    ])("rejects an explicitly %s idempotency key before provider I/O", async (_name, key) => {
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        createSession: jest.fn(),
        retrieveSession: jest.fn(),
      }

      await expect(
        service.createCheckoutSession("wallet-1", 25, mockUser, key),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DEPOSIT_IDEMPOTENCY_KEY_INVALID",
        }),
      })
      expect(prismaMock.depositAttempt.findUnique).not.toHaveBeenCalled()
      expect(
        (service as any).depositProvider.createSession,
      ).not.toHaveBeenCalled()
    })

    it.each([
      ["non-numeric", "not-money" as unknown as number],
      ["not finite", Number.NaN],
      ["zero", 0],
      ["negative", -1],
      ["fractional cent", 1.001],
    ])("rejects an invalid %s amount before persistence or provider I/O", async (_name, amount) => {
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        createSession: jest.fn(),
        retrieveSession: jest.fn(),
      }

      await expect(
        service.createCheckoutSession(
          "wallet-1",
          amount,
          mockUser,
          "request-1",
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "MONEY_AMOUNT_INVALID" }),
      })
      expect(prismaMock.depositAttempt.findUnique).not.toHaveBeenCalled()
      expect(
        (service as any).depositProvider.createSession,
      ).not.toHaveBeenCalled()
    })

    it.each([
      ["actor", { createdByUserId: "user-2" }],
      ["organization", { organizationId: "org-2" }],
      ["method", { method: "BANK_TRANSFER" }],
      ["provider", { provider: "manual" }],
      ["wallet credit", { walletCredit: new Decimal(24) }],
      ["customer fee", { customerFee: new Decimal(1) }],
      ["provider fee", { providerFee: new Decimal(1) }],
      ["order linkage", { intendedOrderId: "order-1" }],
      ["ledger linkage", { ledgerTransactionId: "txn-1" }],
      ["terminal status", { status: "SUCCEEDED" }],
    ])("rejects idempotency replay with mismatched %s evidence", async (_name, mismatch) => {
      prismaMock.depositAttempt.findUnique.mockResolvedValue(
        depositAttemptFixture(mismatch),
      )
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        retrieveSession: jest.fn(),
      }

      await expect(
        service.createCheckoutSession("wallet-1", 25, mockUser, "request-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DEPOSIT_IDEMPOTENCY_CONFLICT",
        }),
      })
      expect(
        (service as any).depositProvider.retrieveSession,
      ).not.toHaveBeenCalled()
    })

    it("applies the same exact evidence check after a P2002 reread", async () => {
      prismaMock.depositAttempt.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          depositAttemptFixture({ createdByUserId: "user-2" }),
        )
      prismaMock.depositAttempt.create.mockRejectedValue(
        Object.assign(new Error("unique"), { code: "P2002" }),
      )
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        createSession: jest.fn(),
      }

      await expect(
        service.createCheckoutSession("wallet-1", 25, mockUser, "request-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DEPOSIT_IDEMPOTENCY_CONFLICT",
        }),
      })
      expect(
        (service as any).depositProvider.createSession,
      ).not.toHaveBeenCalled()
    })

    it("creates a server-owned fee/reference snapshot before Checkout", async () => {
      prismaMock.depositAttempt.findUnique.mockResolvedValue(null)
      prismaMock.depositAttempt.create.mockResolvedValue(
        depositAttemptFixture({
          amount: new Decimal(20.5),
          walletCredit: new Decimal(20.5),
        }),
      )
      prismaMock.depositAttempt.updateMany.mockResolvedValue({ count: 1 })
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        createSession: jest.fn().mockResolvedValue(
          depositSessionFixture({
            providerPaymentId: null,
            amountTotalMinor: 2050,
          }),
        ),
      }

      const result = await service.createCheckoutSession(
        "wallet-1",
        20.5,
        mockUser,
        "request-1",
      )

      expect(prismaMock.depositAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: new Decimal(20.5),
          walletCredit: new Decimal(20.5),
          customerFee: 0,
          currency: "USD",
          method: "CARD",
          provider: "stripe",
        }),
      })
      expect(result).toMatchObject({
        publicReference: "GP-DP-ABCD2345",
        feePolicy: {
          grossMinor: 2050,
          customerOrPublisherFeeMinor: 0,
          netMinor: 2050,
        },
      })
      expect(prismaMock.depositAttempt.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: "dp-1",
          providerSessionId: null,
          status: { in: ["CREATED", "FAILED"] },
        }),
        data: expect.objectContaining({
          status: "PENDING_CUSTOMER_ACTION",
          failedAt: null,
          failureCode: null,
        }),
      })
    })

    it("fails the capability closed when the explicit flag or finance mode blocks deposits", () => {
      const previousMode = process.env.FINANCE_RUNTIME_MODE
      process.env.STRIPE_DEPOSITS_ENABLED = "false"
      expect(service.getDepositCapability()).toMatchObject({
        available: false,
        code: "CARD_DEPOSITS_DISABLED",
      })

      try {
        process.env.STRIPE_DEPOSITS_ENABLED = "true"
        process.env.FINANCE_RUNTIME_MODE = "recovery_only"
        expect(service.getDepositCapability()).toMatchObject({
          available: false,
          code: "FINANCE_OPERATIONS_UNAVAILABLE",
        })
      } finally {
        if (previousMode == null) delete process.env.FINANCE_RUNTIME_MODE
        else process.env.FINANCE_RUNTIME_MODE = previousMode
      }
    })

    it("persists only a categorical provider failure and returns a stable 503", async () => {
      prismaMock.depositAttempt.findUnique.mockResolvedValue(null)
      prismaMock.depositAttempt.create.mockResolvedValue(
        depositAttemptFixture({
          id: "dp-failed",
          publicReference: "GP-DP-FAILED",
          idempotencyKey: "provider-auth-failure",
        }),
      )
      prismaMock.depositAttempt.updateMany.mockResolvedValue({ count: 1 })
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        createSession: jest
          .fn()
          .mockRejectedValue(
            new DepositProviderError("PROVIDER_AUTHENTICATION_FAILED", false),
          ),
      }

      await expect(
        service.createCheckoutSession(
          "wallet-1",
          25,
          mockUser,
          "provider-auth-failure",
        ),
      ).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({
          code: "DEPOSIT_PROVIDER_UNAVAILABLE",
        }),
      })
      expect(prismaMock.depositAttempt.updateMany).toHaveBeenCalledWith({
        where: {
          id: "dp-failed",
          providerSessionId: null,
          status: { in: ["CREATED", "FAILED"] },
        },
        data: {
          status: "FAILED",
          failureCode: "PROVIDER_AUTHENTICATION_FAILED",
          failedAt: expect.any(Date),
        },
      })
      expect(
        JSON.stringify(prismaMock.depositAttempt.updateMany.mock.calls),
      ).not.toContain("api_key")
    })

    it("recovers an exact FAILED attempt and clears stale failure evidence", async () => {
      prismaMock.depositAttempt.findUnique.mockResolvedValue(
        depositAttemptFixture({
          id: "dp-retry",
          publicReference: "GP-DP-RETRY",
          status: "FAILED",
          idempotencyKey: "exact-retry",
          failureCode: "PROVIDER_AUTHENTICATION_FAILED",
          failedAt: new Date("2026-08-03T00:00:00.000Z"),
        }),
      )
      prismaMock.depositAttempt.updateMany.mockResolvedValue({ count: 1 })
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        createSession: jest.fn().mockResolvedValue(
          depositSessionFixture({
            providerSessionId: "cs_recovered",
            providerPaymentId: null,
            clientReferenceId: "dp-retry",
            metadata: {
              depositAttemptId: "dp-retry",
              publicReference: "GP-DP-RETRY",
              walletId: "wallet-1",
              userId: "user-1",
              organizationId: "org-1",
            },
            url: "https://checkout.stripe.test/recovered",
          }),
        ),
      }

      await expect(
        service.createCheckoutSession("wallet-1", 25, mockUser, "exact-retry"),
      ).resolves.toMatchObject({
        url: "https://checkout.stripe.test/recovered",
      })
      expect(prismaMock.depositAttempt.create).not.toHaveBeenCalled()
      expect(prismaMock.depositAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "dp-retry",
            providerSessionId: null,
            status: { in: ["CREATED", "FAILED"] },
          }),
          data: expect.objectContaining({
            status: "PENDING_CUSTOMER_ACTION",
            failedAt: null,
            failureCode: null,
          }),
        }),
      )
    })

    it("accepts an attachment CAS race only for the exact canonical pending session", async () => {
      const runAttachmentRace = async (current: Record<string, unknown>) => {
        prismaMock.depositAttempt.findUnique
          .mockReset()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(current)
        prismaMock.depositAttempt.create.mockReset().mockResolvedValue(
          depositAttemptFixture({
            id: "dp-race",
            publicReference: "GP-DP-RACE",
            idempotencyKey: "attachment-race",
          }),
        )
        prismaMock.depositAttempt.updateMany
          .mockReset()
          .mockResolvedValue({ count: 0 })
        ;(service as any).depositProvider = {
          capabilities: { supportedCurrencies: ["USD"] },
          createSession: jest.fn().mockResolvedValue(
            depositSessionFixture({
              providerSessionId: "cs-race",
              providerPaymentId: "pi-race",
              clientReferenceId: "dp-race",
              metadata: {
                depositAttemptId: "dp-race",
                publicReference: "GP-DP-RACE",
                walletId: "wallet-1",
                userId: "user-1",
                organizationId: "org-1",
              },
              url: "https://checkout.stripe.test/race",
            }),
          ),
        }

        return service.createCheckoutSession(
          "wallet-1",
          25,
          mockUser,
          "attachment-race",
        )
      }

      await expect(
        runAttachmentRace(
          depositAttemptFixture({
            id: "dp-race",
            publicReference: "GP-DP-RACE",
            idempotencyKey: "attachment-race",
            providerSessionId: "cs-race",
            providerPaymentId: "pi-race",
            status: "PENDING_CUSTOMER_ACTION",
            expiresAt: new Date("2026-08-04T00:00:00.000Z"),
          }),
        ),
      ).resolves.toMatchObject({
        url: "https://checkout.stripe.test/race",
        publicReference: "GP-DP-RACE",
      })

      await expect(
        runAttachmentRace(
          depositAttemptFixture({
            id: "dp-race",
            publicReference: "GP-DP-RACE",
            idempotencyKey: "attachment-race",
            providerSessionId: "cs-other",
            providerPaymentId: "pi-race",
            status: "PENDING_CUSTOMER_ACTION",
            expiresAt: new Date("2026-08-04T00:00:00.000Z"),
          }),
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DEPOSIT_SESSION_ATTACHMENT_RACE",
        }),
      })

      await expect(
        runAttachmentRace(
          depositAttemptFixture({
            id: "dp-race",
            publicReference: "GP-DP-RACE",
            idempotencyKey: "attachment-race",
            providerSessionId: "cs-race",
            providerPaymentId: "pi-race",
            status: "FAILED",
            expiresAt: new Date("2026-08-04T00:00:00.000Z"),
            failureCode: "PROVIDER_UNAVAILABLE",
            failedAt: new Date("2026-08-03T00:00:00.000Z"),
          }),
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DEPOSIT_SESSION_ATTACHMENT_RACE",
        }),
      })
      expect(prismaMock.wallet.update).not.toHaveBeenCalled()
      expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.transaction.create).not.toHaveBeenCalled()
    })

    it("returns a sanitized state error when failure evidence cannot be persisted", async () => {
      const rawProviderText = "provider response contained sk_test_do_not_leak"
      const rawDatabaseText =
        "database failure at postgresql://money-writer:secret@internal"
      const loggerError = jest.fn()
      ;(service as any).logger.error = loggerError
      prismaMock.depositAttempt.findUnique.mockResolvedValue(null)
      prismaMock.depositAttempt.create.mockResolvedValue(
        depositAttemptFixture({
          id: "dp-state-failure",
          publicReference: "GP-DP-STATE",
          idempotencyKey: "failure-evidence-write",
        }),
      )
      prismaMock.depositAttempt.updateMany.mockRejectedValue(
        new Error(rawDatabaseText),
      )
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        createSession: jest.fn().mockRejectedValue(new Error(rawProviderText)),
      }

      let caught: unknown
      try {
        await service.createCheckoutSession(
          "wallet-1",
          25,
          mockUser,
          "failure-evidence-write",
        )
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(ServiceUnavailableException)
      expect(
        (caught as ServiceUnavailableException).getResponse(),
      ).toMatchObject({
        code: "DEPOSIT_STATE_UNAVAILABLE",
        message:
          "Secure card checkout could not be recorded safely. Please try again later.",
      })
      const observable = JSON.stringify({
        response: (caught as ServiceUnavailableException).getResponse(),
        logs: loggerError.mock.calls,
        writes: prismaMock.depositAttempt.updateMany.mock.calls,
      })
      expect(observable).not.toContain(rawProviderText)
      expect(observable).not.toContain(rawDatabaseText)
      expect(observable).not.toContain("sk_test_do_not_leak")
      expect(observable).not.toContain("money-writer:secret")
      expect(prismaMock.wallet.update).not.toHaveBeenCalled()
      expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.transaction.create).not.toHaveBeenCalled()
    })

    it("maps an idempotent provider-session recovery failure without mutating the attempt", async () => {
      prismaMock.depositAttempt.findUnique.mockResolvedValue(
        depositAttemptFixture({
          id: "dp-existing-session",
          publicReference: "GP-DP-EXISTING",
          status: "PENDING_CUSTOMER_ACTION",
          providerSessionId: "cs_existing",
          providerPaymentId: "pi_existing",
          expiresAt: new Date("2026-08-04T00:00:00.000Z"),
          idempotencyKey: "existing-session",
        }),
      )
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        retrieveSession: jest
          .fn()
          .mockRejectedValue(
            new DepositProviderError("PROVIDER_UNAVAILABLE", true),
          ),
      }

      await expect(
        service.createCheckoutSession(
          "wallet-1",
          25,
          mockUser,
          "existing-session",
        ),
      ).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({
          code: "DEPOSIT_PROVIDER_UNAVAILABLE",
        }),
      })
      expect(prismaMock.depositAttempt.updateMany).not.toHaveBeenCalled()
    })

    it("returns only a remotely revalidated exact open Checkout session", async () => {
      const expiresAt = new Date("2026-08-04T00:00:00.000Z")
      prismaMock.depositAttempt.findUnique.mockResolvedValue(
        depositAttemptFixture({
          id: "dp-existing-session",
          publicReference: "GP-DP-EXISTING",
          status: "PENDING_CUSTOMER_ACTION",
          providerSessionId: "cs_existing",
          providerPaymentId: "pi_existing",
          expiresAt,
          idempotencyKey: "existing-session",
        }),
      )
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        retrieveSession: jest.fn().mockResolvedValue(
          depositSessionFixture({
            providerSessionId: "cs_existing",
            providerPaymentId: "pi_existing",
            clientReferenceId: "dp-existing-session",
            metadata: {
              depositAttemptId: "dp-existing-session",
              publicReference: "GP-DP-EXISTING",
              walletId: "wallet-1",
              userId: "user-1",
              organizationId: "org-1",
            },
            expiresAt,
          }),
        ),
      }

      await expect(
        service.createCheckoutSession(
          "wallet-1",
          25,
          mockUser,
          "existing-session",
        ),
      ).resolves.toMatchObject({
        url: "https://checkout.stripe.test/session",
        publicReference: "GP-DP-EXISTING",
      })
      expect(prismaMock.depositAttempt.updateMany).not.toHaveBeenCalled()
    })

    it.each([
      ["provider identity", { providerSessionId: "cs_other" }],
      ["client reference", { clientReferenceId: "dp-other" }],
      [
        "metadata wallet binding",
        {
          metadata: {
            depositAttemptId: "dp-existing-session",
            publicReference: "GP-DP-EXISTING",
            walletId: "wallet-other",
            userId: "user-1",
            organizationId: "org-1",
          },
        },
      ],
      ["amount", { amountTotalMinor: 2499 }],
      ["currency", { currency: "EUR" }],
      ["Checkout mode", { mode: "subscription" }],
      ["Stripe environment", { livemode: true }],
      ["HTTPS return URL", { url: "http://checkout.stripe.test/session" }],
      ["Stripe Checkout host", { url: "https://attacker.invalid/session" }],
    ])("rejects recovered Checkout with mismatched %s evidence", async (_name, mismatch) => {
      const expiresAt = new Date("2026-08-04T00:00:00.000Z")
      prismaMock.depositAttempt.findUnique.mockResolvedValue(
        depositAttemptFixture({
          id: "dp-existing-session",
          publicReference: "GP-DP-EXISTING",
          status: "PENDING_CUSTOMER_ACTION",
          providerSessionId: "cs_existing",
          providerPaymentId: "pi_existing",
          expiresAt,
          idempotencyKey: "existing-session",
        }),
      )
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        retrieveSession: jest.fn().mockResolvedValue(
          depositSessionFixture({
            providerSessionId: "cs_existing",
            providerPaymentId: "pi_existing",
            clientReferenceId: "dp-existing-session",
            metadata: {
              depositAttemptId: "dp-existing-session",
              publicReference: "GP-DP-EXISTING",
              walletId: "wallet-1",
              userId: "user-1",
              organizationId: "org-1",
            },
            expiresAt,
            ...mismatch,
          }),
        ),
      }

      await expect(
        service.createCheckoutSession(
          "wallet-1",
          25,
          mockUser,
          "existing-session",
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DEPOSIT_PROVIDER_UNAVAILABLE",
        }),
      })
      expect(prismaMock.depositAttempt.updateMany).not.toHaveBeenCalled()
    })

    it("rejects malformed new Checkout evidence before attaching it", async () => {
      prismaMock.depositAttempt.findUnique.mockResolvedValue(null)
      prismaMock.depositAttempt.create.mockResolvedValue(
        depositAttemptFixture({ idempotencyKey: "malformed-checkout" }),
      )
      prismaMock.depositAttempt.updateMany.mockResolvedValue({ count: 1 })
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        createSession: jest.fn().mockResolvedValue(
          depositSessionFixture({
            amountTotalMinor: 2499,
            url: "http://attacker.invalid/checkout",
          }),
        ),
      }

      await expect(
        service.createCheckoutSession(
          "wallet-1",
          25,
          mockUser,
          "malformed-checkout",
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DEPOSIT_PROVIDER_UNAVAILABLE",
        }),
      })
      expect(prismaMock.depositAttempt.updateMany).toHaveBeenCalledTimes(1)
      expect(prismaMock.depositAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "FAILED",
            failureCode: "PROVIDER_RESPONSE_INVALID",
          }),
        }),
      )
    })

    it.each([
      ["exact", false],
      ["mismatched", true],
    ])("handles a provider-failure CAS loser only after an %s successor reread", async (_name, mismatched) => {
      const successor = depositAttemptFixture({
        id: "dp-failure-race",
        publicReference: "GP-DP-FAILRACE",
        idempotencyKey: "provider-failure-race",
        status: "PENDING_CUSTOMER_ACTION",
        providerSessionId: "cs_successor",
        providerPaymentId: "pi_successor",
        expiresAt: new Date("2026-08-04T00:00:00.000Z"),
        ...(mismatched ? { createdByUserId: "user-other" } : {}),
      })
      prismaMock.depositAttempt.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(successor)
      prismaMock.depositAttempt.create.mockResolvedValue(
        depositAttemptFixture({
          id: "dp-failure-race",
          publicReference: "GP-DP-FAILRACE",
          idempotencyKey: "provider-failure-race",
        }),
      )
      prismaMock.depositAttempt.updateMany.mockResolvedValue({ count: 0 })
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        createSession: jest
          .fn()
          .mockRejectedValue(
            new DepositProviderError("PROVIDER_UNAVAILABLE", true),
          ),
      }

      await expect(
        service.createCheckoutSession(
          "wallet-1",
          25,
          mockUser,
          "provider-failure-race",
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: mismatched
            ? "DEPOSIT_STATE_UNAVAILABLE"
            : "DEPOSIT_PROVIDER_UNAVAILABLE",
        }),
      })
      expect(prismaMock.depositAttempt.findUnique).toHaveBeenCalledTimes(2)
    })

    it("rejects a non-canonical wallet currency before creating a deposit attempt", async () => {
      prismaMock.wallet.findUnique.mockResolvedValue({
        ...mockWallet,
        currency: "usd",
      })

      await expect(
        service.createCheckoutSession("wallet-1", 20, mockUser, "request-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "WALLET_CURRENCY_UNSUPPORTED",
        }),
      })
      expect(prismaMock.depositAttempt.create).not.toHaveBeenCalled()
    })
  })

  describe("getWallet", () => {
    it("returns an existing organization wallet without writing", async () => {
      prismaMock.wallet.findUnique.mockResolvedValue(mockWallet)

      await expect(service.getWallet("org-1", "user-1")).resolves.toBe(
        mockWallet,
      )
      expect(prismaMock.wallet.upsert).not.toHaveBeenCalled()
      expect(prismaMock.wallet.create).not.toHaveBeenCalled()
    })

    it("404s without mutating when an organization wallet is missing", async () => {
      prismaMock.wallet.findUnique.mockResolvedValue(null)

      await expect(service.getWallet("org-1", "user-1")).rejects.toThrow(
        "Wallet is not provisioned",
      )
      expect(prismaMock.wallet.upsert).not.toHaveBeenCalled()
      expect(prismaMock.wallet.create).not.toHaveBeenCalled()
    })

    it("returns an existing legacy personal wallet without writing", async () => {
      const personalWallet = { ...mockWallet, organizationId: null }
      prismaMock.wallet.findFirst.mockResolvedValue(personalWallet)

      await expect(service.getWallet(null, "user-1")).resolves.toBe(
        personalWallet,
      )
      expect(prismaMock.wallet.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1", organizationId: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      )
      expect(prismaMock.wallet.create).not.toHaveBeenCalled()
    })

    it("404s without mutating when a legacy personal wallet is missing", async () => {
      prismaMock.wallet.findFirst.mockResolvedValue(null)

      await expect(service.getWallet(null, "user-1")).rejects.toThrow(
        "Wallet is not provisioned",
      )
      expect(prismaMock.wallet.findFirst).toHaveBeenCalledTimes(1)
      expect(prismaMock.wallet.create).not.toHaveBeenCalled()
    })
  })

  describe("buyer wallet cash-out containment", () => {
    it("does not expose an internal withdrawal money mutation", () => {
      expect((service as any).withdraw).toBeUndefined()
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.transaction.create).not.toHaveBeenCalled()
      expect(auditMock.log).not.toHaveBeenCalled()
    })
  })

  describe("reserve", () => {
    it("moves funds from available to reserved", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.wallet.updateMany.mockResolvedValue({ count: 1 })
        prismaMock.wallet.findUniqueOrThrow
          .mockResolvedValueOnce(mockWallet)
          .mockResolvedValueOnce({
            ...mockWallet,
            availableBalance: new Decimal(800),
            reservedBalance: new Decimal(400),
            version: 2,
          })
        return cb(prismaMock)
      })

      const result = await service.reserve("wallet-1", 200, "order-1", mockUser)

      expect(Number(result.availableBalance)).toBe(800)
      expect(Number(result.reservedBalance)).toBe(400)
      expect(prismaMock.wallet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            availableBalance: { decrement: new Decimal(200) },
            reservedBalance: { increment: new Decimal(200) },
          }),
        }),
      )
      expect(prismaMock.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: "RESERVATION",
          currency: "USD",
          amount: new Decimal(-200),
        }),
      })
    })

    it("rejects a non-USD order before reserving wallet funds", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.order.findUnique.mockResolvedValue({
          id: "order-1",
          organizationId: "org-1",
          currency: "EUR",
        })
        return cb(prismaMock)
      })

      await expect(
        service.reserve("wallet-1", 200, "order-1", mockUser),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "ORDER_CURRENCY_UNSUPPORTED",
        }),
      })
      expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.transaction.create).not.toHaveBeenCalled()
    })

    it("returns a stable 409 and moves no money when dispute exposure is uncovered", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.paymentDispute.findFirst.mockResolvedValue({
          id: "dispute-1",
        })
        return cb(prismaMock)
      })

      let blocked: unknown
      try {
        await service.reserve("wallet-1", 200, "order-1", mockUser)
      } catch (error) {
        blocked = error
      }
      expect(blocked).toBeInstanceOf(ConflictException)
      const conflict = blocked as ConflictException
      expect(conflict.getStatus()).toBe(409)
      expect(conflict.getResponse()).toMatchObject({
        code: "WALLET_SPEND_BLOCKED_BY_DISPUTE",
        message:
          "Wallet spending is unavailable while a payment dispute has uncovered exposure",
      })
      expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
        'SELECT "id" FROM "Wallet" WHERE "id" = $1 FOR UPDATE',
        "wallet-1",
      )
      expect(prismaMock.paymentDispute.findFirst).toHaveBeenCalledWith({
        where: {
          walletId: "wallet-1",
          status: { in: ["OPEN", "LOST"] },
          currentExposureAmount: { gt: 0 },
        },
        select: { id: true },
      })
      expect(
        prismaMock.$queryRawUnsafe.mock.invocationCallOrder[0],
      ).toBeLessThan(
        prismaMock.paymentDispute.findFirst.mock.invocationCallOrder[0],
      )
      expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.transaction.create).not.toHaveBeenCalled()
    })

    it("rejects insufficient available balance", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        return cb(prismaMock)
      })

      await expect(
        service.reserve("wallet-1", 5000, "order-1", mockUser),
      ).rejects.toThrow(BadRequestException)
    })

    it("throws ConflictException on version mismatch during concurrent reserve", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.wallet.updateMany.mockResolvedValue({ count: 0 })
        return cb(prismaMock)
      })

      await expect(
        service.reserve("wallet-1", 200, "order-1", mockUser),
      ).rejects.toThrow(ConflictException)
    })
  })

  describe("payFromReserved", () => {
    it("decrements reserved balance", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.wallet.updateMany.mockResolvedValue({ count: 1 })
        prismaMock.wallet.findUniqueOrThrow
          .mockResolvedValueOnce(mockWallet)
          .mockResolvedValueOnce({
            ...mockWallet,
            reservedBalance: new Decimal(100),
            version: 2,
          })
        return cb(prismaMock)
      })

      const result = await service.payFromReserved(
        "wallet-1",
        100,
        "order-1",
        mockUser,
      )

      expect(Number(result.reservedBalance)).toBe(100)
      expect(prismaMock.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: "PURCHASE",
          currency: "USD",
          amount: new Decimal(-100),
        }),
      })
    })

    it("locks and blocks capture when dispute exposure is uncovered", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.paymentDispute.findFirst.mockResolvedValue({
          id: "dispute-1",
        })
        return cb(prismaMock)
      })

      let blocked: unknown
      try {
        await service.payFromReserved("wallet-1", 100, "order-1", mockUser)
      } catch (error) {
        blocked = error
      }

      expect(blocked).toBeInstanceOf(ConflictException)
      expect((blocked as ConflictException).getResponse()).toMatchObject({
        code: "WALLET_SPEND_BLOCKED_BY_DISPUTE",
      })
      expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
        'SELECT "id" FROM "Wallet" WHERE "id" = $1 FOR UPDATE',
        "wallet-1",
      )
      expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.transaction.create).not.toHaveBeenCalled()
    })

    it("rejects insufficient reserved balance", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        return cb(prismaMock)
      })

      await expect(
        service.payFromReserved("wallet-1", 9999, "order-1", mockUser),
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe("handleWebhook", () => {
    it.each([
      ["missing", undefined],
      ["malformed", "definitely-not-a-stripe-key"],
    ])("rejects a signed test-mode event with a %s Stripe key before inbox or money processing", async (_label, key) => {
      const previousKey = process.env.STRIPE_SECRET_KEY
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
      if (key === undefined) delete process.env.STRIPE_SECRET_KEY
      else process.env.STRIPE_SECRET_KEY = key
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit"
      const adapter = {
        capabilities: { supportedCurrencies: ["USD"] },
        verifyWebhook: jest.fn().mockReturnValue({
          id: "evt_mode_without_valid_key",
          type: "checkout.session.completed",
          livemode: false,
          data: {
            object: {
              id: "cs_mode_without_valid_key",
              payment_intent: "pi_mode_without_valid_key",
              amount_total: 1000,
              currency: "usd",
              payment_status: "paid",
              metadata: { depositAttemptId: "attempt-1" },
            },
          },
        }),
      }
      service = new BillingService(prismaMock, auditMock, {
        getAdapter: () => adapter,
      } as any)

      try {
        await expect(
          service.handleWebhook("signed", Buffer.from("{}")),
        ).rejects.toThrow(BadRequestException)
        expect(prismaMock.paymentProviderEvent.create).not.toHaveBeenCalled()
        expect(
          prismaMock.paymentProviderEvent.updateMany,
        ).not.toHaveBeenCalled()
        expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
        expect(prismaMock.transaction.create).not.toHaveBeenCalled()
        if (key === undefined) {
          expect(adapter.verifyWebhook).not.toHaveBeenCalled()
        } else {
          expect(adapter.verifyWebhook).toHaveBeenCalledTimes(1)
        }
      } finally {
        if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
        else process.env.STRIPE_SECRET_KEY = previousKey
        if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
        else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    })

    it("rejects webhook in production without Stripe configured", async () => {
      const originalEnv = process.env.NODE_ENV
      process.env.NODE_ENV = "production"
      process.env.STRIPE_SECRET_KEY = ""

      service = new BillingService(prismaMock as any, auditMock as any)

      await expect(
        service.handleWebhook("dummy", Buffer.from("{}")),
      ).rejects.toThrow(BadRequestException)

      process.env.NODE_ENV = originalEnv
    })

    it("rejects webhook without webhook secret in any environment", async () => {
      process.env.STRIPE_SECRET_KEY = ""

      service = new BillingService(prismaMock as any, auditMock as any)

      await expect(
        service.handleWebhook("dummy", Buffer.from("{}")),
      ).rejects.toThrow(BadRequestException)
    })

    it("durably quarantines a malformed signed dispute without trusting metadata as an FK", async () => {
      const previousKey = process.env.STRIPE_SECRET_KEY
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
      process.env.STRIPE_SECRET_KEY = "rk_test_unit"
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit"
      const event = {
        id: "evt_bad_dispute",
        type: "charge.dispute.created",
        livemode: false,
        data: {
          object: {
            id: "dp_bad",
            payment_intent: null,
            amount: 1000,
            currency: "usd",
            status: "needs_response",
            metadata: { depositAttemptId: "nonexistent-fk" },
          },
        },
      }
      const adapter = {
        capabilities: { supportedCurrencies: ["USD"] },
        verifyWebhook: jest.fn().mockReturnValue(event),
      }
      let quarantinedProcessedAt: Date | null = null
      prismaMock.paymentProviderEvent.create.mockImplementation(
        ({ data }: any) => {
          quarantinedProcessedAt = data.processedAt
          return Promise.resolve({ id: "inbox-1", ...data })
        },
      )
      prismaMock.paymentProviderEvent.findUnique.mockImplementation(() =>
        Promise.resolve({
          id: "inbox-1",
          provider: "stripe",
          providerEventId: event.id,
          eventType: event.type,
          status: "QUARANTINED",
          attempts: 0,
          lockedAt: null,
          // Re-read the exact persisted fence. A fresh Date made this test
          // millisecond-dependent even though PostgreSQL returns the value
          // written by the create above.
          processedAt: quarantinedProcessedAt,
        }),
      )
      prismaMock.$transaction.mockImplementation((callback: any) =>
        callback(prismaMock),
      )
      service = new BillingService(prismaMock, auditMock, {
        getAdapter: () => adapter,
      } as any)

      try {
        await expect(
          service.handleWebhook("signed", Buffer.from("{}")),
        ).resolves.toEqual(
          expect.objectContaining({ received: true, quarantined: true }),
        )
        expect(prismaMock.paymentProviderEvent.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            status: "QUARANTINED",
            depositAttemptId: null,
            providerPaymentId: null,
            lastError: "INVALID_DISPUTE_ENVELOPE",
          }),
        })
        expect(auditMock.log).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "PAYMENT_PROVIDER_EVENT_QUARANTINED",
          }),
          prismaMock,
        )
        expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
      } finally {
        if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
        else process.env.STRIPE_SECRET_KEY = previousKey
        if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
        else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    })

    it("quarantines a reused provider event id when its signed financial envelope differs", async () => {
      const previousKey = process.env.STRIPE_SECRET_KEY
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
      process.env.STRIPE_SECRET_KEY = "rk_test_unit"
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit"
      const processedAt = new Date("2026-07-29T00:00:00Z")
      const event = {
        id: "evt_collision",
        type: "charge.dispute.created",
        livemode: false,
        data: {
          object: {
            id: "dp_collision",
            payment_intent: "pi_expected",
            charge: "ch_expected",
            amount: 1000,
            currency: "usd",
            status: "needs_response",
          },
        },
      }
      const conflictingRow = {
        id: "inbox-collision",
        provider: "stripe",
        providerEventId: event.id,
        eventType: event.type,
        objectId: "dp_collision",
        providerPaymentId: "pi_different",
        providerChargeId: "ch_expected",
        disputeAmountMinor: 1000n,
        disputeCurrency: "USD",
        providerStatus: "needs_response",
        livemode: false,
        eventFingerprint: "0".repeat(64),
        status: "PROCESSED",
        attempts: 1,
        lockedAt: null,
        processedAt,
        openedPaymentDispute: null,
        resolvedPaymentDispute: null,
      }
      prismaMock.paymentProviderEvent.create.mockRejectedValue(
        Object.assign(new Error("unique"), { code: "P2002" }),
      )
      prismaMock.paymentProviderEvent.findUnique.mockResolvedValue(
        conflictingRow,
      )
      prismaMock.paymentProviderEvent.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.$transaction.mockImplementation((callback: any) =>
        callback(prismaMock),
      )
      const adapter = {
        capabilities: { supportedCurrencies: ["USD"] },
        verifyWebhook: jest.fn().mockReturnValue(event),
      }
      service = new BillingService(prismaMock, auditMock, {
        getAdapter: () => adapter,
      } as any)

      try {
        await expect(
          service.handleWebhook("signed", Buffer.from("{}")),
        ).resolves.toEqual({
          received: true,
          duplicate: true,
          identityConflict: true,
          quarantined: true,
          canonicalEvidenceRetained: false,
        })
        expect(prismaMock.paymentProviderEvent.updateMany).toHaveBeenCalledWith(
          {
            where: expect.objectContaining({
              id: "inbox-collision",
              status: "PROCESSED",
              attempts: 1,
              lockedAt: null,
              processedAt,
            }),
            data: expect.objectContaining({
              status: "QUARANTINED",
              processedAt,
              lastError: "DUPLICATE_EVENT_ENVELOPE_MISMATCH",
            }),
          },
        )
        expect(auditMock.log).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "PAYMENT_PROVIDER_EVENT_IDENTITY_CONFLICT_QUARANTINED",
            entityId: "inbox-collision",
          }),
          prismaMock,
        )
      } finally {
        if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
        else process.env.STRIPE_SECRET_KEY = previousKey
        if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
        else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    })

    it("retains canonical dispute-role evidence and deduplicates repeated identity-conflict incidents", async () => {
      const previousKey = process.env.STRIPE_SECRET_KEY
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
      process.env.STRIPE_SECRET_KEY = "rk_test_unit"
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit"
      const processedAt = new Date("2026-07-29T00:00:00Z")
      const event = {
        id: "evt_canonical_collision",
        type: "charge.dispute.created",
        livemode: false,
        data: {
          object: {
            id: "dp_canonical_collision",
            payment_intent: "pi_expected",
            charge: "ch_expected",
            amount: 1000,
            currency: "usd",
            status: "needs_response",
          },
        },
      }
      const canonicalRow = {
        id: "inbox-canonical-collision",
        provider: "stripe",
        providerEventId: event.id,
        eventType: event.type,
        objectId: "dp_canonical_collision",
        providerPaymentId: "pi_different",
        providerChargeId: "ch_expected",
        disputeAmountMinor: 1000n,
        disputeCurrency: "USD",
        providerStatus: "needs_response",
        livemode: false,
        eventFingerprint: "0".repeat(64),
        status: "PROCESSED",
        attempts: 1,
        lockedAt: null,
        processedAt,
        paymentDisputeId: "case-canonical-collision",
        openedPaymentDispute: { id: "case-canonical-collision" },
        resolvedPaymentDispute: null,
      }
      prismaMock.paymentProviderEvent.create.mockRejectedValue(
        Object.assign(new Error("unique"), { code: "P2002" }),
      )
      prismaMock.paymentProviderEvent.findUnique.mockResolvedValue(canonicalRow)
      prismaMock.auditLog.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "audit-conflict" })
      prismaMock.staffMembership.findMany.mockResolvedValue([
        { userId: "finance-1" },
      ])
      prismaMock.notification.createMany.mockResolvedValue({ count: 1 })
      prismaMock.$transaction.mockImplementation((callback: any) =>
        callback(prismaMock),
      )
      const adapter = {
        capabilities: { supportedCurrencies: ["USD"] },
        verifyWebhook: jest.fn().mockReturnValue(event),
      }
      service = new BillingService(prismaMock, auditMock, {
        getAdapter: () => adapter,
      } as any)

      const expected = {
        received: true,
        duplicate: true,
        identityConflict: true,
        quarantined: false,
        canonicalEvidenceRetained: true,
      }
      try {
        await expect(
          service.handleWebhook("signed", Buffer.from("{}")),
        ).resolves.toEqual(expected)
        await expect(
          service.handleWebhook("signed", Buffer.from("{}")),
        ).resolves.toEqual(expected)

        expect(
          prismaMock.paymentProviderEvent.updateMany,
        ).not.toHaveBeenCalled()
        expect(auditMock.log).toHaveBeenCalledTimes(1)
        expect(auditMock.log).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "PAYMENT_PROVIDER_EVENT_IDENTITY_CONFLICT_DETECTED",
            entityId: "inbox-canonical-collision",
            metadata: expect.objectContaining({
              canonicalEvidenceRetained: true,
              openedPaymentDisputeId: "case-canonical-collision",
              resolvedPaymentDisputeId: null,
            }),
          }),
          prismaMock,
        )
        expect(prismaMock.notification.createMany).toHaveBeenCalledWith({
          data: [
            expect.objectContaining({
              type: "PAYMENT_PROVIDER_EVENT_IDENTITY_CONFLICT",
              dedupKey:
                "payment-provider-event-identity-conflict:inbox-canonical-collision:finance-1",
            }),
          ],
          skipDuplicates: true,
        })
      } finally {
        if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
        else process.env.STRIPE_SECRET_KEY = previousKey
        if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
        else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    })

    it("hashes an overlong signed provider event id instead of truncating its unique identity", async () => {
      const previousKey = process.env.STRIPE_SECRET_KEY
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
      process.env.STRIPE_SECRET_KEY = "rk_test_unit"
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit"
      const rawProviderEventId = `evt_${"shared-prefix".repeat(20)}_tail`
      const expectedProviderEventId = `sha256:${createHash("sha256")
        .update(rawProviderEventId)
        .digest("hex")}`
      const event = {
        id: rawProviderEventId,
        type: "customer.updated",
        livemode: false,
        data: { object: { id: "cus_unit" } },
      }
      prismaMock.paymentProviderEvent.create.mockImplementation(
        ({ data }: any) => Promise.resolve({ id: "inbox-long-id", ...data }),
      )
      prismaMock.paymentProviderEvent.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
      const adapter = {
        capabilities: { supportedCurrencies: ["USD"] },
        verifyWebhook: jest.fn().mockReturnValue(event),
      }
      service = new BillingService(prismaMock, auditMock, {
        getAdapter: () => adapter,
      } as any)

      try {
        await expect(
          service.handleWebhook("signed", Buffer.from("{}")),
        ).resolves.toEqual({ received: true, ignored: true })
        expect(prismaMock.paymentProviderEvent.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            providerEventId: expectedProviderEventId,
          }),
        })
        expect(expectedProviderEventId).toHaveLength(71)
      } finally {
        if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
        else process.env.STRIPE_SECRET_KEY = previousKey
        if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
        else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    })

    it("cannot ignore or fail an event after a newer inbox lease takes ownership", async () => {
      const previousKey = process.env.STRIPE_SECRET_KEY
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
      process.env.STRIPE_SECRET_KEY = "rk_test_unit"
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit"
      const event = {
        id: "evt_stale_generic_owner",
        type: "customer.updated",
        livemode: false,
        data: { object: { id: "cus_stale_generic_owner" } },
      }
      prismaMock.paymentProviderEvent.create.mockImplementation(
        ({ data }: any) =>
          Promise.resolve({ id: "inbox-stale-generic", ...data }),
      )
      prismaMock.paymentProviderEvent.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 })
        // A newer claimant recovered the event before this owner could finish.
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 })
      const adapter = {
        capabilities: { supportedCurrencies: ["USD"] },
        verifyWebhook: jest.fn().mockReturnValue(event),
      }
      service = new BillingService(prismaMock, auditMock, {
        getAdapter: () => adapter,
      } as any)

      try {
        await expect(
          service.handleWebhook("signed", Buffer.from("{}")),
        ).rejects.toBeInstanceOf(ServiceUnavailableException)

        const ignoredWhere =
          prismaMock.paymentProviderEvent.updateMany.mock.calls[2][0].where
        const failedWhere =
          prismaMock.paymentProviderEvent.updateMany.mock.calls[3][0].where
        expect(ignoredWhere).toEqual({
          id: "inbox-stale-generic",
          status: "PROCESSING",
          attempts: 1,
          lockedAt: expect.any(Date),
        })
        expect(failedWhere).toEqual(ignoredWhere)
        expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
        expect(prismaMock.transaction.create).not.toHaveBeenCalled()
      } finally {
        if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
        else process.env.STRIPE_SECRET_KEY = previousKey
        if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
        else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    })

    it("does not acknowledge a terminal replay after its exact snapshot changes", async () => {
      const previousKey = process.env.STRIPE_SECRET_KEY
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
      process.env.STRIPE_SECRET_KEY = "rk_test_unit"
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit"
      const payload = Buffer.from('{"terminal":"snapshot"}')
      const event = {
        id: "evt_terminal_snapshot_changed",
        type: "customer.updated",
        livemode: false,
        data: { object: { id: "cus_terminal_snapshot_changed" } },
      }
      const ignoredAt = new Date("2026-07-29T00:00:00.000Z")
      const storedEvent = {
        id: "inbox-terminal-snapshot-changed",
        provider: "stripe",
        providerEventId: event.id,
        eventType: event.type,
        objectId: event.data.object.id,
        providerPaymentId: null,
        providerChargeId: null,
        disputeAmountMinor: null,
        disputeCurrency: null,
        providerStatus: null,
        livemode: false,
        eventFingerprint: createHash("sha256").update(payload).digest("hex"),
        status: "IGNORED",
        attempts: 1,
        lockedAt: null,
        processedAt: ignoredAt,
      }
      prismaMock.paymentProviderEvent.create.mockRejectedValue(
        Object.assign(new Error("unique"), { code: "P2002" }),
      )
      prismaMock.paymentProviderEvent.findUnique
        .mockResolvedValueOnce(storedEvent)
        .mockResolvedValueOnce({
          ...storedEvent,
          status: "QUARANTINED",
          processedAt: new Date("2026-07-29T00:01:00.000Z"),
        })
      prismaMock.$transaction.mockImplementation((callback: any) =>
        callback(prismaMock),
      )
      const adapter = {
        capabilities: { supportedCurrencies: ["USD"] },
        verifyWebhook: jest.fn().mockReturnValue(event),
      }
      service = new BillingService(prismaMock, auditMock, {
        getAdapter: () => adapter,
      } as any)

      try {
        await expect(
          service.handleWebhook("signed", payload),
        ).rejects.toMatchObject({
          code: "PAYMENT_PROVIDER_EVENT_LEASE_LOST",
        })
        expect(
          prismaMock.paymentProviderEvent.updateMany,
        ).not.toHaveBeenCalled()
        expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
      } finally {
        if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
        else process.env.STRIPE_SECRET_KEY = previousKey
        if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
        else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    })

    it("cannot quarantine an event through a stale inbox lease", async () => {
      const staleLockedAt = new Date("2026-07-29T00:00:00.000Z")
      prismaMock.paymentProviderEvent.findUnique.mockResolvedValue({
        id: "inbox-recovered-before-quarantine",
        provider: "stripe",
        providerEventId: "evt_recovered_before_quarantine",
        eventType: "charge.dispute.created",
        status: "PROCESSING",
        attempts: 2,
        lockedAt: new Date("2026-07-29T00:20:00.000Z"),
        processedAt: null,
      })
      prismaMock.$transaction.mockImplementation((callback: any) =>
        callback(prismaMock),
      )

      await expect(
        (service as any).quarantinePaymentProviderEvent(
          "inbox-recovered-before-quarantine",
          "EVENT_ENVELOPE_MISMATCH",
          {
            kind: "lease",
            attempt: 1,
            lockedAt: staleLockedAt,
          },
        ),
      ).rejects.toMatchObject({
        code: "PAYMENT_PROVIDER_EVENT_LEASE_LOST",
      })
      expect(prismaMock.paymentProviderEvent.updateMany).not.toHaveBeenCalled()
      expect(auditMock.log).not.toHaveBeenCalled()
      expect(prismaMock.notification.createMany).not.toHaveBeenCalled()
    })

    it("cannot credit a checkout session through a stale inbox lease", async () => {
      const staleLockedAt = new Date("2026-07-29T00:00:00.000Z")
      prismaMock.depositAttempt.findFirst.mockResolvedValue({
        id: "attempt-stale-checkout",
        publicReference: "DP-STALE-CHECKOUT",
        walletId: "wallet-1",
        organizationId: "org-1",
        provider: "stripe",
        providerSessionId: "cs_stale_checkout",
        providerPaymentId: null,
        amount: new Decimal(10),
        walletCredit: new Decimal(10),
        currency: "USD",
        status: "PROCESSING",
        ledgerTransactionId: null,
      })
      prismaMock.paymentProviderEvent.findUnique.mockResolvedValue({
        id: "inbox-stale-checkout",
        provider: "stripe",
        eventType: "checkout.session.completed",
        objectId: "cs_stale_checkout",
        livemode: false,
        status: "PROCESSING",
        attempts: 2,
        lockedAt: new Date("2026-07-29T00:20:00.000Z"),
      })
      prismaMock.$transaction.mockImplementation((callback: any) =>
        callback(prismaMock),
      )

      await expect(
        (service as any).processSuccessfulPayment(
          {
            id: "cs_stale_checkout",
            payment_intent: "pi_stale_checkout",
            client_reference_id: "attempt-stale-checkout",
            status: "complete",
            amount_total: 1000,
            currency: "usd",
            payment_status: "paid",
            mode: "payment",
            livemode: false,
            metadata: {
              depositAttemptId: "attempt-stale-checkout",
              publicReference: "DP-STALE-CHECKOUT",
              walletId: "wallet-1",
              userId: "customer-1",
              organizationId: "org-1",
            },
          },
          "inbox-stale-checkout",
          {
            kind: "lease",
            attempt: 1,
            lockedAt: staleLockedAt,
          },
        ),
      ).rejects.toMatchObject({
        code: "PAYMENT_PROVIDER_EVENT_LEASE_LOST",
      })
      expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.transaction.create).not.toHaveBeenCalled()
      expect(prismaMock.depositAttempt.updateMany).not.toHaveBeenCalled()
    })

    it("cannot expire a deposit attempt through a stale inbox lease", async () => {
      const staleLockedAt = new Date("2026-07-29T00:00:00.000Z")
      prismaMock.paymentProviderEvent.findUnique.mockResolvedValue({
        id: "inbox-stale-expiry",
        status: "PROCESSING",
        attempts: 2,
        lockedAt: new Date("2026-07-29T00:20:00.000Z"),
      })
      prismaMock.$transaction.mockImplementation((callback: any) =>
        callback(prismaMock),
      )

      await expect(
        (service as any).markDepositAttemptFromSession(
          {
            id: "cs_stale_expiry",
            metadata: { depositAttemptId: "attempt-stale-expiry" },
          },
          "EXPIRED",
          "inbox-stale-expiry",
          {
            kind: "lease",
            attempt: 1,
            lockedAt: staleLockedAt,
          },
        ),
      ).rejects.toMatchObject({
        code: "PAYMENT_PROVIDER_EVENT_LEASE_LOST",
      })
      expect(prismaMock.depositAttempt.updateMany).not.toHaveBeenCalled()
    })

    it("cannot audit or complete fraud evidence through a stale inbox lease", async () => {
      const staleLockedAt = new Date("2026-07-29T00:00:00.000Z")
      prismaMock.paymentProviderEvent.findUnique.mockResolvedValue({
        id: "inbox-stale-fraud",
        status: "PROCESSING",
        attempts: 2,
        lockedAt: new Date("2026-07-29T00:20:00.000Z"),
      })
      prismaMock.$transaction.mockImplementation((callback: any) =>
        callback(prismaMock),
      )

      await expect(
        (service as any).handleEarlyFraudWarning(
          {
            id: "evt_stale_fraud",
            type: "radar.early_fraud_warning.created",
            data: {
              object: {
                payment_intent: "pi_stale_fraud",
                charge: "ch_stale_fraud",
                amount: 1000,
                currency: "usd",
              },
            },
          },
          "inbox-stale-fraud",
          {
            kind: "lease",
            attempt: 1,
            lockedAt: staleLockedAt,
          },
        ),
      ).rejects.toMatchObject({
        code: "PAYMENT_PROVIDER_EVENT_LEASE_LOST",
      })
      expect(prismaMock.auditLog.findFirst).not.toHaveBeenCalled()
      expect(auditMock.log).not.toHaveBeenCalled()
      expect(prismaMock.notification.createMany).not.toHaveBeenCalled()
    })

    it("returns non-2xx when an early checkout-success redelivery finds a fresh processing lease", async () => {
      const previousKey = process.env.STRIPE_SECRET_KEY
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
      process.env.STRIPE_SECRET_KEY = "rk_test_unit"
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit"
      const payload = Buffer.from("{}")
      const event = {
        id: "evt_checkout_crash_replay",
        type: "checkout.session.completed",
        livemode: false,
        data: {
          object: {
            id: "cs_checkout_crash_replay",
            payment_intent: "pi_checkout_crash_replay",
            amount_total: 1000,
            currency: "usd",
            payment_status: "paid",
            metadata: { depositAttemptId: "attempt-1" },
          },
        },
      }
      const processingRow = {
        id: "inbox-checkout-crash",
        provider: "stripe",
        providerEventId: event.id,
        eventType: event.type,
        objectId: event.data.object.id,
        providerPaymentId: null,
        providerChargeId: null,
        disputeAmountMinor: null,
        disputeCurrency: null,
        providerStatus: null,
        livemode: false,
        eventFingerprint: createHash("sha256").update(payload).digest("hex"),
        status: "PROCESSING",
        attempts: 1,
        lockedAt: new Date(),
      }
      prismaMock.paymentProviderEvent.create.mockRejectedValue(
        Object.assign(new Error("unique"), { code: "P2002" }),
      )
      prismaMock.paymentProviderEvent.findUnique.mockResolvedValue(
        processingRow,
      )
      prismaMock.paymentProviderEvent.updateMany.mockResolvedValue({
        count: 0,
      })
      const adapter = {
        capabilities: { supportedCurrencies: ["USD"] },
        verifyWebhook: jest.fn().mockReturnValue(event),
      }
      service = new BillingService(prismaMock, auditMock, {
        getAdapter: () => adapter,
      } as any)

      try {
        await expect(
          service.handleWebhook("signed", payload),
        ).rejects.toBeInstanceOf(ServiceUnavailableException)
        expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
        expect(prismaMock.paymentProviderEvent.update).not.toHaveBeenCalled()
      } finally {
        if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
        else process.env.STRIPE_SECRET_KEY = previousKey
        if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
        else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    })

    it("persists locked checkout success, returns non-2xx, then processes the same signed delivery once", async () => {
      const previousMode = process.env.FINANCE_RUNTIME_MODE
      const previousEnv = process.env.NODE_ENV
      const previousKey = process.env.STRIPE_SECRET_KEY
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
      process.env.FINANCE_RUNTIME_MODE = "locked"
      process.env.NODE_ENV = "production"
      process.env.STRIPE_SECRET_KEY = "rk_test_unit"
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit"
      const payload = Buffer.from('{"signed":"evidence"}')
      const event = {
        id: "evt_locked_evidence",
        type: "checkout.session.completed",
        livemode: false,
        data: {
          object: {
            id: "cs_locked_evidence",
            payment_intent: "pi_locked_evidence",
            amount_total: 1000,
            currency: "usd",
            payment_status: "paid",
            metadata: { depositAttemptId: "attempt-locked" },
          },
        },
      }
      const adapter = {
        capabilities: { supportedCurrencies: ["USD"] },
        verifyWebhook: jest.fn().mockReturnValue(event),
      }
      let storedEvent: any
      prismaMock.paymentProviderEvent.create.mockImplementation(
        ({ data }: any) => {
          storedEvent = { id: "inbox-locked", ...data }
          return Promise.resolve(storedEvent)
        },
      )
      service = new BillingService(prismaMock, auditMock, {
        getAdapter: () => adapter,
      } as any)
      const processSuccess = jest
        .spyOn(service as any, "processSuccessfulPayment")
        .mockResolvedValue(undefined)

      try {
        await expect(
          service.handleWebhook("signed", payload),
        ).rejects.toMatchObject({
          response: {
            code: "FINANCE_OPERATION_BLOCKED",
            message:
              "Deposit evidence was persisted while finance processing is locked; retry delivery",
          },
        })
        expect(prismaMock.paymentProviderEvent.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            providerEventId: event.id,
            livemode: false,
            status: "PENDING",
          }),
        })
        expect(
          prismaMock.paymentProviderEvent.updateMany,
        ).not.toHaveBeenCalled()
        expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
        expect(prismaMock.transaction.create).not.toHaveBeenCalled()
        expect(processSuccess).not.toHaveBeenCalled()

        process.env.FINANCE_RUNTIME_MODE = "recovery_only"
        prismaMock.paymentProviderEvent.create.mockRejectedValueOnce(
          Object.assign(new Error("unique"), { code: "P2002" }),
        )
        prismaMock.paymentProviderEvent.findUnique.mockResolvedValue(
          storedEvent,
        )
        prismaMock.paymentProviderEvent.updateMany
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 1 })

        await expect(service.handleWebhook("signed", payload)).resolves.toEqual(
          { received: true },
        )
        expect(processSuccess).toHaveBeenCalledTimes(1)
      } finally {
        if (previousMode == null) delete process.env.FINANCE_RUNTIME_MODE
        else process.env.FINANCE_RUNTIME_MODE = previousMode
        if (previousEnv == null) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousEnv
        if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
        else process.env.STRIPE_SECRET_KEY = previousKey
        if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
        else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    })

    it.each([
      [
        "checkout expiry",
        {
          id: "evt_locked_expiry",
          type: "checkout.session.expired",
          livemode: false,
          data: {
            object: {
              id: "cs_locked_expiry",
              metadata: { depositAttemptId: "attempt-locked-expiry" },
            },
          },
        },
        "markDepositAttemptFromSession",
      ],
      [
        "early fraud warning",
        {
          id: "evt_locked_fraud",
          type: "radar.early_fraud_warning.created",
          livemode: false,
          data: {
            object: {
              id: "ifw_locked_fraud",
              payment_intent: "pi_locked_fraud",
              charge: "ch_locked_fraud",
              amount: 1000,
              currency: "usd",
            },
          },
        },
        "handleEarlyFraudWarning",
      ],
    ])("keeps locked %s evidence retryable, then processes its signed recovery redelivery", async (_label, event, handlerName) => {
      const previousMode = process.env.FINANCE_RUNTIME_MODE
      const previousEnv = process.env.NODE_ENV
      const previousKey = process.env.STRIPE_SECRET_KEY
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
      process.env.FINANCE_RUNTIME_MODE = "locked"
      process.env.NODE_ENV = "production"
      process.env.STRIPE_SECRET_KEY = "rk_test_unit"
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit"
      const payload = Buffer.from(JSON.stringify({ id: event.id }))
      const adapter = {
        capabilities: { supportedCurrencies: ["USD"] },
        verifyWebhook: jest.fn().mockReturnValue(event),
      }
      let storedEvent: any
      prismaMock.paymentProviderEvent.create.mockImplementation(
        ({ data }: any) => {
          storedEvent = { id: `inbox-${event.id}`, ...data }
          return Promise.resolve(storedEvent)
        },
      )
      service = new BillingService(prismaMock, auditMock, {
        getAdapter: () => adapter,
      } as any)
      const handler = jest
        .spyOn(service as any, handlerName)
        .mockResolvedValue(undefined)

      try {
        await expect(
          service.handleWebhook("signed", payload),
        ).rejects.toMatchObject({
          response: expect.objectContaining({
            code: "FINANCE_OPERATION_BLOCKED",
          }),
        })
        expect(storedEvent.status).toBe("PENDING")
        expect(handler).not.toHaveBeenCalled()
        expect(
          prismaMock.paymentProviderEvent.updateMany,
        ).not.toHaveBeenCalled()

        process.env.FINANCE_RUNTIME_MODE = "recovery_only"
        prismaMock.paymentProviderEvent.create.mockRejectedValueOnce(
          Object.assign(new Error("unique"), { code: "P2002" }),
        )
        prismaMock.paymentProviderEvent.findUnique.mockResolvedValue(
          storedEvent,
        )
        prismaMock.paymentProviderEvent.updateMany
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 1 })

        await expect(service.handleWebhook("signed", payload)).resolves.toEqual(
          { received: true },
        )
        expect(handler).toHaveBeenCalledTimes(1)
        const call = handler.mock.calls[0]
        const lease = call[call.length - 1]
        expect(lease).toEqual({
          kind: "lease",
          attempt: 1,
          lockedAt: expect.any(Date),
        })
      } finally {
        if (previousMode == null) delete process.env.FINANCE_RUNTIME_MODE
        else process.env.FINANCE_RUNTIME_MODE = previousMode
        if (previousEnv == null) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousEnv
        if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
        else process.env.STRIPE_SECRET_KEY = previousKey
        if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
        else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    })

    it("terminalizes unsupported signed events as IGNORED while finance is locked", async () => {
      const previousMode = process.env.FINANCE_RUNTIME_MODE
      const previousEnv = process.env.NODE_ENV
      const previousKey = process.env.STRIPE_SECRET_KEY
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
      process.env.FINANCE_RUNTIME_MODE = "locked"
      process.env.NODE_ENV = "production"
      process.env.STRIPE_SECRET_KEY = "rk_test_unit"
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit"
      const event = {
        id: "evt_locked_unsupported",
        type: "customer.updated",
        livemode: false,
        data: { object: { id: "cus_locked_unsupported" } },
      }
      const adapter = {
        capabilities: { supportedCurrencies: ["USD"] },
        verifyWebhook: jest.fn().mockReturnValue(event),
      }
      let storedEvent: any
      prismaMock.paymentProviderEvent.create.mockImplementation(
        ({ data }: any) => {
          storedEvent = { id: "inbox-locked-unsupported", ...data }
          return Promise.resolve(storedEvent)
        },
      )
      prismaMock.paymentProviderEvent.findUnique.mockImplementation(() =>
        Promise.resolve(storedEvent),
      )
      prismaMock.paymentProviderEvent.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.$transaction.mockImplementation((callback: any) =>
        callback(prismaMock),
      )
      service = new BillingService(prismaMock, auditMock, {
        getAdapter: () => adapter,
      } as any)

      try {
        await expect(
          service.handleWebhook("signed", Buffer.from("{}")),
        ).resolves.toEqual({
          received: true,
          duplicate: false,
          ignored: true,
        })
        expect(
          prismaMock.paymentProviderEvent.updateMany,
        ).toHaveBeenNthCalledWith(1, {
          where: {
            id: "inbox-locked-unsupported",
            status: "PENDING",
            attempts: 0,
            lockedAt: null,
          },
          data: {
            status: "PROCESSING",
            attempts: { increment: 1 },
            lockedAt: expect.any(Date),
            lastError: null,
          },
        })
        expect(
          prismaMock.paymentProviderEvent.updateMany,
        ).toHaveBeenNthCalledWith(2, {
          where: {
            id: "inbox-locked-unsupported",
            status: "PROCESSING",
            attempts: 1,
            lockedAt: expect.any(Date),
          },
          data: expect.objectContaining({
            status: "IGNORED",
            lockedAt: null,
            lastError: "UNSUPPORTED_EVENT_TYPE",
          }),
        })
        expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
        expect(prismaMock.transaction.create).not.toHaveBeenCalled()
      } finally {
        if (previousMode == null) delete process.env.FINANCE_RUNTIME_MODE
        else process.env.FINANCE_RUNTIME_MODE = previousMode
        if (previousEnv == null) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousEnv
        if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
        else process.env.STRIPE_SECRET_KEY = previousKey
        if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
        else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    })

    it("defers normalized disputes while locked but never acknowledges another active lease", async () => {
      const previousMode = process.env.FINANCE_RUNTIME_MODE
      const previousEnv = process.env.NODE_ENV
      const previousKey = process.env.STRIPE_SECRET_KEY
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
      process.env.FINANCE_RUNTIME_MODE = "locked"
      process.env.NODE_ENV = "production"
      process.env.STRIPE_SECRET_KEY = "rk_test_unit"
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit"
      const payload = Buffer.from('{"locked":"dispute"}')
      const event = {
        id: "evt_locked_dispute",
        type: "charge.dispute.created",
        livemode: false,
        data: {
          object: {
            id: "dp_locked_dispute",
            payment_intent: "pi_locked_dispute",
            charge: "ch_locked_dispute",
            amount: 1000,
            currency: "usd",
            status: "needs_response",
          },
        },
      }
      const adapter = {
        capabilities: { supportedCurrencies: ["USD"] },
        verifyWebhook: jest.fn().mockReturnValue(event),
      }
      let storedEvent: any
      prismaMock.paymentProviderEvent.create.mockImplementation(
        ({ data }: any) => {
          storedEvent = { id: "inbox-locked-dispute", ...data }
          return Promise.resolve(storedEvent)
        },
      )
      service = new BillingService(prismaMock, auditMock, {
        getAdapter: () => adapter,
      } as any)

      try {
        await expect(service.handleWebhook("signed", payload)).resolves.toEqual(
          {
            received: true,
            duplicate: false,
            deferred: true,
          },
        )
        expect(
          prismaMock.paymentProviderEvent.updateMany,
        ).not.toHaveBeenCalled()

        storedEvent = {
          ...storedEvent,
          status: "PROCESSING",
          attempts: 1,
          lockedAt: new Date(),
        }
        prismaMock.paymentProviderEvent.create.mockRejectedValueOnce(
          Object.assign(new Error("unique"), { code: "P2002" }),
        )
        prismaMock.paymentProviderEvent.findUnique.mockResolvedValue(
          storedEvent,
        )

        await expect(
          service.handleWebhook("signed", payload),
        ).rejects.toBeInstanceOf(ServiceUnavailableException)
        expect(
          prismaMock.paymentProviderEvent.updateMany,
        ).not.toHaveBeenCalled()
      } finally {
        if (previousMode == null) delete process.env.FINANCE_RUNTIME_MODE
        else process.env.FINANCE_RUNTIME_MODE = previousMode
        if (previousEnv == null) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousEnv
        if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
        else process.env.STRIPE_SECRET_KEY = previousKey
        if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
        else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    })
  })

  describe("finance runtime controls", () => {
    it("blocks every new-liability billing boundary before database mutation", async () => {
      const previousMode = process.env.FINANCE_RUNTIME_MODE
      const previousEnv = process.env.NODE_ENV
      process.env.FINANCE_RUNTIME_MODE = "recovery_only"
      process.env.NODE_ENV = "production"

      try {
        const operations = [
          () =>
            service.createCheckoutSession("wallet-1", 10, mockUser, "blocked"),
          () => service.reserve("wallet-1", 10, "order-1", mockUser),
          () => service.payFromReserved("wallet-1", 10, "order-1", mockUser),
        ]
        for (const operation of operations) {
          await expect(operation()).rejects.toMatchObject({
            response: expect.objectContaining({
              code: "FINANCE_OPERATION_BLOCKED",
            }),
          })
        }
        expect(prismaMock.wallet.findUnique).not.toHaveBeenCalled()
        expect(prismaMock.$transaction).not.toHaveBeenCalled()
        expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
        expect(prismaMock.transaction.create).not.toHaveBeenCalled()
      } finally {
        if (previousMode == null) delete process.env.FINANCE_RUNTIME_MODE
        else process.env.FINANCE_RUNTIME_MODE = previousMode
        if (previousEnv == null) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousEnv
      }
    })
  })

  describe("checkDepositStatus", () => {
    it.each([
      ["SUCCEEDED", "COMPLETED", true],
      ["PARTIALLY_REFUNDED", "REFUNDED", false],
      ["REFUNDED", "REFUNDED", false],
      ["DISPUTED", "DISPUTED", false],
      ["CHARGEBACK", "DISPUTED", false],
    ])("maps %s to %s without treating derivative evidence as checkout success", async (attemptStatus, expectedStatus, processed) => {
      prismaMock.depositAttempt.findUnique.mockResolvedValue({
        publicReference: "GP-DP-STATUS",
        status: attemptStatus,
        amount: new Decimal(25),
        walletCredit: new Decimal(25),
        customerFee: new Decimal(0),
        currency: "USD",
        completedAt: new Date("2026-07-29T00:00:00.000Z"),
        wallet: mockWallet,
      })

      await expect(
        service.checkDepositStatus("GP-DP-STATUS", mockUser),
      ).resolves.toMatchObject({
        publicReference: "GP-DP-STATUS",
        status: expectedStatus,
        processed,
      })
    })
  })

  describe("createCheckoutSession", () => {
    it("rejects unowned wallet", async () => {
      prismaMock.wallet.findUnique.mockResolvedValue(mockWallet)

      const otherUser = { id: "user-2", organizationId: "org-2" }

      await expect(
        service.createCheckoutSession("wallet-1", 500, otherUser),
      ).rejects.toThrow(ForbiddenException)
    })

    it("throws when Stripe not configured", async () => {
      prismaMock.wallet.findUnique.mockResolvedValue(mockWallet)

      await expect(
        service.createCheckoutSession("wallet-1", 500, mockUser),
      ).rejects.toThrow(BadRequestException)
    })
  })
})
