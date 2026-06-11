-- Pre-beta audit fixes (F-3, F-6)

-- F-3: Order idempotency key was globally unique — one tenant replaying
-- another tenant's key received that tenant's order. Scope per organization.
DROP INDEX IF EXISTS "Order_idempotencyKey_key";
CREATE UNIQUE INDEX "Order_organizationId_idempotencyKey_key" ON "Order"("organizationId", "idempotencyKey");

-- F-6: chargeback hold support.
-- Provider linkage (Stripe payment_intent) on deposit transactions so a
-- dispute webhook can find the originating wallet.
ALTER TABLE "Transaction" ADD COLUMN "providerRef" TEXT;
CREATE INDEX "Transaction_providerRef_idx" ON "Transaction"("providerRef");

-- Chargeback lost: money permanently left the platform. Counted in wallet
-- reconciliation sums (unlike RESERVATION which nets between buckets).
ALTER TYPE "TransactionType" ADD VALUE 'CHARGEBACK';
