// Phase 7.4 — Notification deduplication (audit #12).
//
// Covers:
//   - All 8 dedup-key builders: shape, length bound, throw on overlong
//   - isUniqueViolation predicate (P2002 detection)
//   - Drift-keyed reconciliation: same drift composition + same UTC day +
//     same staff → same key (collapses hourly cron retries to ONE alert);
//     different composition OR next day → new key (operator sees evolution)
//   - dedup_hits_total counter increments on every "violation"
//   - Migration regression guards: schema has dedupKey column + partial unique
//
// The actual P2002-swallow behavior is mock-driven here (Prisma mocks reject
// with a `{ code: "P2002" }` error and the writer catches it). Real-DB
// verification is in the Phase 7.4 manual smoke step (apply migration to
// dev DB, try concurrent identical writes, observe one row).

import * as fs from "node:fs"
import * as path from "node:path"
import {
  __resetDedupHitsTotal,
  getDedupHitsTotal,
  incrementDedupHits,
  isUniqueViolation,
  notificationDedupKey,
} from "@guestpost/shared"

describe("Phase 7.4 — notificationDedupKey builders", () => {
  it("reconDrift collapses same drift across hourly runs (same UTC day)", () => {
    const args = {
      driftType: "summary",
      entityId: "wallet=3,pub=0,stuckOrd=0,stuckPay=0",
      staffUserId: "staff-1",
      dateBucket: "2026-06-16",
    }
    expect(notificationDedupKey.reconDrift(args)).toBe(
      "recon:summary:wallet=3,pub=0,stuckOrd=0,stuckPay=0:staff-1:2026-06-16",
    )
    // Same args → same key (idempotent across hourly cron runs)
    expect(notificationDedupKey.reconDrift(args)).toBe(
      notificationDedupKey.reconDrift(args),
    )
  })

  it("reconDrift produces a DIFFERENT key when drift composition changes", () => {
    const a = notificationDedupKey.reconDrift({
      driftType: "summary",
      entityId: "wallet=3,pub=0,stuckOrd=0,stuckPay=0",
      staffUserId: "staff-1",
      dateBucket: "2026-06-16",
    })
    const b = notificationDedupKey.reconDrift({
      driftType: "summary",
      entityId: "wallet=3,pub=1,stuckOrd=0,stuckPay=0", // pub drift appeared
      staffUserId: "staff-1",
      dateBucket: "2026-06-16",
    })
    expect(a).not.toBe(b)
  })

  it("reconDrift produces a DIFFERENT key on a new UTC day (drift persists overnight reminder)", () => {
    const today = notificationDedupKey.reconDrift({
      driftType: "summary",
      entityId: "x",
      staffUserId: "staff-1",
      dateBucket: "2026-06-16",
    })
    const tomorrow = notificationDedupKey.reconDrift({
      driftType: "summary",
      entityId: "x",
      staffUserId: "staff-1",
      dateBucket: "2026-06-17",
    })
    expect(today).not.toBe(tomorrow)
  })

  it("deliveryFailed / deliveryManual / deliveryAccepted shape", () => {
    expect(notificationDedupKey.deliveryFailed("v-1", "u-1")).toBe(
      "delivery-failed:v-1:u-1",
    )
    expect(notificationDedupKey.deliveryManual("v-1", "u-1")).toBe(
      "delivery-manual:v-1:u-1",
    )
    expect(notificationDedupKey.deliveryAccepted("v-1", "u-1")).toBe(
      "delivery-accept:v-1:u-1",
    )
  })

  it("chargeback / listingStatus / supportMessage / trustTierChange shape", () => {
    expect(notificationDedupKey.chargeback("dispute-1", "u-1")).toBe(
      "chargeback:dispute-1:u-1",
    )
    expect(notificationDedupKey.listingStatus("l-1", "pub-1", "APPROVED")).toBe(
      "listing-status:l-1:pub-1:APPROVED",
    )
    expect(notificationDedupKey.supportMessage("msg-1", "u-1")).toBe(
      "support-msg:msg-1:u-1",
    )
    expect(
      notificationDedupKey.trustTierChange("pub-1", "NEW", "TRUSTED"),
    ).toBe("trust-tier:pub-1:NEW-TRUSTED")
    expect(notificationDedupKey.publisherDebt("order-1", "u-1")).toBe(
      "publisher-debt:order-1:u-1",
    )
    expect(notificationDedupKey.settlementReleased("set-1", "u-1")).toBe(
      "settlement-released:set-1:u-1",
    )
  })

  it("throws on overlong input (≤256 char DB column would silently truncate otherwise)", () => {
    const huge = "x".repeat(300)
    expect(() => notificationDedupKey.deliveryFailed(huge, "u-1")).toThrow(
      /length .* exceeds/,
    )
    expect(() => notificationDedupKey.supportMessage(huge, "u-1")).toThrow(
      /length .* exceeds/,
    )
  })

  it("utcDateBucket returns YYYY-MM-DD UTC", () => {
    const d = new Date("2026-06-16T23:59:59Z")
    expect(notificationDedupKey.utcDateBucket(d)).toBe("2026-06-16")
    // After UTC midnight
    expect(
      notificationDedupKey.utcDateBucket(new Date("2026-06-17T00:00:00Z")),
    ).toBe("2026-06-17")
  })
})

describe("Phase 7.4 — isUniqueViolation (Prisma P2002 detection)", () => {
  it("returns true for objects with code === 'P2002'", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true)
    expect(
      isUniqueViolation({
        code: "P2002",
        meta: { target: ["userId", "dedupKey"] },
      }),
    ).toBe(true)
  })

  it("returns false for any other shape", () => {
    expect(isUniqueViolation({ code: "P2025" })).toBe(false)
    expect(isUniqueViolation(new Error("nope"))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
    expect(isUniqueViolation("P2002")).toBe(false)
    expect(isUniqueViolation(42)).toBe(false)
  })
})

describe("Phase 7.4 — dedup_hits_total counter", () => {
  beforeEach(() => __resetDedupHitsTotal())

  it("increments on every P2002 catch + getter reads cumulative count", () => {
    expect(getDedupHitsTotal()).toBe(0)
    expect(incrementDedupHits()).toBe(1)
    expect(incrementDedupHits()).toBe(2)
    expect(incrementDedupHits()).toBe(3)
    expect(getDedupHitsTotal()).toBe(3)
  })

  it("__resetDedupHitsTotal clears for test isolation", () => {
    incrementDedupHits()
    incrementDedupHits()
    __resetDedupHitsTotal()
    expect(getDedupHitsTotal()).toBe(0)
  })

  it("captures snapshot before loop and computes delta correctly (audit #18 pattern)", () => {
    const snapshot = getDedupHitsTotal()
    incrementDedupHits()
    incrementDedupHits()
    incrementDedupHits()
    const delta = getDedupHitsTotal() - snapshot
    expect(delta).toBe(3)
    // total still reflects cumulative from previous tests + 3
    expect(getDedupHitsTotal()).toBe(3)
  })

  it("delta is 0 when no dedup hits occur between snapshot and final", () => {
    const snapshot = getDedupHitsTotal()
    // no increments
    const delta = getDedupHitsTotal() - snapshot
    expect(delta).toBe(0)
  })
})

describe("Phase 7.4 — migration + schema regression guards", () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")

  it("migration file exists at the expected path", () => {
    const migPath = path.join(
      repoRoot,
      "packages/database/prisma/migrations/20260616100000_phase74_notification_dedup/migration.sql",
    )
    expect(fs.existsSync(migPath)).toBe(true)
  })

  it("migration SQL adds dedupKey VARCHAR(256) + partial unique index", () => {
    const sql = fs.readFileSync(
      path.join(
        repoRoot,
        "packages/database/prisma/migrations/20260616100000_phase74_notification_dedup/migration.sql",
      ),
      "utf8",
    )
    expect(sql).toMatch(/ADD COLUMN "dedupKey" VARCHAR\(256\)/)
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "Notification_userId_dedupKey_key"/,
    )
    // The WHERE clause is what makes it a partial unique — NULL rows coexist
    expect(sql).toMatch(/WHERE "dedupKey" IS NOT NULL/)
  })

  it("Prisma schema mirrors the dedupKey field + @@unique map", () => {
    const schema = fs.readFileSync(
      path.join(repoRoot, "packages/database/prisma/schema.prisma"),
      "utf8",
    )
    expect(schema).toMatch(/dedupKey\s+String\?\s+@db\.VarChar\(256\)/)
    expect(schema).toMatch(
      /@@unique\(\[userId, dedupKey\], map: "Notification_userId_dedupKey_key"\)/,
    )
  })
})

describe("Phase 7.4 — writer integration (Prisma mock)", () => {
  // Simulates the worker's notification.processor.ts P2002-swallow shape.
  // Verifies: 3 identical creates → 1 row; 3 distinct → 3 rows; 2 NULL → 2 rows.

  type CreateCall = {
    data: { userId: string; dedupKey: string | null; [k: string]: unknown }
  }

  function makePrismaMock() {
    const rows: CreateCall["data"][] = []
    return {
      rows,
      notification: {
        create: jest.fn(async (args: CreateCall) => {
          const dup =
            args.data.dedupKey !== null &&
            rows.some(
              (r) =>
                r.userId === args.data.userId &&
                r.dedupKey === args.data.dedupKey,
            )
          if (dup) {
            throw { code: "P2002" }
          }
          rows.push(args.data)
          return args.data
        }),
      },
    }
  }

  async function safeCreate(
    prisma: ReturnType<typeof makePrismaMock>,
    data: CreateCall["data"],
  ) {
    try {
      await prisma.notification.create({ data })
      return "created" as const
    } catch (err) {
      if (isUniqueViolation(err)) {
        incrementDedupHits()
        return "deduped" as const
      }
      throw err
    }
  }

  beforeEach(() => __resetDedupHitsTotal())

  it("3 identical (userId, dedupKey) creates → 1 row + 2 dedup hits", async () => {
    const prisma = makePrismaMock()
    const data = {
      userId: "u-1",
      organizationId: null,
      type: "RECONCILIATION_ALERT",
      message: "drift",
      dedupKey: notificationDedupKey.reconDrift({
        driftType: "summary",
        entityId: "x",
        staffUserId: "u-1",
        dateBucket: "2026-06-16",
      }),
    }
    expect(await safeCreate(prisma, data)).toBe("created")
    expect(await safeCreate(prisma, data)).toBe("deduped")
    expect(await safeCreate(prisma, data)).toBe("deduped")
    expect(prisma.rows).toHaveLength(1)
    expect(getDedupHitsTotal()).toBe(2)
  })

  it("3 creates with different dedupKeys → 3 rows + 0 dedup hits", async () => {
    const prisma = makePrismaMock()
    for (let i = 0; i < 3; i++) {
      const data = {
        userId: "u-1",
        organizationId: null,
        type: "X",
        message: "",
        dedupKey: notificationDedupKey.deliveryFailed(`v-${i}`, "u-1"),
      }
      expect(await safeCreate(prisma, data)).toBe("created")
    }
    expect(prisma.rows).toHaveLength(3)
    expect(getDedupHitsTotal()).toBe(0)
  })

  it("2 creates with NULL dedupKey → 2 rows (legacy compatibility — partial unique exempts NULL)", async () => {
    const prisma = makePrismaMock()
    const base = {
      userId: "u-1",
      organizationId: null,
      type: "X",
      message: "",
      dedupKey: null as string | null,
    }
    expect(await safeCreate(prisma, base)).toBe("created")
    expect(await safeCreate(prisma, base)).toBe("created")
    expect(prisma.rows).toHaveLength(2)
    expect(getDedupHitsTotal()).toBe(0)
  })
})
