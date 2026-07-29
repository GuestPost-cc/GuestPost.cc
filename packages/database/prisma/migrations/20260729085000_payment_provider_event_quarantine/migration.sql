-- PostgreSQL cannot safely use a newly added enum value in later DDL until
-- the ALTER TYPE transaction commits. Keep this one-statement migration as
-- the deployment commit boundary before the atomic dispute-case migration.
ALTER TYPE "PaymentProviderEventStatus"
  ADD VALUE IF NOT EXISTS 'QUARANTINED';
