// Phase 8.1 + 8.2 — Settlement race-window regression specs (audits #1 + #2).
//
// Both fixes follow the established version-guard convention in
// apps/api/src/modules/settlements/settlements.service.ts (6 sibling sites
// already use this exact pattern). The specs here lock in the contract:
//
//   - Happy path: updateMany returns { count: 1 } → method resolves.
//   - Race lost: updateMany returns { count: 0 } → ConflictException thrown.
//
// Why mocked-Prisma (not integration): the fix lives entirely in the
// app-layer where clause + count check. There's no DB constraint to exercise
// (contrast Phase 7.14, where the fix lives in a partial unique index, and
// the integration harness is the right tool). Mocked tx covers the algorithm;
// real concurrent-prod incidents would be covered by a future integration
// spec layered on Phase 7.10.2's harness if/when that's prioritized.

import { ConflictException, NotFoundException } from "@nestjs/common"
import { SettlementsService } from "../modules/settlements/settlements.service"

type AnyMock = jest.Mock

function makeTxMock() {
  return {
    settlement: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ id: "s1", status: "UNDER_REVIEW", version: 6 }),
    },
    settlementApproval: {
      findUnique: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({}),
    },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    order: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    orderDeliveryVersion: { findUnique: jest.fn().mockResolvedValue(null) },
    // releaseFundsInternal touches publisherBalance for tier accounting; mocked
    // null + happy-path create so the method reaches the order.updateMany line.
    publisherBalance: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // Transaction ledger entries after the order.updateMany (1-2 calls per release).
    transaction: { create: jest.fn().mockResolvedValue({}) },
  }
}

function makePrismaMock(tx: ReturnType<typeof makeTxMock>) {
  return {
    settlement: { findUnique: jest.fn() },
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(tx)),
  }
}

function makeAuditMock() {
  return { log: jest.fn().mockResolvedValue({}) }
}

function makeQueueMock() {
  return { enqueueTrustRecompute: jest.fn().mockResolvedValue({}) }
}

function makeService(
  prisma: any,
  audit: any = makeAuditMock(),
  queue: any = makeQueueMock(),
) {
  return new SettlementsService(prisma, audit as any, queue as any)
}

// ─── Phase 8.1: returnToReview version guard ──────────────────────────────

describe("Phase 8.1 (audit #1) — returnToReview version guard", () => {
  function setup() {
    const tx = makeTxMock()
    const prisma = makePrismaMock(tx)
    prisma.settlement.findUnique.mockResolvedValue({
      id: "s1",
      version: 5,
      status: "CUSTOMER_APPROVED",
      orderId: "ord-1",
      order: { organizationId: "org-1" },
    })
    const service = makeService(prisma)
    return { tx, prisma, service }
  }

  it("succeeds when the settlement version matches at tx-time (happy path)", async () => {
    const { tx, service } = setup()

    const result = await service.returnToReview("s1", "user-1", "reason here")

    expect(result).toEqual({ id: "s1", status: "UNDER_REVIEW", version: 6 })
    expect(tx.settlement.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", status: "CUSTOMER_APPROVED", version: 5 },
      data: { status: "UNDER_REVIEW", version: { increment: 1 } },
    })
    expect(tx.settlement.findUniqueOrThrow).toHaveBeenCalledTimes(1)
  })

  it("throws ConflictException when the version has advanced (concurrent adminApprove won)", async () => {
    const { tx, service } = setup()
    tx.settlement.updateMany.mockResolvedValue({ count: 0 }) // race lost

    await expect(
      service.returnToReview("s1", "user-1", "reason here"),
    ).rejects.toThrow(ConflictException)
    await expect(
      service.returnToReview("s1", "user-1", "reason here"),
    ).rejects.toThrow(/modified by another request/)
    // Refetch must NOT be called when the conflict is detected
    expect(tx.settlement.findUniqueOrThrow).not.toHaveBeenCalled()
  })

  it("keeps the pre-tx fast-path 400 for the wrong-status case", async () => {
    const tx = makeTxMock()
    const prisma = makePrismaMock(tx)
    prisma.settlement.findUnique.mockResolvedValue({
      id: "s1",
      version: 5,
      status: "RELEASED", // wrong status
      orderId: "ord-1",
      order: { organizationId: "org-1" },
    })
    const service = makeService(prisma)

    // Pre-tx BadRequestException at line 446 is the user-friendly 400; the
    // in-tx version+status guard is the load-bearing 409 for the race case.
    await expect(
      service.returnToReview("s1", "user-1", "reason here"),
    ).rejects.toThrow(
      /Only customer-approved settlements can be returned to review/,
    )
    expect(prisma.$transaction).not.toHaveBeenCalled() // never entered tx
  })
})

// ─── Phase 8.2: releaseFundsInternal Order.status version guard ───────────

describe("Phase 8.2 (audit #2) — releaseFundsInternal Order.status version guard", () => {
  function setup(orderVersion: number = 3) {
    const tx = makeTxMock()
    // releaseFundsInternal calls tx.order.findUnique to read SoD fields + version
    tx.order.findUnique.mockResolvedValue({
      id: "ord-1",
      version: orderVersion,
      activeDeliveryVersionId: null,
      fulfillmentChannel: "PUBLISHER",
      organizationId: "org-1",
      website: { ownershipType: "PUBLISHER" },
    })
    const prisma = makePrismaMock(tx)
    const service = makeService(prisma)
    // Settlement shape that releaseFundsInternal expects on the `settlement`
    // argument — recon shows the caller passes the fresh row + new version
    const settlement = {
      id: "s1",
      version: 7,
      orderId: "ord-1",
      publisherId: "pub-1",
      publisherAmount: "90.00",
      grossAmount: "100.00",
      platformFee: "10.00",
      status: "ADMIN_APPROVED",
    }
    return { tx, service, settlement }
  }

  it("succeeds when the order version matches at tx-time (happy path)", async () => {
    const { tx, service, settlement } = setup(3)
    const audit = (service as any).audit
    audit.log = jest.fn().mockResolvedValue({})

    // private method — invoke via `as any` cast
    await (service as any).releaseFundsInternal(tx, "s1", settlement, "user-1")

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: "ord-1",
        version: 3,
        status: { notIn: ["CANCELLED", "REFUNDED", "DISPUTED"] },
      },
      data: { status: "COMPLETED", version: { increment: 1 } },
    })
  })

  it("throws ConflictException when the order version has advanced (concurrent dispute/cancel won)", async () => {
    const { tx, service, settlement } = setup(3)
    const audit = (service as any).audit
    audit.log = jest.fn().mockResolvedValue({})
    tx.order.updateMany.mockResolvedValue({ count: 0 }) // race lost on Order

    await expect(
      (service as any).releaseFundsInternal(tx, "s1", settlement, "user-1"),
    ).rejects.toThrow(ConflictException)
    await expect(
      (service as any).releaseFundsInternal(tx, "s1", settlement, "user-1"),
    ).rejects.toThrow(/Order state changed/)
  })

  it("throws NotFoundException when order disappears between settlement creation and release", async () => {
    const { tx, service, settlement } = setup()
    tx.order.findUnique.mockResolvedValue(null) // order vanished

    await expect(
      (service as any).releaseFundsInternal(tx, "s1", settlement, "user-1"),
    ).rejects.toThrow(NotFoundException)
  })

  it("throws ConflictException when order is in a terminal state (CANCELLED/REFUNDED/DISPUTED) despite matching version", async () => {
    const { tx, service, settlement } = setup(3)
    const audit = (service as any).audit
    audit.log = jest.fn().mockResolvedValue({})
    // Even with a matching version, the status predicate excludes terminal states
    tx.order.updateMany.mockResolvedValue({ count: 0 })

    await expect(
      (service as any).releaseFundsInternal(tx, "s1", settlement, "user-1"),
    ).rejects.toThrow(ConflictException)
    await expect(
      (service as any).releaseFundsInternal(tx, "s1", settlement, "user-1"),
    ).rejects.toThrow(/Order state changed/)
  })
})
