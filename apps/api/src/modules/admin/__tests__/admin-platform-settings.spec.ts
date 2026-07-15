// FIN-08 — PlatformSettings audit + optimistic-lock tests.
//
// Covers:
//   - get/getOrCreate singleton behaviour
//   - update emits a structured `PLATFORM_SETTINGS_UPDATED` audit event with
//     { field, oldValue, newValue, reason }
//   - identical value short-circuits (no audit, no write) with BadRequest
//   - optimistic-lock conflict surfaces as ConflictException
//   - the DTO-bound clamping also runs in the service so an internal caller
//     that bypassed the pipe still can't persist a 200% fee
//   - the audit log is wired through the transaction (`tx` argument) so a
//     failed audit insert aborts the write — matching the financial-invariant
//     pattern used everywhere else for money writes.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { AdminService } from "../admin.service"

describe("AdminService — PlatformSettings (FIN-08)", () => {
  let service: AdminService
  let prismaMock: any
  let auditMock: any
  let queueMock: any
  let refundMock: any

  const settingsRow = {
    id: "ps-1",
    platformFeePct: new Decimal(20),
    version: 1,
  }

  beforeEach(() => {
    auditMock = { log: jest.fn().mockResolvedValue(undefined) }
    queueMock = { addJob: jest.fn().mockResolvedValue(undefined) }
    refundMock = { refund: jest.fn() }
    prismaMock = {
      platformSettings: {
        findFirst: jest.fn().mockResolvedValue(settingsRow),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest
        .fn()
        .mockImplementation(async (cb: any) => cb(prismaMock)),
    }
    service = new AdminService(
      prismaMock as any,
      auditMock as any,
      queueMock as any,
      refundMock as any,
    )
  })

  describe("getPlatformSettings", () => {
    it("returns the existing singleton row without creating a new one", async () => {
      const result = await service.getPlatformSettings()
      expect(result).toBe(settingsRow)
      expect(prismaMock.platformSettings.create).not.toHaveBeenCalled()
    })

    it("creates the singleton on first access (lazy init)", async () => {
      const freshRow = {
        id: "ps-fresh",
        platformFeePct: new Decimal(20),
        version: 0,
      }
      prismaMock.platformSettings.findFirst.mockResolvedValueOnce(null)
      prismaMock.platformSettings.create.mockResolvedValueOnce(freshRow)

      const result = await service.getPlatformSettings()
      expect(result).toBe(freshRow)
      expect(prismaMock.platformSettings.create).toHaveBeenCalledWith({
        data: {},
      })
    })
  })

  describe("updatePlatformFee", () => {
    it("updates the fee and emits a structured PLATFORM_SETTINGS_UPDATED audit event", async () => {
      const result = await service.updatePlatformFee(25, "Tier renegotiation", {
        id: "staff-1",
      })

      expect(result).toEqual({ id: "ps-1", platformFeePct: 25 })

      // Optimistic-lock write uses the captured version snapshot.
      expect(prismaMock.platformSettings.updateMany).toHaveBeenCalledWith({
        where: { id: "ps-1", version: 1 },
        data: { platformFeePct: 25, version: { increment: 1 } },
      })

      // The audit log MUST have been called with the tx (transactional audit).
      const auditCall = auditMock.log.mock.calls[0]
      expect(auditCall[0].action).toBe("PLATFORM_SETTINGS_UPDATED")
      expect(auditCall[0].entityType).toBe("PlatformSettings")
      expect(auditCall[0].entityId).toBe("ps-1")
      expect(auditCall[0].metadata).toEqual({
        field: "platformFeePct",
        oldValue: 20,
        newValue: 25,
        reason: "Tier renegotiation",
      })
      expect(auditCall[0].userId).toBe("staff-1")
      // Platform-scope action — no org context.
      expect(auditCall[0].organizationId).toBeNull()
      // tx argument must be passed so the audit row commits atomically.
      expect(auditCall[1]).toBe(prismaMock)
    })

    it("refuses a no-op update with BadRequest (no audit, no write)", async () => {
      await expect(
        service.updatePlatformFee(20, "Duplicate update", { id: "staff-1" }),
      ).rejects.toThrow(BadRequestException)

      expect(prismaMock.platformSettings.updateMany).not.toHaveBeenCalled()
      expect(auditMock.log).not.toHaveBeenCalled()
    })

    it("clamps out-of-range values defensively even if the pipe was bypassed", async () => {
      // An internal caller that skipped the DTO (and any future writer) still
      // can't persist a 200% fee — the service clamps to [0, 100].
      const result = await service.updatePlatformFee(
        200,
        "Internally bad call",
        {
          id: "staff-1",
        },
      )
      expect(result.platformFeePct).toBe(100)
      expect(auditMock.log.mock.calls[0][0].metadata.newValue).toBe(100)
    })

    it("clamps negative values to 0", async () => {
      const result = await service.updatePlatformFee(
        -5,
        "Administrative error",
        {
          id: "staff-1",
        },
      )
      expect(result.platformFeePct).toBe(0)
    })

    it("surfaces a concurrent modification as ConflictException (optimistic lock)", async () => {
      prismaMock.platformSettings.updateMany.mockResolvedValueOnce({ count: 0 })

      await expect(
        service.updatePlatformFee(25, "Concurrent change race", {
          id: "staff-1",
        }),
      ).rejects.toThrow(ConflictException)
    })

    it("throws NotFound if the singleton row is missing inside the txn", async () => {
      prismaMock.platformSettings.findFirst.mockResolvedValueOnce(null)

      await expect(
        service.updatePlatformFee(25, "Should not run", { id: "staff-1" }),
      ).rejects.toThrow(NotFoundException)
      expect(prismaMock.platformSettings.updateMany).not.toHaveBeenCalled()
    })
  })
})
