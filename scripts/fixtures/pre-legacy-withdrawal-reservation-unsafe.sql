-- Inject one impossible historical state into an ephemeral clone immediately
-- before migration 0970. The selected legacy_case must be rejected without
-- changing the main populated rehearsal database.

\set ON_ERROR_STOP on

-- This database is a disposable, isolated clone with no application writers.
-- These exact deferred guards did not exist when the historical rows being
-- modelled were written. Disable only the named guards in their own committed
-- transaction so PostgreSQL never has pending deferred-trigger events when
-- they are restored. Currency and foreign-key enforcement remain enabled.
BEGIN;

ALTER TABLE "Withdrawal"
  DISABLE TRIGGER "Withdrawal_financial_provenance_guard";
ALTER TABLE "Withdrawal"
  DISABLE TRIGGER "Withdrawal_payout_method_liability_guard";
ALTER TABLE "Withdrawal"
  DISABLE TRIGGER "Withdrawal_allocation_reservation_commit_guard";
ALTER TABLE "Withdrawal"
  DISABLE TRIGGER "Withdrawal_processing_execution_guard";
ALTER TABLE "Withdrawal"
  DISABLE TRIGGER "Withdrawal_rejection_allocation_completion_guard";

COMMIT;

BEGIN;

INSERT INTO "Withdrawal" (
  "id", "publisherId", "amount", "currency", "publicReference", "payoutFee",
  "netAmount", "feePolicyVersion", "method", "status", "availableAt",
  "idempotencyKey", "payoutMethodId", "requestedBy", "rejectedBy",
  "rejectedAt", "version", "createdAt", "updatedAt"
)
SELECT
  'migration-rehearsal-unsafe-pending-reservation',
  'migration-rehearsal-publisher',
  30,
  'USD',
  'WD-REHEARSAL-UNSAFE-PENDING',
  0,
  30,
  'legacy-no-fee',
  'bank_transfer',
  'PENDING',
  balance."allocationCutoverAt" - INTERVAL '1 day',
  'migration-rehearsal-unsafe-pending',
  NULL,
  'migration-rehearsal-publisher-owner',
  NULL,
  NULL,
  0,
  balance."allocationCutoverAt" - INTERVAL '2 days',
  balance."allocationCutoverAt" - INTERVAL '2 days'
FROM "PublisherBalance" balance
WHERE balance."publisherId" = 'migration-rehearsal-publisher'
  AND :'legacy_case' = 'pending_missing_debit';

INSERT INTO "Withdrawal" (
  "id", "publisherId", "amount", "currency", "publicReference", "payoutFee",
  "netAmount", "feePolicyVersion", "method", "status", "availableAt",
  "idempotencyKey", "payoutMethodId", "requestedBy", "rejectedBy",
  "rejectedAt", "version", "createdAt", "updatedAt"
)
SELECT
  'migration-rehearsal-unsafe-rejected-reservation',
  'migration-rehearsal-publisher',
  35,
  'USD',
  'WD-REHEARSAL-UNSAFE-REJECTED',
  0,
  35,
  'legacy-no-fee',
  'bank_transfer',
  'REJECTED',
  balance."allocationCutoverAt" - INTERVAL '1 day',
  'migration-rehearsal-unsafe-rejected',
  NULL,
  'migration-rehearsal-publisher-owner',
  'migration-rehearsal-finance',
  CASE
    WHEN :'legacy_case' = 'rejected_at_cutover'
      THEN balance."allocationCutoverAt"
    ELSE balance."allocationCutoverAt" + INTERVAL '2 days'
  END,
  1,
  balance."allocationCutoverAt" - INTERVAL '2 days',
  CASE
    WHEN :'legacy_case' = 'rejected_at_cutover'
      THEN balance."allocationCutoverAt"
    ELSE balance."allocationCutoverAt" + INTERVAL '2 days'
  END
FROM "PublisherBalance" balance
WHERE balance."publisherId" = 'migration-rehearsal-publisher'
  AND :'legacy_case' IN (
    'rejected_missing_reversal',
    'rejected_at_cutover'
  );

INSERT INTO "AuditLog" (
  "id", "action", "entityType", "entityId", "userId", "organizationId",
  "createdAt"
)
SELECT
  'migration-rehearsal-unsafe-request-' || withdrawal."id",
  'WITHDRAWAL_REQUESTED',
  'Withdrawal',
  withdrawal."id",
  withdrawal."requestedBy",
  'migration-rehearsal-org',
  withdrawal."createdAt" + INTERVAL '2 seconds'
FROM "Withdrawal" withdrawal
WHERE withdrawal."id" IN (
  'migration-rehearsal-unsafe-pending-reservation',
  'migration-rehearsal-unsafe-rejected-reservation'
);

INSERT INTO "AuditLog" (
  "id", "action", "entityType", "entityId", "userId", "organizationId",
  "createdAt"
)
SELECT
  'migration-rehearsal-unsafe-rejection',
  'WITHDRAWAL_REJECTED',
  'Withdrawal',
  withdrawal."id",
  withdrawal."rejectedBy",
  'migration-rehearsal-org',
  withdrawal."rejectedAt"
FROM "Withdrawal" withdrawal
WHERE withdrawal."id" =
  'migration-rehearsal-unsafe-rejected-reservation';

-- Both rejected cases have a valid request debit. One deliberately lacks the
-- exact reversal; the other has exact evidence at the cutover timestamp, which
-- remains ambiguous and must fail closed instead of being silently skipped.
INSERT INTO "Transaction" (
  "id", "amount", "currency", "type", "reference", "description",
  "publisherId", "createdAt"
)
SELECT
  'migration-rehearsal-unsafe-rejected-debit',
  -withdrawal."amount",
  withdrawal."currency",
  'WITHDRAWAL',
  'withdrawal-' || withdrawal."id",
  'Unsafe rehearsal debit with missing rejection reversal',
  withdrawal."publisherId",
  withdrawal."createdAt" + INTERVAL '1 second'
FROM "Withdrawal" withdrawal
WHERE withdrawal."id" =
  'migration-rehearsal-unsafe-rejected-reservation';

INSERT INTO "Transaction" (
  "id", "amount", "currency", "type", "reference", "description",
  "publisherId", "createdAt"
)
SELECT
  'migration-rehearsal-unsafe-rejected-reversal',
  withdrawal."amount",
  withdrawal."currency",
  'WITHDRAWAL_REVERSAL',
  'withdrawal-reject-' || withdrawal."id",
  'Exact reversal at the ambiguous allocation cutover boundary',
  withdrawal."publisherId",
  withdrawal."rejectedAt"
FROM "Withdrawal" withdrawal
WHERE withdrawal."id" =
  'migration-rehearsal-unsafe-rejected-reservation'
  AND :'legacy_case' = 'rejected_at_cutover';

COMMIT;

-- Restore every named guard before the negative rehearsal invokes migration
-- 0970. Keeping restoration in a separate transaction avoids ALTER TABLE on a
-- relation with pending deferred-trigger events.
BEGIN;

ALTER TABLE "Withdrawal"
  ENABLE TRIGGER "Withdrawal_rejection_allocation_completion_guard";
ALTER TABLE "Withdrawal"
  ENABLE TRIGGER "Withdrawal_processing_execution_guard";
ALTER TABLE "Withdrawal"
  ENABLE TRIGGER "Withdrawal_allocation_reservation_commit_guard";
ALTER TABLE "Withdrawal"
  ENABLE TRIGGER "Withdrawal_payout_method_liability_guard";
ALTER TABLE "Withdrawal"
  ENABLE TRIGGER "Withdrawal_financial_provenance_guard";

COMMIT;
