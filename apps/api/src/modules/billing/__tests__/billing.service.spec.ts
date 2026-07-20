import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { BillingService } from "../billing.service"

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
      transaction: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
      depositAttempt: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
    }

    service = new BillingService(prismaMock as any, auditMock as any)
  })

  describe("Stripe deposit attempts", () => {
    const previousFlag = process.env.STRIPE_DEPOSITS_ENABLED

    beforeEach(() => {
      process.env.STRIPE_DEPOSITS_ENABLED = "true"
      prismaMock.wallet.findUnique.mockResolvedValue(mockWallet)
    })

    afterAll(() => {
      if (previousFlag == null) delete process.env.STRIPE_DEPOSITS_ENABLED
      else process.env.STRIPE_DEPOSITS_ENABLED = previousFlag
    })

    it("rejects idempotency-key reuse with a different amount", async () => {
      prismaMock.depositAttempt.findUnique.mockResolvedValue({
        id: "dp-1",
        amount: new Decimal(10),
        currency: "USD",
        providerSessionId: "cs_1",
      })
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

    it("creates a server-owned fee/reference snapshot before Checkout", async () => {
      prismaMock.depositAttempt.findUnique.mockResolvedValue(null)
      prismaMock.depositAttempt.create.mockResolvedValue({
        id: "dp-1",
        publicReference: "GP-DP-ABCD2345",
      })
      prismaMock.depositAttempt.update.mockResolvedValue({})
      ;(service as any).depositProvider = {
        capabilities: { supportedCurrencies: ["USD"] },
        createSession: jest.fn().mockResolvedValue({
          providerSessionId: "cs_1",
          providerPaymentId: null,
          url: "https://checkout.stripe.test/session",
          expiresAt: new Date(),
        }),
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
    })
  })

  describe("getWallet", () => {
    it("uses organization upsert when an active organization is present", async () => {
      prismaMock.wallet.upsert.mockResolvedValue(mockWallet)

      await expect(service.getWallet("org-1", "user-1")).resolves.toBe(
        mockWallet,
      )
      expect(prismaMock.wallet.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: "org-1" } }),
      )
      expect(prismaMock.wallet.findFirst).not.toHaveBeenCalled()
    })

    it("creates one personal wallet scoped to organizationId null", async () => {
      prismaMock.wallet.findFirst.mockResolvedValue(null)
      prismaMock.wallet.create.mockResolvedValue({
        ...mockWallet,
        organizationId: null,
      })

      await service.getWallet(null, "user-1")

      expect(prismaMock.wallet.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1", organizationId: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      )
      expect(prismaMock.wallet.create).toHaveBeenCalledTimes(1)
    })

    it("recovers from a concurrent personal-wallet unique violation", async () => {
      const winner = { ...mockWallet, organizationId: null }
      prismaMock.wallet.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner)
      prismaMock.wallet.create.mockRejectedValue({ code: "P2002" })

      await expect(service.getWallet(null, "user-1")).resolves.toBe(winner)
      expect(prismaMock.wallet.findFirst).toHaveBeenCalledTimes(2)
    })

    it("does not swallow unrelated personal-wallet create failures", async () => {
      prismaMock.wallet.findFirst.mockResolvedValue(null)
      prismaMock.wallet.create.mockRejectedValue(new Error("database offline"))

      await expect(service.getWallet(null, "user-1")).rejects.toThrow(
        "database offline",
      )
      expect(prismaMock.wallet.findFirst).toHaveBeenCalledTimes(1)
    })
  })

  describe("withdraw", () => {
    it("decrements available balance", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.wallet.updateMany.mockResolvedValue({ count: 1 })
        prismaMock.wallet.findUniqueOrThrow
          .mockResolvedValueOnce(mockWallet)
          .mockResolvedValueOnce({
            ...mockWallet,
            availableBalance: new Decimal(800),
            version: 2,
          })
        return cb(prismaMock)
      })

      const result = await service.withdraw("wallet-1", 200, mockUser)

      expect(Number(result.availableBalance)).toBe(800)
      expect(prismaMock.wallet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "wallet-1", version: 1 },
          data: expect.objectContaining({
            availableBalance: { decrement: 200 },
            version: { increment: 1 },
          }),
        }),
      )
    })

    it("rejects insufficient balance", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        return cb(prismaMock)
      })

      await expect(
        service.withdraw("wallet-1", 2000, mockUser),
      ).rejects.toThrow(BadRequestException)
    })

    it("rejects duplicate idempotency key", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.transaction.findFirst.mockResolvedValue({
          id: "existing-tx",
        })
        return cb(prismaMock)
      })

      await expect(
        service.withdraw("wallet-1", 200, mockUser, "idem-1"),
      ).rejects.toThrow(BadRequestException)
    })

    it("rejects unowned wallet", async () => {
      const otherUser = { id: "user-2", organizationId: "org-2" }
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        return cb(prismaMock)
      })

      await expect(
        service.withdraw("wallet-1", 200, otherUser),
      ).rejects.toThrow(ForbiddenException)
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
            availableBalance: { decrement: 200 },
            reservedBalance: { increment: 200 },
          }),
        }),
      )
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

  describe("refund", () => {
    it("returns full captured amount to available without touching reserved", async () => {
      const walletWithReserved = {
        ...mockWallet,
        availableBalance: new Decimal(800),
        reservedBalance: new Decimal(400),
        version: 1,
      }

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow
          .mockReset()
          .mockResolvedValueOnce(walletWithReserved)
          .mockResolvedValueOnce({
            ...walletWithReserved,
            availableBalance: new Decimal(1000),
            version: 2,
          })
        prismaMock.transaction.findFirst.mockResolvedValue(null)
        prismaMock.wallet.updateMany.mockResolvedValue({ count: 1 })
        prismaMock.transaction.create.mockResolvedValue({ id: "refund-tx" })
        return cb(prismaMock)
      })

      const result = await service.refund("wallet-1", 200, "order-1", mockUser)

      expect(Number(result.availableBalance)).toBe(1000)
      // Reserved funds belong to other orders — refund must not decrement them
      expect(prismaMock.wallet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({
            reservedBalance: expect.anything(),
          }),
        }),
      )
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "WALLET_REFUND" }),
      )
    })

    it("prevents duplicate refund", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.transaction.findFirst.mockResolvedValue({
          id: "existing-refund",
        })
        return cb(prismaMock)
      })

      await expect(
        service.refund("wallet-1", 200, "order-1", mockUser),
      ).rejects.toThrow(BadRequestException)
    })

    it("rejects refund for unowned wallet", async () => {
      const otherUser = { id: "user-2", organizationId: "org-2" }
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        return cb(prismaMock)
      })

      await expect(
        service.refund("wallet-1", 200, "order-1", otherUser),
      ).rejects.toThrow(ForbiddenException)
    })
  })

  describe("handleWebhook", () => {
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
