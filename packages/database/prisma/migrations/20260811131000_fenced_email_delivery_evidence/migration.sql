-- Fence email delivery ownership across lease recovery. Work that expires
-- before SMTP dispatch is retryable; once dispatch starts, an unknown outcome
-- is quarantined instead of risking an automatic duplicate financial email.

-- Prisma 7 does not wrap migrations automatically. Keep the column and both
-- evidence constraints atomic so a failed statement cannot leave a migration
-- recorded as failed with only part of the dispatch contract installed.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

ALTER TABLE "CommunicationDelivery"
  ADD COLUMN "dispatchStartedAt" TIMESTAMP(3);

ALTER TABLE "CommunicationDelivery"
  ADD CONSTRAINT "CommunicationDelivery_dispatch_evidence_check" CHECK (
    "dispatchStartedAt" IS NULL
    OR (
      "channel" = 'EMAIL'
      AND "attempts" > 0
      AND "status" IN (
        'PROCESSING',
        'SENT',
        'DELIVERY_UNCERTAIN',
        'BOUNCED',
        'COMPLAINED'
      )
    )
  ) NOT VALID;

ALTER TABLE "CommunicationDelivery"
  ADD CONSTRAINT "CommunicationDelivery_uncertain_dispatch_check" CHECK (
    "status" <> 'DELIVERY_UNCERTAIN'
    OR "dispatchStartedAt" IS NOT NULL
  ) NOT VALID;

COMMIT;
