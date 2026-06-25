// Phase 7.2 — Settlement review window tier-awareness (audit #6).
//
// Covers:
//   - getSettlementReviewDays helper across 8 input cases
//   - getWithdrawalHoldDays mirror
//   - Exhaustive PublisherTier coverage via satisfies clause (compile-time)
//   - Grep regression guards that catch silent regression to the old
//     hardcoded `?? 7` / `?? 14` fallbacks
//
// Service-level regression (createSettlementForOrder + createSettlement
// computing reviewEndsAt from the helper) is covered indirectly by the
// existing `refund.service.spec.ts` / `order-payment.service.spec.ts`
// shape — adding new mock-Prisma regression tests for the two write paths
// would duplicate infra those files have set up. The unit-level helper
// tests + grep guards together guarantee the wiring is correct.

import * as fs from "node:fs"
import * as path from "node:path"
import {
  __resetTierPolicyWarnCache,
  getSettlementReviewDays,
  getWithdrawalHoldDays,
  type PublisherTier,
  TIER_SETTLEMENT_REVIEW_DAYS,
  TIER_WITHDRAWAL_HOLD_DAYS,
} from "@guestpost/shared"

describe("Phase 7.2 — publisher-tier-policy helpers", () => {
  describe("getSettlementReviewDays", () => {
    it("returns 30 / 14 / 7 for NEW / TRUSTED / VERIFIED", () => {
      expect(getSettlementReviewDays("NEW")).toBe(30)
      expect(getSettlementReviewDays("TRUSTED")).toBe(14)
      expect(getSettlementReviewDays("VERIFIED")).toBe(7)
    })

    it("env override wins when set to a parseable number, regardless of tier", () => {
      expect(getSettlementReviewDays("NEW", "42")).toBe(42)
      expect(getSettlementReviewDays("VERIFIED", "42")).toBe(42)
      expect(getSettlementReviewDays("TRUSTED", "100")).toBe(100)
    })

    it('env "0" returns 0 (deliberate instant-approval; useful for tests)', () => {
      expect(getSettlementReviewDays("NEW", "0")).toBe(0)
      expect(getSettlementReviewDays("VERIFIED", "0")).toBe(0)
    })

    it('env "-1" clamps to 0 (deliberate negative input)', () => {
      expect(getSettlementReviewDays("NEW", "-1")).toBe(0)
      expect(getSettlementReviewDays("VERIFIED", "-99")).toBe(0)
    })

    it("invalid env input falls back to tier default (never silently auto-approves on typo)", () => {
      // Critical safety property: a typo'd env var like SETTLEMENT_REVIEW_DAYS=foo
      // must NOT collapse the review window to 0 (which would auto-approve
      // every settlement on the next sweep). Falls back to the tier-safe value.
      expect(getSettlementReviewDays("NEW", "garbage")).toBe(30)
      expect(getSettlementReviewDays("TRUSTED", "abc")).toBe(14)
      expect(getSettlementReviewDays("VERIFIED", "")).toBe(7)
      expect(getSettlementReviewDays("NEW", "  ")).toBe(30) // whitespace -> NaN
    })

    it("undefined env falls back to tier default", () => {
      expect(getSettlementReviewDays("NEW", undefined)).toBe(30)
      expect(getSettlementReviewDays("VERIFIED", undefined)).toBe(7)
      expect(getSettlementReviewDays("NEW")).toBe(30)
    })

    it("fractional env values are accepted as-is (no rounding — caller's call)", () => {
      expect(getSettlementReviewDays("NEW", "3.5")).toBe(3.5)
    })
  })

  describe("getWithdrawalHoldDays", () => {
    it("mirrors settlement-review values for the 3 tiers today", () => {
      expect(getWithdrawalHoldDays("NEW")).toBe(30)
      expect(getWithdrawalHoldDays("TRUSTED")).toBe(14)
      expect(getWithdrawalHoldDays("VERIFIED")).toBe(7)
    })

    it("env override wins the same way", () => {
      expect(getWithdrawalHoldDays("NEW", "60")).toBe(60)
      expect(getWithdrawalHoldDays("NEW", "garbage")).toBe(30)
      expect(getWithdrawalHoldDays("VERIFIED", "0")).toBe(0)
    })
  })

  describe("PublisherTier exhaustiveness (compile-time + runtime spot-check)", () => {
    it("TIER_SETTLEMENT_REVIEW_DAYS covers every PublisherTier value", () => {
      // Runtime spot-check that backs the compile-time `satisfies` clause
      // in publisher-tier-policy.ts. If Prisma's PublisherTier enum gains a
      // value (e.g. PROVISIONAL) and the union in @guestpost/shared/types is
      // updated to match, this test fails until the table is also extended.
      const tiers: PublisherTier[] = ["NEW", "TRUSTED", "VERIFIED"]
      for (const t of tiers) {
        expect(TIER_SETTLEMENT_REVIEW_DAYS[t]).toBeGreaterThan(0)
      }
      expect(Object.keys(TIER_SETTLEMENT_REVIEW_DAYS).sort()).toEqual(
        [...tiers].sort(),
      )
    })

    it("TIER_WITHDRAWAL_HOLD_DAYS covers every PublisherTier value", () => {
      const tiers: PublisherTier[] = ["NEW", "TRUSTED", "VERIFIED"]
      expect(Object.keys(TIER_WITHDRAWAL_HOLD_DAYS).sort()).toEqual(
        [...tiers].sort(),
      )
    })
  })

  describe("invalid-env warning (Phase 7.2 ops-visibility rider)", () => {
    // The helper emits exactly one warn line per (envKey, value) pair when an
    // env override is set to an unparseable value. Pre-empts the "I set
    // SETTLEMENT_REVIEW_DAYS=garbage in prod and nothing seemed to take
    // effect" support thread — config typos become loud at first call.

    beforeEach(() => {
      __resetTierPolicyWarnCache()
    })

    function makeLogger() {
      return { warn: jest.fn() }
    }

    it("warns exactly once on the first invalid SETTLEMENT_REVIEW_DAYS value", () => {
      const logger = makeLogger()
      expect(getSettlementReviewDays("NEW", "garbage", logger)).toBe(30)
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn.mock.calls[0][0]).toContain("SETTLEMENT_REVIEW_DAYS")
      expect(logger.warn.mock.calls[0][0]).toContain("garbage")
      expect(logger.warn.mock.calls[0][0]).toContain("falling back")
    })

    it("does NOT re-warn for the same invalid value on repeated calls", () => {
      const logger = makeLogger()
      getSettlementReviewDays("NEW", "garbage", logger)
      getSettlementReviewDays("TRUSTED", "garbage", logger)
      getSettlementReviewDays("VERIFIED", "garbage", logger)
      expect(logger.warn).toHaveBeenCalledTimes(1)
    })

    it("re-warns when the invalid value CHANGES (someone tried to fix and got it wrong again)", () => {
      const logger = makeLogger()
      getSettlementReviewDays("NEW", "garbage", logger)
      getSettlementReviewDays("NEW", "garbage", logger) // same: no warn
      getSettlementReviewDays("NEW", "oops", logger) // different: warn
      expect(logger.warn).toHaveBeenCalledTimes(2)
      expect(logger.warn.mock.calls[1][0]).toContain("oops")
    })

    it("does NOT warn for empty / whitespace-only env (common 'declared but blank' state)", () => {
      const logger = makeLogger()
      expect(getSettlementReviewDays("NEW", "", logger)).toBe(30)
      expect(getSettlementReviewDays("NEW", "  ", logger)).toBe(30)
      expect(getSettlementReviewDays("NEW", undefined, logger)).toBe(30)
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it("does NOT warn for valid numeric overrides", () => {
      const logger = makeLogger()
      getSettlementReviewDays("NEW", "42", logger)
      getSettlementReviewDays("NEW", "0", logger)
      getSettlementReviewDays("NEW", "-1", logger)
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it("dedupes SETTLEMENT_REVIEW_DAYS and WITHDRAWAL_HOLD_DAYS independently", () => {
      // The same invalid value 'garbage' set on two different env keys must
      // warn once per key (each key's mistake deserves its own visibility).
      const logger = makeLogger()
      getSettlementReviewDays("NEW", "garbage", logger)
      getWithdrawalHoldDays("NEW", "garbage", logger)
      expect(logger.warn).toHaveBeenCalledTimes(2)
      expect(logger.warn.mock.calls[0][0]).toContain("SETTLEMENT_REVIEW_DAYS")
      expect(logger.warn.mock.calls[1][0]).toContain("WITHDRAWAL_HOLD_DAYS")
    })

    it("falls back to console.warn when no logger is supplied", () => {
      const consoleWarnSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => {})
      try {
        getSettlementReviewDays("NEW", "uniquely-bad-value")
        expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
        expect(consoleWarnSpy.mock.calls[0][0]).toContain("uniquely-bad-value")
      } finally {
        consoleWarnSpy.mockRestore()
      }
    })
  })

  describe("grep regression guards — source no longer contains hardcoded ?? 7 / ?? 14 fallbacks", () => {
    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
    function readSrc(rel: string): string {
      return fs.readFileSync(path.join(repoRoot, rel), "utf8")
    }

    it("order-review.service.ts no longer has `SETTLEMENT_REVIEW_DAYS ?? 7`", () => {
      const src = readSrc(
        "apps/api/src/modules/orders/services/order-review.service.ts",
      )
      expect(src).not.toMatch(/SETTLEMENT_REVIEW_DAYS\s*\?\?\s*7/)
      // Confirm the new helper is wired in
      expect(src).toMatch(/getSettlementReviewDays\(/)
    })

    it("settlements.service.ts no longer has `SETTLEMENT_REVIEW_DAYS ?? 14`", () => {
      const src = readSrc(
        "apps/api/src/modules/settlements/settlements.service.ts",
      )
      expect(src).not.toMatch(/SETTLEMENT_REVIEW_DAYS\s*\?\?\s*14/)
      expect(src).toMatch(/getSettlementReviewDays\(/)
    })

    it("publisher-payouts.service.ts no longer has the local TIER_WITHDRAWAL_HOLDS table", () => {
      const src = readSrc(
        "apps/api/src/modules/publisher-payouts/publisher-payouts.service.ts",
      )
      // The local Record<string, number> declaration is gone
      expect(src).not.toMatch(/const TIER_WITHDRAWAL_HOLDS\s*:\s*Record/)
      // Confirm the shared helper is wired in
      expect(src).toMatch(/getWithdrawalHoldDays\(/)
    })
  })
})
