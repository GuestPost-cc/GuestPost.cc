// Phase 7.4 — Notification dedup-key builders (audit #12).
//
// Every notification writer that wants idempotency on BullMQ retries supplies
// a `dedupKey` string. The DB unique constraint (Notification(userId, dedupKey)
// WHERE dedupKey IS NOT NULL — see migration 20260616100000_phase74_notification_dedup)
// then enforces "at most one notification per (user, key)". The processor
// catches Prisma's P2002 violation as success (the retry is a no-op).
//
// Builders are TYPED — typos, key-shape drift, and missing-field bugs become
// compile-time errors. Adding a new notification type means adding a new
// builder here, which is a deliberate design step.
//
// Naming convention for the key prefix matches the audit's recommendation
// (`recon:`, `delivery-failed:`, etc.).
//
// All keys bounded ≤ 256 chars (the DB column is VARCHAR(256)). Throws on
// overlong inputs so silent truncation can't lose dedup uniqueness.

const MAX_KEY_LEN = 256

function check(key: string): string {
  if (key.length > MAX_KEY_LEN) {
    throw new Error(
      `[notificationDedupKey] key length ${key.length} exceeds VARCHAR(256) limit: ${key.slice(0, 80)}...`,
    )
  }
  return key
}

/**
 * Reconciliation drift — keyed on the PROBLEM (driftType + entityId), not the
 * EXECUTION (runId). The cron runs hourly; with a runId-based key, the same
 * drift would generate a fresh notification every hour. Drift-keyed plus a
 * UTC date bucket = ONE alert per staff member per drift per day. Same drift
 * tomorrow → new alert (reminds operator the drift persists). Drift cleared
 * overnight → no spurious alert.
 *
 * `entityId` is whatever the drift detector identifies (wallet ID, withdrawal
 * ID, etc.). `dateBucket` is `YYYY-MM-DD` UTC.
 */
function reconDrift(args: {
  driftType: string
  entityId: string
  staffUserId: string
  dateBucket: string
}): string {
  return check(
    `recon:${args.driftType}:${args.entityId}:${args.staffUserId}:${args.dateBucket}`,
  )
}

/**
 * Delivery verification failed permanently (retries exhausted, version stuck
 * in MANUAL_REVIEW). One notification per (delivery version, recipient).
 */
function deliveryFailed(versionId: string, userId: string): string {
  return check(`delivery-failed:${versionId}:${userId}`)
}

/**
 * Delivery manually approved or rejected by staff. One notification per
 * (delivery version, recipient) regardless of how many times the worker
 * retries the underlying job.
 */
function deliveryManual(versionId: string, userId: string): string {
  return check(`delivery-manual:${versionId}:${userId}`)
}

/**
 * Customer manually accepted a delivery (VERIFIED → DELIVERED). One per
 * (delivery version, publisher owner).
 */
function deliveryAccepted(versionId: string, userId: string): string {
  return check(`delivery-accept:${versionId}:${userId}`)
}

/**
 * Stripe chargeback opened / won / lost. One per (dispute, staff recipient).
 */
function chargeback(disputeId: string, userId: string): string {
  return check(`chargeback:${disputeId}:${userId}`)
}

/**
 * Listing approved or rejected by admin. One per (listing, publisher, decision).
 * A subsequent re-approval after a reject IS a separate dedup event because
 * the status string differs.
 */
function listingStatus(
  listingId: string,
  publisherUserId: string,
  status: string,
): string {
  return check(`listing-status:${listingId}:${publisherUserId}:${status}`)
}

/**
 * Support ticket event fan-out. One per (ticket message, recipient). Phase 6.6
 * already added a runtime Map<userId, organizationId> dedup at the call site
 * — this DB-level key is the belt-and-suspenders layer that catches queue retries.
 */
function supportMessage(ticketMessageId: string, userId: string): string {
  return check(`support-msg:${ticketMessageId}:${userId}`)
}

/**
 * Publisher tier promotion / demotion. One per actual tier change (not per
 * recompute that landed on the same tier).
 */
function trustTierChange(
  publisherId: string,
  oldTier: string,
  newTier: string,
): string {
  return check(`trust-tier:${publisherId}:${oldTier}-${newTier}`)
}

/**
 * Returns today's UTC date as `YYYY-MM-DD`. Useful for `reconDrift`'s dateBucket.
 * Pure helper — caller passes if they want time-frozen behavior in tests.
 */
function utcDateBucket(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export const notificationDedupKey = {
  reconDrift,
  deliveryFailed,
  deliveryManual,
  deliveryAccepted,
  chargeback,
  listingStatus,
  supportMessage,
  trustTierChange,
  utcDateBucket,
}

// Module-scoped counter for the processor's `dedup_hits_total=N` log line.
// Exported as a getter + reset so tests can read + clear between cases.
let dedupHitsTotal = 0

export function incrementDedupHits(): number {
  return ++dedupHitsTotal
}

export function getDedupHitsTotal(): number {
  return dedupHitsTotal
}

export function __resetDedupHitsTotal(): void {
  dedupHitsTotal = 0
}

/**
 * Type guard for Prisma's P2002 unique-violation error code. Callers wrap
 * `notification.create` in try/catch and use this to identify the
 * "already-exists" success case.
 *
 *   try {
 *     await prisma.notification.create({ data: { ..., dedupKey: k } })
 *   } catch (err) {
 *     if (isUniqueViolation(err)) {
 *       incrementDedupHits()
 *       return // success: another retry already wrote it
 *     }
 *     throw err
 *   }
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const code = (err as { code?: unknown }).code
  return code === "P2002"
}
