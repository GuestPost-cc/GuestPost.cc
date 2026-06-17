/**
 * Phase 7.8 #27 — single source of truth for BullMQ repeatable job names.
 *
 * The iat freshness check in verifyJobPayload rejects payloads older
 * than maxAgeMs. Repeatable cron jobs sign their payload ONCE at worker
 * boot (in apps/worker/src/index.ts) and BullMQ reuses that signed
 * payload for every recurrence — so after maxAgeMs every recurrence
 * fails. To avoid this, each processor's verify call passes
 * `maxAgeMs: 0` when the job name is in this set (HMAC integrity check
 * still runs; only freshness is bypassed).
 *
 * If you register a new repeatable in worker/index.ts, add its name
 * here. The drift-guard spec at
 * apps/worker/src/__tests__/repeatable-job-registry.spec.ts asserts
 * both directions: (a) every name here matches a `repeat:` registration
 * in index.ts, (b) every `repeat:` registration's name appears here.
 * Mismatches fail CI with the missing name in the message.
 */
export const REPEATABLE_JOB_NAMES = new Set([
  "payout-check-status",
  "reconciliation-run",
  "website-reverify-sweep",
  "settlement-hold-sweep",
  "settlement-auto-approve",
])

export function isRepeatableJob(jobName: string | undefined | null): boolean {
  if (!jobName) return false
  return REPEATABLE_JOB_NAMES.has(jobName)
}
