-- PostgreSQL does not permit a freshly added enum value to be referenced
-- until the transaction that added it has committed. Keep this enum-only
-- migration separate and ordered before payout completion triggers that use
-- QUARANTINED.
ALTER TYPE "PayoutWebhookEventStatus"
  ADD VALUE IF NOT EXISTS 'QUARANTINED';
