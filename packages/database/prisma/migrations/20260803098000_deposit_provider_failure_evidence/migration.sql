-- Deposit checkout failures must retain only a bounded categorical reason.
-- Raw Stripe messages can contain operational context and are intentionally
-- excluded from durable financial evidence.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

-- This guard rejects the legacy FAILED writer shape after installation.
-- Hold a deliberate writer barrier before the first snapshot so a concurrent
-- checkout failure cannot escape the backfill with missing evidence. A lock
-- timeout means an old API was not fully drained; the whole migration rolls
-- back and must be retried unchanged after the writer is stopped.
LOCK TABLE "DepositAttempt" IN SHARE MODE;

CREATE TYPE "DepositFailureCode" AS ENUM (
  'LEGACY_UNCLASSIFIED',
  'PROVIDER_AUTHENTICATION_FAILED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REQUEST_REJECTED',
  'PROVIDER_RESPONSE_INVALID'
);

ALTER TABLE "DepositAttempt"
  ADD COLUMN "failureCode" "DepositFailureCode";

-- Historical rows did not distinguish provider/configuration categories.
-- Preserve that uncertainty explicitly instead of inferring a cause.
UPDATE "DepositAttempt"
   SET "failureCode" = 'LEGACY_UNCLASSIFIED'
 WHERE status = 'FAILED';

-- DepositAttempt has a deferred dispute-projection constraint trigger. Flush
-- its events before the following ALTER TABLE; PostgreSQL otherwise refuses
-- to change a relation with pending trigger events. This preserves the guard
-- (and fails closed on inconsistent historical dispute evidence) instead of
-- disabling financial triggers for the backfill.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE "DepositAttempt"
  ADD CONSTRAINT "DepositAttempt_failure_evidence_check" CHECK (
    (status = 'FAILED' AND "failureCode" IS NOT NULL)
    OR (status <> 'FAILED' AND "failureCode" IS NULL)
  );

COMMIT;
