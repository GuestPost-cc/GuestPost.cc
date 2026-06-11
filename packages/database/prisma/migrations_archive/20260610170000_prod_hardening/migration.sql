-- Production hardening: optimistic-lock versions, Transaction.type enum,
-- ActiveContext FKs, balance/amount check constraints, PlatformSettings.
-- All steps idempotent / data-safe.

-- ── Optimistic-lock version columns ───────────────────────────────────────
ALTER TABLE "Order"      ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- ── Transaction.type → enum ───────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TransactionType') THEN
    CREATE TYPE "TransactionType" AS ENUM
      ('DEPOSIT','PURCHASE','REFUND','WITHDRAWAL','SETTLEMENT_RELEASE','RESERVATION');
  END IF;
END $$;

-- Normalize any legacy values not in the enum before the cast (defensive).
UPDATE "Transaction" SET "type" = 'RESERVATION' WHERE "type" = 'RELEASE';

ALTER TABLE "Transaction"
  ALTER COLUMN "type" TYPE "TransactionType" USING "type"::"TransactionType";

-- ── ActiveContext foreign keys (SET NULL on parent delete) ────────────────
CREATE INDEX IF NOT EXISTS "ActiveContext_activeOrganizationId_idx" ON "ActiveContext"("activeOrganizationId");
CREATE INDEX IF NOT EXISTS "ActiveContext_activePublisherId_idx" ON "ActiveContext"("activePublisherId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActiveContext_activeOrganizationId_fkey') THEN
    ALTER TABLE "ActiveContext"
      ADD CONSTRAINT "ActiveContext_activeOrganizationId_fkey"
      FOREIGN KEY ("activeOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActiveContext_activePublisherId_fkey') THEN
    ALTER TABLE "ActiveContext"
      ADD CONSTRAINT "ActiveContext_activePublisherId_fkey"
      FOREIGN KEY ("activePublisherId") REFERENCES "Publisher"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── PlatformSettings singleton ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PlatformSettings" (
  "id"             TEXT NOT NULL,
  "platformFeePct" DECIMAL(65,30) NOT NULL DEFAULT 20,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- ── Balance / amount check constraints (validate existing data implicitly) ─
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Wallet_balances_nonneg') THEN
    ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balances_nonneg"
      CHECK ("availableBalance" >= 0 AND "reservedBalance" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PublisherBalance_nonneg') THEN
    ALTER TABLE "PublisherBalance" ADD CONSTRAINT "PublisherBalance_nonneg"
      CHECK ("withdrawableBalance" >= 0 AND "lifetimeEarnings" >= 0 AND "lifetimePaid" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Settlement_amounts_nonneg') THEN
    ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_amounts_nonneg"
      CHECK ("grossAmount" >= 0 AND "platformFee" >= 0 AND "publisherAmount" >= 0);
  END IF;
END $$;
