-- PostgreSQL makes a newly added enum value usable only after the transaction
-- that added it commits. Keep this as a dedicated migration so later indexes,
-- constraints, triggers, and application writes can safely reference RELEASE.

ALTER TYPE public."TransactionType"
  ADD VALUE IF NOT EXISTS 'RELEASE' BEFORE 'CHARGEBACK';
