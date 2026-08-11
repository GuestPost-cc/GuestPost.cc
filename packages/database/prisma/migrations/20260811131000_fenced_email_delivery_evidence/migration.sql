-- Fence email delivery ownership across lease recovery. Work that expires
-- before SMTP dispatch is retryable; once dispatch starts, an unknown outcome
-- is quarantined instead of risking an automatic duplicate financial email.

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
