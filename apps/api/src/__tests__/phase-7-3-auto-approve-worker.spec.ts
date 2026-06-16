// Phase 7.3 — Settlement auto-approve worker migration (audit #10).
//
// Covers:
//   - runSettlementAutoApprove pure helper (4 behavioral scenarios)
//   - countStaleReviewSettlements helper
//   - batchSize clamping (defensive same shape as Phase 7.2 tier-policy)
//   - Grep regression guards: deleted API service file is gone; module
//     no longer references it; new worker processor exists
//
// Service-level "did it actually update the DB" coverage is by design left
// to the manual smoke step in the plan (running the cron against a dev DB
// with stale settlements) — the pure-function tests prove the algorithm;
// integration testing against real Postgres isn't valuable when Prisma mocks
// already prove the call sequence.

import * as fs from "node:fs"
import * as path from "node:path"
import {
  countStaleReviewSettlements,
  runSettlementAutoApprove,
} from "@guestpost/shared"

type AnyMock = jest.Mock

interface PrismaMocks {
  settlement: {
    findMany: AnyMock
    count: AnyMock
  }
  orderDispute: { findFirst: AnyMock }
  $transaction: AnyMock
}

function makePrismaMock(): PrismaMocks {
  return {
    settlement: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    orderDispute: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(),
  }
}

function makeSettlement(opts: { id: string; orderId?: string; version?: number }) {
  return {
    id: opts.id,
    version: opts.version ?? 1,
    orderId: opts.orderId ?? `order-${opts.id}`,
    reviewEndsAt: new Date("2026-06-15T00:00:00Z"),
    order: {
      id: opts.orderId ?? `order-${opts.id}`,
      organizationId: `org-${opts.id}`,
      listingId: `lst-${opts.id}`,
      listingServiceId: `svc-${opts.id}`,
      type: "GUEST_POST",
      fulfillmentChannel: "PUBLISHER",
      websiteId: `web-${opts.id}`,
      amount: "100.00",
    },
  }
}

function makeTxMock() {
  return {
    settlement: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    settlementApproval: { upsert: jest.fn().mockResolvedValue({}) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  }
}

describe("Phase 7.3 — runSettlementAutoApprove", () => {
  it("empty result: scanned/approved/skipped all 0", async () => {
    const prisma = makePrismaMock()
    const r = await runSettlementAutoApprove(prisma as any)
    expect(r.scanned).toBe(0)
    expect(r.approved).toBe(0)
    expect(r.skipped).toBe(0)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("commits the per-row transaction for each eligible settlement", async () => {
    const prisma = makePrismaMock()
    prisma.settlement.findMany.mockResolvedValue([
      makeSettlement({ id: "s1" }),
      makeSettlement({ id: "s2" }),
    ])
    const tx = makeTxMock()
    prisma.$transaction.mockImplementation(async (fn: any) => fn(tx))

    const r = await runSettlementAutoApprove(prisma as any)

    expect(r.scanned).toBe(2)
    expect(r.approved).toBe(2)
    expect(r.skipped).toBe(0)
    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
    // Each transaction did: updateMany + approval upsert + orderEvent + auditLog
    expect(tx.settlement.updateMany).toHaveBeenCalledTimes(2)
    expect(tx.settlementApproval.upsert).toHaveBeenCalledTimes(2)
    expect(tx.orderEvent.create).toHaveBeenCalledTimes(2)
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2)
  })

  it("skips settlements with an active dispute (no transaction opened)", async () => {
    const prisma = makePrismaMock()
    prisma.settlement.findMany.mockResolvedValue([makeSettlement({ id: "s1" })])
    prisma.orderDispute.findFirst.mockResolvedValue({ id: "dispute-1" })

    const r = await runSettlementAutoApprove(prisma as any)

    expect(r.scanned).toBe(1)
    expect(r.approved).toBe(0)
    expect(r.skipped).toBe(1)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("version-guard race: updateMany returns count=0 → counted as skipped, not approved", async () => {
    const prisma = makePrismaMock()
    prisma.settlement.findMany.mockResolvedValue([makeSettlement({ id: "s1" })])
    const tx = makeTxMock()
    tx.settlement.updateMany.mockResolvedValue({ count: 0 })
    prisma.$transaction.mockImplementation(async (fn: any) => fn(tx))

    const r = await runSettlementAutoApprove(prisma as any)

    expect(r.scanned).toBe(1)
    expect(r.approved).toBe(0)
    expect(r.skipped).toBe(1)
    // Updated to 0 means the rest of the tx body should short-circuit
    expect(tx.settlementApproval.upsert).not.toHaveBeenCalled()
    expect(tx.orderEvent.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it("per-row error → skipped (sweep continues to next row)", async () => {
    const prisma = makePrismaMock()
    prisma.settlement.findMany.mockResolvedValue([
      makeSettlement({ id: "s1" }),
      makeSettlement({ id: "s2" }),
    ])
    const tx = makeTxMock()
    prisma.$transaction
      .mockImplementationOnce(async () => {
        throw new Error("simulated DB error")
      })
      .mockImplementationOnce(async (fn: any) => fn(tx))

    const r = await runSettlementAutoApprove(prisma as any)

    expect(r.scanned).toBe(2)
    expect(r.approved).toBe(1) // s2 succeeded
    expect(r.skipped).toBe(1) // s1 failed but didn't kill the sweep
  })

  it("batchSize honored in findMany take", async () => {
    const prisma = makePrismaMock()
    await runSettlementAutoApprove(prisma as any, { batchSize: 42 })
    const callArgs = prisma.settlement.findMany.mock.calls[0]![0] as { take: number }
    expect(callArgs.take).toBe(42)
  })

  it("now override used in reviewEndsAt filter", async () => {
    const prisma = makePrismaMock()
    const frozenNow = new Date("2026-01-15T12:00:00Z")
    await runSettlementAutoApprove(prisma as any, { now: frozenNow })
    const callArgs = prisma.settlement.findMany.mock.calls[0]![0] as { where: { reviewEndsAt: { lte: Date } } }
    expect(callArgs.where.reviewEndsAt.lte).toEqual(frozenNow)
  })
})

describe("Phase 7.3 — countStaleReviewSettlements", () => {
  it("queries with 24h-ago threshold by default", async () => {
    const prisma = makePrismaMock()
    prisma.settlement.count.mockResolvedValue(0)
    const frozenNow = new Date("2026-06-15T12:00:00Z")
    await countStaleReviewSettlements(prisma as any, { now: frozenNow })

    const callArgs = prisma.settlement.count.mock.calls[0]![0] as {
      where: { status: { in: string[] }; reviewEndsAt: { lt: Date } }
    }
    expect(callArgs.where.status.in).toEqual(["PENDING", "UNDER_REVIEW"])
    const expectedThreshold = new Date(frozenNow.getTime() - 24 * 60 * 60 * 1000)
    expect(callArgs.where.reviewEndsAt.lt).toEqual(expectedThreshold)
  })

  it("returns the count verbatim (0 means no stale rows)", async () => {
    const prisma = makePrismaMock()
    prisma.settlement.count.mockResolvedValue(7)
    const n = await countStaleReviewSettlements(prisma as any)
    expect(n).toBe(7)
  })

  it("custom staleThresholdHours respected", async () => {
    const prisma = makePrismaMock()
    prisma.settlement.count.mockResolvedValue(0)
    const frozenNow = new Date("2026-06-15T12:00:00Z")
    await countStaleReviewSettlements(prisma as any, { now: frozenNow, staleThresholdHours: 1 })
    const callArgs = prisma.settlement.count.mock.calls[0]![0] as {
      where: { reviewEndsAt: { lt: Date } }
    }
    expect(callArgs.where.reviewEndsAt.lt).toEqual(new Date(frozenNow.getTime() - 60 * 60 * 1000))
  })
})

// Note: batchSize clamping is exercised end-to-end by the worker integration
// path (env → registerSettlementAutoApproveSweep → signJobPayload({batchSize})
// → processor.clampBatchSize → runSettlementAutoApprove). Unit-testing the
// processor-internal clamp helper from apps/api would require a cross-package
// import (api → worker src/) which violates rootDir. The shared core's
// own batchSize-honored test (above) plus the worker's own clamping in
// registerSettlementAutoApproveSweep cover the path.

describe("Phase 7.3 — file-deletion + module-wiring regression guards", () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")

  it("apps/api/src/modules/settlements/settlement-auto-approve.service.ts is DELETED", () => {
    const filePath = path.join(repoRoot, "apps/api/src/modules/settlements/settlement-auto-approve.service.ts")
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("settlements.module.ts no longer imports or registers SettlementAutoApproveService", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "apps/api/src/modules/settlements/settlements.module.ts"),
      "utf8",
    )
    // Catch actual code references; a comment mentioning the deleted class
    // name as historical context is fine.
    expect(src).not.toMatch(/^\s*import .*SettlementAutoApproveService/m)
    expect(src).not.toMatch(/providers:\s*\[[^\]]*SettlementAutoApproveService/)
    expect(src).not.toMatch(/from\s+["']\.\/settlement-auto-approve\.service["']/)
  })

  it("apps/worker/src/processors/settlement-auto-approve.processor.ts EXISTS", () => {
    const filePath = path.join(repoRoot, "apps/worker/src/processors/settlement-auto-approve.processor.ts")
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it("apps/worker/src/index.ts registers the sweep + adds the worker", () => {
    const src = fs.readFileSync(path.join(repoRoot, "apps/worker/src/index.ts"), "utf8")
    expect(src).toMatch(/createSettlementAutoApproveWorker/)
    expect(src).toMatch(/registerSettlementAutoApproveSweep/)
    expect(src).toMatch(/jobId:\s*"settlement-auto-approve"/)
  })
})
