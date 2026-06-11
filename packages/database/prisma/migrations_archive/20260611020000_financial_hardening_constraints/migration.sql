-- Financial hardening constraints: order websiteId, FK hardening,
-- amount/balance constraints, chargeback transaction type, indexes.
-- All steps idempotent / data-safe.

-- ── Order.websiteId: non-DRAFT orders MUST have a website ──────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_websiteId_required') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_websiteId_required"
      CHECK (
        ("status" = 'DRAFT' AND "websiteId" IS NULL) OR
        ("status" != 'DRAFT' AND "websiteId" IS NOT NULL)
      );
  END IF;
END $$;

-- ── Order.websiteId FK: RESTRICT delete (never orphan orders) ──────────────
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_websiteId_fkey";
ALTER TABLE "Order" ADD CONSTRAINT "Order_websiteId_fkey"
  FOREIGN KEY ("websiteId") REFERENCES "Website"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Settlement.publisherId FK: RESTRICT delete ─────────────────────────────
ALTER TABLE "Settlement" DROP CONSTRAINT IF EXISTS "Settlement_publisherId_fkey";
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_publisherId_fkey"
  FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Withdrawal.amount > 0 ──────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Withdrawal_amount_positive') THEN
    ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_amount_positive"
      CHECK (amount > 0);
  END IF;
END $$;

-- ── PlatformRevenue amount constraints ─────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PlatformRevenue_amounts_nonneg') THEN
    ALTER TABLE "PlatformRevenue" ADD CONSTRAINT "PlatformRevenue_amounts_nonneg"
      CHECK (amount >= 0 AND "platformFee" >= 0 AND "netRevenue" >= 0);
  END IF;
END $$;

-- ── Settlement: version column for optimistic locking ──────────────────────
ALTER TABLE "Settlement" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- ── Add CHARGEBACK transaction type ────────────────────────────────────────
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'CHARGEBACK';

-- ── Reconciliation performance indexes ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Transaction_walletId_type_idx"
  ON "Transaction"("walletId", "type");
CREATE INDEX IF NOT EXISTS "Transaction_publisherId_type_idx"
  ON "Transaction"("publisherId", "type");
CREATE INDEX IF NOT EXISTS "PlatformRevenue_reversedAt_idx"
  ON "PlatformRevenue"("reversedAt");
CREATE INDEX IF NOT EXISTS "Settlement_status_idx"
  ON "Settlement"("status");
CREATE INDEX IF NOT EXISTS "Settlement_version_idx"
  ON "Settlement"("version");
