// Phase 8.10 — Settlement creation TOCTOU regression spec (audit #1).
//
// Verifies that evaluateSettlementEligibility is re-checked inside the
// $transaction, on the tx client, so a concurrent dispute/fraud/status change
// between the pre-check and settlement creation cannot bypass the gate.
//
// Why mocked-Prisma (not integration): the fix is a re-check call inside the
// transaction. The evaluateSettlementEligibility function is the same in both
// the pre-check and txn re-check — the only difference is the prisma client
// argument (this.prisma vs tx). Mocked prisma lets us control each
// independently to simulate the race.

import { BadRequestException } from "@nestjs/common"
import { SettlementsService } from "../modules/settlements/settlements.service"

function makeOrderMock(over: Record<string, unknown> = {}) {
  return {
    id: "o1",
    status: "DELIVERED",
    amount: "100.00",
    organizationId: "org-1",
    listingServiceId: null,
    listingId: null,
    type: "GUEST_POST",
    fulfillmentChannel: "PUBLISHER",
    websiteId: "w-1",
    activeDeliveryVersionId: "v1",
    ...over,
  }
}

function makeDeliveryVersionMock() {
  return {
    id: "v1",
    verificationStatus: "VERIFIED",
    interventionStatus: "NONE",
  }
}

function makeSettlementMock(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    orderId: "o1",
    publisherId: "p1",
    status: "PENDING",
    ...over,
  }
}

function makeTxMock(disputeFindFirst: jest.Mock) {
  return {
    settlement: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(makeSettlementMock()),
    },
    publisher: {
      findUnique: jest.fn().mockResolvedValue({ id: "p1", tier: "NEW" }),
    },
    order: { findUnique: jest.fn().mockResolvedValue(makeOrderMock()) },
    orderDeliveryVersion: {
      findUnique: jest.fn().mockResolvedValue(makeDeliveryVersionMock()),
    },
    orderDispute: { findFirst: disputeFindFirst },
    revision: { findFirst: jest.fn().mockResolvedValue(null) },
    deliveryFraudFlag: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    platformSettings: {
      findFirst: jest.fn().mockResolvedValue({ platformFeePct: 20 }),
    },
  }
}

function makePrismaMock(tx: ReturnType<typeof makeTxMock>) {
  return {
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(tx)),
    order: {
      findFirst: jest.fn().mockResolvedValue(makeOrderMock()),
      findUnique: jest.fn().mockResolvedValue(makeOrderMock()),
    },
    orderItem: {
      findFirst: jest.fn().mockResolvedValue({
        id: "oi-1",
        websiteId: "w-1",
        website: { publisherId: "p1", ownershipType: "PUBLISHER" },
      }),
    },
    listingService: { findUnique: jest.fn().mockResolvedValue(null) },
    platformSettings: {
      findFirst: jest.fn().mockResolvedValue({ platformFeePct: 20 }),
    },
    orderDeliveryVersion: {
      findUnique: jest.fn().mockResolvedValue(makeDeliveryVersionMock()),
    },
    orderDispute: { findFirst: jest.fn().mockResolvedValue(null) },
    revision: { findFirst: jest.fn().mockResolvedValue(null) },
    deliveryFraudFlag: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
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

describe("Phase 8.10 (audit #1) — Settlement creation TOCTOU guard", () => {
  it("succeeds when eligibility holds both outside and inside the transaction", async () => {
    const tx = makeTxMock(jest.fn().mockResolvedValue(null))
    const prisma = makePrismaMock(tx)
    const service = makeService(prisma)

    const result = await service.createSettlement("o1", "org-1", "user-1")

    expect(result).toEqual(makeSettlementMock())
    expect(tx.settlement.create).toHaveBeenCalledTimes(1)
  })

  it("blocks when a dispute opens between pre-check and transaction commit (TOCTOU closed)", async () => {
    const tx = makeTxMock(jest.fn().mockResolvedValue({ status: "OPEN" }))
    const prisma = makePrismaMock(tx)
    const service = makeService(prisma)

    // Pre-check (outside txn) sees no dispute via prisma.orderDispute → passes.
    // Inside the txn, tx.orderDispute returns OPEN → re-check fails.
    await expect(
      service.createSettlement("o1", "org-1", "user-1"),
    ).rejects.toThrow(BadRequestException)

    // The settlement should NOT have been created — the txn re-check caught the race.
    expect(tx.settlement.create).not.toHaveBeenCalled()
  })
})
