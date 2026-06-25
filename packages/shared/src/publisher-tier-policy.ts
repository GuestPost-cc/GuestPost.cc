// Phase 7.2 — Publisher tier policy (audit #6).
//
// Single source of truth for "what does each publisher tier mean numerically"
// across the platform:
//   - Settlement review window (how long a settlement sits PENDING before
//     becoming eligible for auto-approve)
//   - Withdrawal hold (how long a publisher's withdrawal request must wait
//     after approval before funds can be executed)
//
// Lifted here from per-service local tables because the audit found:
//   1. Two settlement-review callsites had different hardcoded defaults
//      (7 in order-review.service.ts, 14 in settlements.service.ts) — same
//      field, same semantic, indeterministic result. Fixed by routing both
//      through `getSettlementReviewDays`.
//   2. Tier-based withdrawal hold lived as a local `TIER_WITHDRAWAL_HOLDS`
//      constant in publisher-payouts.service.ts:10. Lifted here for
//      colocation — same product concept, same shape — so future divergence
//      requires deliberate per-table edits, not silent drift.
//
// Browser-safe: no node:* imports. Goes through the @guestpost/shared barrel.

// Reuse the existing PublisherTier union already exported from ./types
// (Phase 0 grep surfaced it). The two values must match Prisma's enum exactly
// — that's caught at compile time by the `satisfies Record<PublisherTier, …>`
// clauses below, plus the runtime exhaustive-coverage test in
// phase-7-2-tier-policy.spec.ts.
import type { PublisherTier } from "./types"

export type { PublisherTier }

/**
 * How long (in days) a settlement sits under PENDING / UNDER_REVIEW before
 * becoming eligible for auto-approve.
 *
 * NEW publishers get the longest window — we know least about them, so the
 * link gets more time to surface fraud / removal. VERIFIED publishers clear
 * fastest — their track record earns the trust.
 */
export const TIER_SETTLEMENT_REVIEW_DAYS = {
  NEW: 30,
  TRUSTED: 14,
  VERIFIED: 7,
} as const satisfies Record<PublisherTier, number>

/**
 * How long (in days) a publisher's APPROVED withdrawal request must wait
 * before its funds are eligible to execute. Currently identical to settlement
 * review days; kept as a separate constant so they can diverge by tier
 * without a coordinated edit if policy ever asks.
 */
export const TIER_WITHDRAWAL_HOLD_DAYS = {
  NEW: 30,
  TRUSTED: 14,
  VERIFIED: 7,
} as const satisfies Record<PublisherTier, number>

// Minimum logger contract — both console and any Sentry-bridged logger satisfy
// this. Optional injection makes the helpers testable without monkey-patching.
export interface MinimalLogger {
  warn: (...args: unknown[]) => void
}

// One-time warning dedupe. Keyed on envKeyName → last-warned value. A new
// invalid value for the same env var re-warns (someone tried to "fix" it and
// got it wrong again — worth surfacing). Same invalid value never re-warns
// (no spam on every call).
const warnedInvalidOverrides = new Map<string, string>()

/**
 * Parse an env override value. Returns the parsed (and clamped) number when
 * the input is a parseable finite number; returns `undefined` when the value
 * is missing / empty / unparseable. Unparseable values emit a one-time warn
 * via the provided logger (defaults to `console`) so config typos become
 * immediately visible at startup / first call rather than silently degrading
 * to the tier default.
 *
 * Defensive design: empty / whitespace-only is NOT a warnable typo — it's
 * the common "env var declared but blanked out" state. Only set-but-unparseable
 * values trigger the warning.
 */
function parseEnvOverride(
  envValue: string | undefined,
  envKeyName: string,
  logger?: MinimalLogger,
): number | undefined {
  const trimmed = envValue?.trim()
  if (!trimmed) return undefined

  const parsed = Number(trimmed)
  if (Number.isFinite(parsed)) return Math.max(parsed, 0)

  // Set but unparseable — warn once per (envKey, value) pair.
  const lastWarned = warnedInvalidOverrides.get(envKeyName)
  if (lastWarned !== trimmed) {
    warnedInvalidOverrides.set(envKeyName, trimmed)
    ;(logger ?? console).warn(
      `[publisher-tier-policy] Invalid ${envKeyName} override "${trimmed}"; falling back to per-tier default.`,
    )
  }
  return undefined
}

/**
 * Apply the env override when it's parseable as a finite number; otherwise
 * fall back to the tier-table value. This is the helper used by both
 * settlement-creation paths.
 *
 *   undefined / not set → tier value
 *   "42"                → 42
 *   "0"                 → 0   (instant-approval; useful for tests)
 *   "-1"                → 0   (deliberate negative clamps to 0)
 *   "" / "  "           → tier value (blank env; silent fallback)
 *   "garbage" / "abc"   → tier value (invalid; emits one-time warn so the
 *                                     config mistake is visible at startup)
 */
export function getSettlementReviewDays(
  tier: PublisherTier,
  envOverride?: string,
  logger?: MinimalLogger,
): number {
  const parsed = parseEnvOverride(envOverride, "SETTLEMENT_REVIEW_DAYS", logger)
  return parsed ?? TIER_SETTLEMENT_REVIEW_DAYS[tier]
}

/**
 * Same shape as `getSettlementReviewDays`, returning withdrawal hold days.
 * Env override key is the caller's choice (today: `WITHDRAWAL_HOLD_DAYS`).
 */
export function getWithdrawalHoldDays(
  tier: PublisherTier,
  envOverride?: string,
  logger?: MinimalLogger,
): number {
  const parsed = parseEnvOverride(envOverride, "WITHDRAWAL_HOLD_DAYS", logger)
  return parsed ?? TIER_WITHDRAWAL_HOLD_DAYS[tier]
}

// Exported for tests only — clears the once-per-(key, value) warn dedupe so
// each test case starts with a fresh warn slate. Not part of the runtime API.
export function __resetTierPolicyWarnCache(): void {
  warnedInvalidOverrides.clear()
}
