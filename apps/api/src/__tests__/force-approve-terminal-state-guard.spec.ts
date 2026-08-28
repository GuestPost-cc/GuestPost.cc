// Force-approve terminal-state guard regression spec.
//
// forceApprove previously rejected only RELEASED and ran its CAS without a
// status predicate, so a CANCELLED settlement could be resurrected
// (CANCELLED -> CUSTOMER_APPROVED -> ADMIN_APPROVED + release) and an
// ADMIN_APPROVED settlement could be silently downgraded. The fix pins the
// pre-check to live approval states only (PENDING/UNDER_REVIEW/
// CUSTOMER_APPROVED) and moves the observed status into the updateMany where
// clause, matching the 6 sibling transition sites in settlements.service.ts.
//
// Why mocked-Prisma (not integration): same rationale as
// phase-8-1-8-2-settlement-race-windows.spec.ts — the fix lives entirely in
// the app-layer pre-check + where clause; mocked prisma lets us drive each
// status combination deterministically.

import { BadRequestException, ConflictException } from "@nestjs/common"
import { SettlementsService } from "../modules/settlements/settlements.service"

type AnyMock = jest.Mock

const STAFF_USER = "staff-1"

function makeSettlementRow(status: string, version = 5) {
  return {
    id: "s1",
    orderId: "ord-1",
    publisherId: "pub-1",
    currency: "USD",
    status,
    version,
    publisherAmount: "90.00",
    grossAmount: "100.00",
    platformFee: "10.00",
    order: {
      id: "ord-1",
      organizationId: "org-1",
      customerId: "customer-1",
    },
  }
}

function makeTxMock() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    settlement: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: "s1",
        status: "CUSTOMER_APPROVED",
        version: 6,
      }),
      findUnique: jest.fn().mockResolvedValue({
        id: "s1",
        status: "RELEASED",
        version: 7,
      }),
    },
    settlementApproval: {
      create: jest.fn().mockResolvedValue({}),
    },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    order: {
      findUnique: jest.fn().mockResolvedValue({
        id: "ord-1",
        version: 3,
        status: "DELIVERED",
        currency: "USD",
        paymentStatus: "PAID",
        activeDeliveryVersionId: "dv-1",
        fulfillmentChannel: "PUBLISHER",
        warrantyDays: null,
        deliveredAt: new Date("2026-01-01T00:00:00Z"),
        organizationId: "org-1",
        website: { ownershipType: "PUBLISHER" },
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    orderDeliveryVersion: {
      findUnique: jest.fn().mockResolvedValue({
        id: "dv-1",
        orderId: "ord-1",
        submittedByUserId: "publisher-user",
        verificationStatus: "VERIFIED",
      }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    orderDispute: { findFirst: jest.fn().mockResolvedValue(null) },
    revision: { findFirst: jest.fn().mockResolvedValue(null) },
    orderCancellationRequest: { findFirst: jest.fn().mockResolvedValue(null) },
    deliveryFraudFlag: { findMany: jest.fn().mockResolvedValue([]) },
    deliveryFraudHold: { count: jest.fn().mockResolvedValue(0) },
    paymentDispute: { count: jest.fn().mockResolvedValue(0) },
    publisherBalance: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    transaction: { create: jest.fn().mockResolvedValue({}) },
  }
}

function makePrismaMock(tx: ReturnType<typeof makeTxMock>) {
  return {
    settlement: { findUnique: jest.fn() },
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(tx)),
    publisherMembership: { findMany: jest.fn().mockResolvedValue([]) },
    publisher: { findUnique: jest.fn().mockResolvedValue(null) },
  }
}

function makeAuditMock() {
  return { log: jest.fn().mockResolvedValue({}) }
}

function makeQueueMock() {
  return { enqueueTrustRecompute: jest.fn().mockResolvedValue({}) }
}

function makeService(prisma: any) {
  return new SettlementsService(
    prisma as any,
    makeAuditMock() as any,
    makeQueueMock() as any,
  )
}

describe("forceApprove — terminal-state guard", () => {
  it.each([
    "CANCELLED",
    "RELEASED",
    "ADMIN_APPROVED",
  ])("rejects a %s settlement with 400 before entering a transaction", async (status) => {
    const tx = makeTxMock()
    const prisma = makePrismaMock(tx)
    prisma.settlement.findUnique.mockResolvedValue(makeSettlementRow(status))
    const service = makeService(prisma)

    await expect(
      service.forceApprove("s1", "undo cancel", STAFF_USER, "SUPER_ADMIN"),
    ).rejects.toThrow(BadRequestException)
    await expect(
      service.forceApprove("s1", "undo cancel", STAFF_USER, "SUPER_ADMIN"),
    ).rejects.toThrow(`Cannot force-approve settlement in ${status} status`)

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(tx.settlement.updateMany).not.toHaveBeenCalled()
    expect(tx.publisherBalance.create).not.toHaveBeenCalled()
    expect(tx.order.updateMany).not.toHaveBeenCalled()
  })

  it("advances PENDING to CUSTOMER_APPROVED through a status-pinned CAS", async () => {
    const tx = makeTxMock()
    const prisma = makePrismaMock(tx)
    prisma.settlement.findUnique.mockResolvedValue(makeSettlementRow("PENDING"))
    const service = makeService(prisma)

    const result = await service.forceApprove(
      "s1",
      "customer unresponsive",
      STAFF_USER,
      "SUPER_ADMIN",
    )

    expect(result).toEqual({
      id: "s1",
      status: "CUSTOMER_APPROVED",
      version: 6,
    })
    expect(tx.settlement.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", status: "PENDING", version: 5 },
      data: { status: "CUSTOMER_APPROVED", version: { increment: 1 } },
    })
    expect(tx.settlementApproval.create).toHaveBeenCalledWith({
      data: {
        settlementId: "s1",
        type: "CUSTOMER",
        approvedBy: STAFF_USER,
        roleAtTime: "SUPER_ADMIN",
      },
    })
  })

  it("releases funds when forcing a CUSTOMER_APPROVED settlement", async () => {
    const tx = makeTxMock()
    const prisma = makePrismaMock(tx)
    tx.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "s1",
      status: "ADMIN_APPROVED",
      version: 6,
    })
    prisma.settlement.findUnique.mockResolvedValue(
      makeSettlementRow("CUSTOMER_APPROVED"),
    )
    const service = makeService(prisma)

    const result = await service.forceApprove(
      "s1",
      "executive decision",
      STAFF_USER,
      "SUPER_ADMIN",
    )

    expect(result).toMatchObject({ id: "s1", status: "RELEASED" })
    expect(tx.settlement.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", status: "CUSTOMER_APPROVED", version: 5 },
      data: { status: "ADMIN_APPROVED", version: { increment: 1 } },
    })
    expect(tx.order.updateMany).toHaveBeenCalled()
    expect(tx.transaction.create).toHaveBeenCalled()
    expect(tx.publisherBalance.create).toHaveBeenCalled()
  })

  it("fails closed when the status changed concurrently (CAS count 0)", async () => {
    const tx = makeTxMock()
    const prisma = makePrismaMock(tx)
    prisma.settlement.findUnique.mockResolvedValue(makeSettlementRow("PENDING"))
    tx.settlement.updateMany.mockResolvedValue({ count: 0 })
    const service = makeService(prisma)

    await expect(
      service.forceApprove("s1", "race", STAFF_USER, "SUPER_ADMIN"),
    ).rejects.toThrow(ConflictException)

    expect(tx.settlementApproval.create).not.toHaveBeenCalled()
    expect(tx.orderEvent.create).not.toHaveBeenCalled()
    expect(tx.publisherBalance.create).not.toHaveBeenCalled()
    expect(tx.order.updateMany).not.toHaveBeenCalled()
  })
})
