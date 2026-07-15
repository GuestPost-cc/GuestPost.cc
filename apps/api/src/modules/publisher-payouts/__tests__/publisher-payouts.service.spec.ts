import { BadRequestException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { PublisherPayoutsService } from "../publisher-payouts.service"

describe("PublisherPayoutsService", () => {
  let service: PublisherPayoutsService
  let prismaMock: any
  let auditMock: any
  let queueMock: any
  let encryptionMock: any
  let executionMock: any

  const publisher = { id: "pub-1", tier: "NEW", organizationId: "org-1" }
  const balance = {
    publisherId: "pub-1",
    withdrawableBalance: new Decimal(500),
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
    const payoutMethod = { id: "pm-1", isActive: true }
    prismaMock = {
      publisherMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "mem-1" }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      publisher: { findUnique: jest.fn().mockResolvedValue(publisher) },
      publisherBalance: {
        findUnique: jest.fn().mockResolvedValue(balance),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      payoutExecution: {
        create: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      payoutProvider: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "manual-1", name: "manual" }),
      },
      transaction: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
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

  describe("requestWithdrawal", () => {
    it("sets availableAt from tier hold and writes a WITHDRAWAL ledger row", async () => {
      const created = {
        id: "wd-1",
        publisherId: "pub-1",
        amount: new Decimal(100),
      }
      prismaMock.withdrawal.create.mockResolvedValue(created)

      const before = Date.now()
      await service.requestWithdrawal("pub-1", 100, "bank_transfer", "user-1")

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
    })

    it("returns existing withdrawal on idempotency key replay without moving balance", async () => {
      prismaMock.withdrawal.findFirst.mockResolvedValue({ id: "wd-existing" })

      const result = await service.requestWithdrawal(
        "pub-1",
        100,
        "bank_transfer",
        "user-1",
        "key-1",
      )

      expect(result).toEqual({ id: "wd-existing" })
      expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.transaction.create).not.toHaveBeenCalled()
    })

    it("rejects amounts above withdrawable", async () => {
      await expect(
        service.requestWithdrawal("pub-1", 9999, "bank_transfer", "user-1"),
      ).rejects.toThrow(BadRequestException)
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
      payoutMethodId: "pm-1",
      availableAt: new Date(Date.now() - 1000),
      publisher: { banned: false, tier: "NEW", organizationId: "org-1" },
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
      // All seven re-validation reads happened INSIDE the txn (tx.* =
      // prismaMock here), proving TOCTOU safety.
      expect(prismaMock.publisherMembership.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { publisherId: "pub-1" } }),
      )
      expect(prismaMock.publisherBalance.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { publisherId: "pub-1" } }),
      )
      expect(prismaMock.payoutMethod.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "pm-1" } }),
      )
      expect(prismaMock.payoutExecution.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { withdrawalId: "wd-1" } }),
      )
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
      prismaMock.withdrawal.findUnique.mockResolvedValue({
        ...baseWithdrawal,
        publisher: { banned: true, tier: "NEW", organizationId: "org-1" },
      })

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
      prismaMock.publisherMembership.findFirst.mockResolvedValueOnce(null)

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).rejects.toThrow(/membership/i)
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      const blocked = auditMock.log.mock.calls.find(
        (c: any) => c[0]?.action === "WITHDRAWAL_APPROVAL_BLOCKED",
      )
      expect(blocked?.[0].metadata.reason).toBe("MEMBERSHIP_REVOKED")
    })

    it("blocks with INSUFFICIENT_BALANCE when a concurrent withdrawal drained the balance", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue(baseWithdrawal)
      prismaMock.publisherBalance.findUnique.mockResolvedValueOnce({
        ...balance,
        withdrawableBalance: new Decimal(50), // < amount 100
      })

      await expect(
        service.approveWithdrawal("wd-1", "staff-1"),
      ).rejects.toThrow(/balance/i)
      expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
      const blocked = auditMock.log.mock.calls.find(
        (c: any) => c[0]?.action === "WITHDRAWAL_APPROVAL_BLOCKED",
      )
      expect(blocked?.[0].metadata.reason).toBe("INSUFFICIENT_BALANCE")
    })

    it("blocks with PAYOUT_METHOD_INVALID when the payout method was retired", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue(baseWithdrawal)
      prismaMock.payoutMethod.findUnique.mockResolvedValueOnce({
        id: "pm-1",
        isActive: false,
      })

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
  })

  describe("rejectWithdrawal", () => {
    it("restores balance and writes WITHDRAWAL_REVERSAL ledger row", async () => {
      prismaMock.withdrawal.findUnique.mockResolvedValue({
        id: "wd-1",
        status: "PENDING",
        version: 0,
        publisherId: "pub-1",
        amount: new Decimal(100),
        publisher,
      })
      prismaMock.withdrawal.findUniqueOrThrow.mockResolvedValue({
        id: "wd-1",
        status: "REJECTED",
      })

      await service.rejectWithdrawal("wd-1", "staff-1")

      const txCall = prismaMock.transaction.create.mock.calls[0][0]
      expect(txCall.data.type).toBe("WITHDRAWAL_REVERSAL")
      expect(txCall.data.reference).toBe("withdrawal-reject-wd-1")
      expect(prismaMock.publisherBalance.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            withdrawableBalance: { increment: 100 },
          }),
        }),
      )
    })
  })
})
