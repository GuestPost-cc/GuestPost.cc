-- Payout execution rail + zero-trust decrypt RBAC.
-- PayoutProvider / PayoutExecution / PayoutBatch tables, payout-method
-- encryption versioning + masked display details, explicit staff permissions
-- (FINANCIAL_DATA_DECRYPT). All steps idempotent / data-safe.

-- ── Enums ───────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PayoutExecutionStatus') THEN
    CREATE TYPE "PayoutExecutionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PayoutBatchStatus') THEN
    CREATE TYPE "PayoutBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED');
  END IF;
END $$;

-- ── PayoutMethod: key versioning + non-sensitive display fields ────────────
ALTER TABLE "PayoutMethod" ADD COLUMN IF NOT EXISTS "displayDetails" JSONB;
ALTER TABLE "PayoutMethod" ADD COLUMN IF NOT EXISTS "encryptionKeyVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PayoutMethod" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- ── StaffMembership: explicit permission grants (never role-implied) ───────
ALTER TABLE "StaffMembership" ADD COLUMN IF NOT EXISTS "permissions" JSONB NOT NULL DEFAULT '[]';

-- ── PayoutProvider ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PayoutProvider" (
  "id"                         TEXT NOT NULL,
  "name"                       TEXT NOT NULL,
  "displayName"                TEXT NOT NULL,
  "config"                     JSONB NOT NULL,
  "configEncryptionKeyVersion" INTEGER NOT NULL DEFAULT 0,
  "isActive"                   BOOLEAN NOT NULL DEFAULT true,
  "version"                    INTEGER NOT NULL DEFAULT 0,
  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayoutProvider_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PayoutProvider_name_key" ON "PayoutProvider"("name");
CREATE INDEX IF NOT EXISTS "PayoutProvider_isActive_idx" ON "PayoutProvider"("isActive");

-- ── PayoutBatch ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PayoutBatch" (
  "id"              TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "status"          "PayoutBatchStatus" NOT NULL DEFAULT 'PENDING',
  "totalAmount"     DECIMAL(65,30) NOT NULL DEFAULT 0,
  "totalCount"      INTEGER NOT NULL DEFAULT 0,
  "completedAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "completedCount"  INTEGER NOT NULL DEFAULT 0,
  "failedCount"     INTEGER NOT NULL DEFAULT 0,
  "notes"           TEXT,
  "metadata"        JSONB,
  "createdBy"       TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayoutBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PayoutBatch_status_createdAt_idx" ON "PayoutBatch"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "PayoutBatch_createdBy_idx" ON "PayoutBatch"("createdBy");

-- ── PayoutExecution ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PayoutExecution" (
  "id"                  TEXT NOT NULL,
  "withdrawalId"        TEXT NOT NULL,
  "providerId"          TEXT NOT NULL,
  "status"              "PayoutExecutionStatus" NOT NULL DEFAULT 'PENDING',
  "providerExecutionId" TEXT,
  "amount"              DECIMAL(65,30) NOT NULL,
  "fee"                 DECIMAL(65,30) NOT NULL DEFAULT 0,
  "errorMessage"        TEXT,
  "providerMetadata"    JSONB,
  "idempotencyKey"      TEXT,
  "version"             INTEGER NOT NULL DEFAULT 0,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayoutExecution_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PayoutExecution_withdrawalId_idempotencyKey_key"
  ON "PayoutExecution"("withdrawalId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "PayoutExecution_withdrawalId_status_idx" ON "PayoutExecution"("withdrawalId", "status");
CREATE INDEX IF NOT EXISTS "PayoutExecution_providerId_status_idx" ON "PayoutExecution"("providerId", "status");
CREATE INDEX IF NOT EXISTS "PayoutExecution_status_createdAt_idx" ON "PayoutExecution"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "PayoutExecution_providerExecutionId_idx" ON "PayoutExecution"("providerExecutionId");

-- ── Withdrawal: batch linkage ───────────────────────────────────────────────
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "payoutBatchId" TEXT;
CREATE INDEX IF NOT EXISTS "Withdrawal_payoutBatchId_idx" ON "Withdrawal"("payoutBatchId");

-- ── Foreign keys ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PayoutExecution_withdrawalId_fkey') THEN
    ALTER TABLE "PayoutExecution"
      ADD CONSTRAINT "PayoutExecution_withdrawalId_fkey"
      FOREIGN KEY ("withdrawalId") REFERENCES "Withdrawal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PayoutExecution_providerId_fkey') THEN
    ALTER TABLE "PayoutExecution"
      ADD CONSTRAINT "PayoutExecution_providerId_fkey"
      FOREIGN KEY ("providerId") REFERENCES "PayoutProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Withdrawal_payoutBatchId_fkey') THEN
    ALTER TABLE "Withdrawal"
      ADD CONSTRAINT "Withdrawal_payoutBatchId_fkey"
      FOREIGN KEY ("payoutBatchId") REFERENCES "PayoutBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
