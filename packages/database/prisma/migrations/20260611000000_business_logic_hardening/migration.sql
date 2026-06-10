-- Business-logic hardening: nullable audit actors, revenue reversal,
-- dispute previousStatus, withdrawal holds + idempotency + payout methods,
-- publisher debt, website domain dedupe, new transaction types.
-- All steps idempotent / data-safe.

-- ── AuditLog: system/platform actions have no real user or org ────────────
-- Sentinel strings ("SYSTEM") violated the FKs and audit rows were silently
-- dropped. Columns become nullable; FKs remain for non-null values.
ALTER TABLE "AuditLog" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "organizationId" DROP NOT NULL;

-- Staff/system notifications (chargeback alerts) have no org either.
ALTER TABLE "Notification" ALTER COLUMN "organizationId" DROP NOT NULL;

-- ── PlatformRevenue (model added without a migration — db push only) ──────
CREATE TABLE IF NOT EXISTS "PlatformRevenue" (
  "id"          TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "amount"      DECIMAL(65,30) NOT NULL,
  "platformFee" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "netRevenue"  DECIMAL(65,30) NOT NULL,
  "recordedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformRevenue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformRevenue_orderId_key" ON "PlatformRevenue"("orderId");
CREATE INDEX IF NOT EXISTS "PlatformRevenue_recordedAt_idx" ON "PlatformRevenue"("recordedAt");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PlatformRevenue_orderId_fkey') THEN
    ALTER TABLE "PlatformRevenue"
      ADD CONSTRAINT "PlatformRevenue_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ── PlatformRevenue: reversal instead of delete ───────────────────────────
ALTER TABLE "PlatformRevenue" ADD COLUMN IF NOT EXISTS "reversedAt" TIMESTAMP(3);

-- ── OrderDispute: remember pre-dispute order status ───────────────────────
ALTER TABLE "OrderDispute" ADD COLUMN IF NOT EXISTS "previousStatus" "OrderStatus";

-- ── Withdrawal: tier hold, scoped idempotency, payout method ──────────────
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "availableAt" TIMESTAMP(3);
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "payoutMethodId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Withdrawal_publisherId_idempotencyKey_key"
  ON "Withdrawal"("publisherId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "Withdrawal_payoutMethodId_idx" ON "Withdrawal"("payoutMethodId");

-- ── PayoutMethod ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PayoutMethod" (
  "id"          TEXT NOT NULL,
  "publisherId" TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "details"     JSONB NOT NULL,
  "isDefault"   BOOLEAN NOT NULL DEFAULT false,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayoutMethod_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PayoutMethod_publisherId_idx" ON "PayoutMethod"("publisherId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PayoutMethod_publisherId_fkey') THEN
    ALTER TABLE "PayoutMethod"
      ADD CONSTRAINT "PayoutMethod_publisherId_fkey"
      FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Withdrawal_payoutMethodId_fkey') THEN
    ALTER TABLE "Withdrawal"
      ADD CONSTRAINT "Withdrawal_payoutMethodId_fkey"
      FOREIGN KEY ("payoutMethodId") REFERENCES "PayoutMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── PublisherBalance: clawback debt ────────────────────────────────────────
ALTER TABLE "PublisherBalance" ADD COLUMN IF NOT EXISTS "debtBalance" DECIMAL(65,30) NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PublisherBalance_debt_nonneg') THEN
    ALTER TABLE "PublisherBalance" ADD CONSTRAINT "PublisherBalance_debt_nonneg"
      CHECK ("debtBalance" >= 0);
  END IF;
END $$;

-- ── Website: normalized domain for dedupe ─────────────────────────────────
ALTER TABLE "Website" ADD COLUMN IF NOT EXISTS "domain" TEXT;
CREATE INDEX IF NOT EXISTS "Website_domain_idx" ON "Website"("domain");

-- Backfill: lowercase hostname, strip leading www.
UPDATE "Website"
SET "domain" = regexp_replace(
  lower(split_part(split_part(regexp_replace("url", '^https?://', ''), '/', 1), ':', 1)),
  '^www\.', ''
)
WHERE "domain" IS NULL;

-- ── Transaction types for clawback / debt / withdrawal lifecycle ──────────
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_REVERSAL';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'SETTLEMENT_CLAWBACK';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'DEBT_REPAYMENT';
