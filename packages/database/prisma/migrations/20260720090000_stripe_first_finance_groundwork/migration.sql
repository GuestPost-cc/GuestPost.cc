-- Provider-neutral deposit and Stripe-first payout groundwork. All changes are
-- additive; existing financial rows remain valid and authoritative.

CREATE TYPE "DepositAttemptStatus" AS ENUM (
  'CREATED',
  'PENDING_CUSTOMER_ACTION',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'DISPUTED',
  'CHARGEBACK'
);

CREATE TYPE "PaymentProviderEventStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'IGNORED'
);

CREATE TYPE "PublisherProviderAccountStatus" AS ENUM (
  'PENDING_ONBOARDING',
  'RESTRICTED',
  'ENABLED',
  'DISABLED'
);

-- Runtime payout execution must not depend on a developer seed having run.
INSERT INTO "PayoutProvider" (
  "id", "name", "displayName", "config", "configEncryptionKeyVersion",
  "isActive", "version", "createdAt", "updatedAt"
) VALUES (
  'provider_stripe_connect', 'stripe_connect', 'Stripe Connect', '{}'::jsonb,
  0, true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("name") DO NOTHING;

ALTER TABLE "PublisherBalance"
  ADD COLUMN "allocationCutoverAt" TIMESTAMP(3),
  ADD COLUMN "allocationCarryForward" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN "allocationCarryForwardUsed" DECIMAL(65,30) NOT NULL DEFAULT 0;

-- Existing balances predate source allocation. Preserve them honestly as a
-- carry-forward bucket instead of guessing which historical orders funded it.
UPDATE "PublisherBalance"
SET
  "allocationCutoverAt" = CURRENT_TIMESTAMP,
  "allocationCarryForward" = "withdrawableBalance",
  "allocationCarryForwardUsed" = 0
WHERE "allocationCutoverAt" IS NULL;

ALTER TABLE "Withdrawal"
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN "publicReference" TEXT,
  ADD COLUMN "payoutFee" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN "netAmount" DECIMAL(65,30),
  ADD COLUMN "feePolicyVersion" VARCHAR(64);

UPDATE "Withdrawal"
SET
  "netAmount" = "amount",
  "feePolicyVersion" = 'legacy-no-fee'
WHERE "netAmount" IS NULL;

CREATE UNIQUE INDEX "Withdrawal_publicReference_key"
  ON "Withdrawal"("publicReference");

CREATE TABLE "PublisherProviderAccount" (
  "id" TEXT NOT NULL,
  "publisherId" TEXT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "providerAccountId" VARCHAR(191) NOT NULL,
  "status" "PublisherProviderAccountStatus" NOT NULL DEFAULT 'PENDING_ONBOARDING',
  "country" VARCHAR(2),
  "defaultCurrency" VARCHAR(3),
  "transfersEnabled" BOOLEAN NOT NULL DEFAULT false,
  "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
  "payoutScheduleConfigured" BOOLEAN NOT NULL DEFAULT false,
  "requirementsDue" JSONB,
  "lastSyncedAt" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublisherProviderAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PublisherProviderAccount_publisherId_provider_key"
  ON "PublisherProviderAccount"("publisherId", "provider");
CREATE UNIQUE INDEX "PublisherProviderAccount_provider_providerAccountId_key"
  ON "PublisherProviderAccount"("provider", "providerAccountId");
CREATE INDEX "PublisherProviderAccount_provider_status_idx"
  ON "PublisherProviderAccount"("provider", "status");
ALTER TABLE "PublisherProviderAccount"
  ADD CONSTRAINT "PublisherProviderAccount_publisherId_fkey"
  FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayoutMethod"
  ADD COLUMN "providerAccountId" TEXT;
CREATE INDEX "PayoutMethod_providerAccountId_idx"
  ON "PayoutMethod"("providerAccountId");
ALTER TABLE "PayoutMethod"
  ADD CONSTRAINT "PayoutMethod_providerAccountId_fkey"
  FOREIGN KEY ("providerAccountId") REFERENCES "PublisherProviderAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayoutExecution"
  ADD COLUMN "providerTransferId" VARCHAR(191),
  ADD COLUMN "providerPayoutId" VARCHAR(191),
  ADD COLUMN "sourceCurrency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN "destinationCurrency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN "destinationAmount" DECIMAL(65,30),
  ADD COLUMN "providerFee" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN "requestedReference" VARCHAR(64),
  ADD COLUMN "acceptedReference" VARCHAR(64),
  ADD COLUMN "bankTraceReference" VARCHAR(191),
  ADD COLUMN "stage" VARCHAR(64) NOT NULL DEFAULT 'CREATED';

UPDATE "PayoutExecution"
SET
  "destinationAmount" = "amount",
  "providerTransferId" = CASE
    WHEN "providerExecutionId" LIKE 'tr_%' THEN "providerExecutionId"
    ELSE NULL
  END;

CREATE UNIQUE INDEX "PayoutExecution_providerId_providerTransferId_key"
  ON "PayoutExecution"("providerId", "providerTransferId");
CREATE UNIQUE INDEX "PayoutExecution_providerId_providerPayoutId_key"
  ON "PayoutExecution"("providerId", "providerPayoutId");
CREATE INDEX "PayoutExecution_providerPayoutId_idx"
  ON "PayoutExecution"("providerPayoutId");

CREATE TABLE "WithdrawalAllocation" (
  "id" TEXT NOT NULL,
  "withdrawalId" TEXT NOT NULL,
  "sourceType" VARCHAR(32) NOT NULL,
  "sourceTransactionId" TEXT,
  "settlementId" TEXT,
  "orderId" TEXT,
  "amount" DECIMAL(65,30) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "sequence" INTEGER NOT NULL,
  "serviceType" "ServiceType",
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WithdrawalAllocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WithdrawalAllocation_withdrawalId_sequence_key"
  ON "WithdrawalAllocation"("withdrawalId", "sequence");
CREATE UNIQUE INDEX "WithdrawalAllocation_withdrawalId_sourceTransactionId_key"
  ON "WithdrawalAllocation"("withdrawalId", "sourceTransactionId");
CREATE INDEX "WithdrawalAllocation_sourceTransactionId_releasedAt_idx"
  ON "WithdrawalAllocation"("sourceTransactionId", "releasedAt");
CREATE INDEX "WithdrawalAllocation_settlementId_idx"
  ON "WithdrawalAllocation"("settlementId");
CREATE INDEX "WithdrawalAllocation_orderId_idx"
  ON "WithdrawalAllocation"("orderId");
ALTER TABLE "WithdrawalAllocation"
  ADD CONSTRAINT "WithdrawalAllocation_withdrawalId_fkey"
  FOREIGN KEY ("withdrawalId") REFERENCES "Withdrawal"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WithdrawalAllocation"
  ADD CONSTRAINT "WithdrawalAllocation_sourceTransactionId_fkey"
  FOREIGN KEY ("sourceTransactionId") REFERENCES "Transaction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WithdrawalAllocation"
  ADD CONSTRAINT "WithdrawalAllocation_settlementId_fkey"
  FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WithdrawalAllocation"
  ADD CONSTRAINT "WithdrawalAllocation_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "DepositAttempt" (
  "id" TEXT NOT NULL,
  "publicReference" VARCHAR(32) NOT NULL,
  "walletId" TEXT NOT NULL,
  "organizationId" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "method" VARCHAR(32) NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "amount" DECIMAL(65,30) NOT NULL,
  "walletCredit" DECIMAL(65,30) NOT NULL,
  "customerFee" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "providerFee" DECIMAL(65,30),
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "status" "DepositAttemptStatus" NOT NULL DEFAULT 'CREATED',
  "idempotencyKey" VARCHAR(191) NOT NULL,
  "providerSessionId" VARCHAR(191),
  "providerPaymentId" VARCHAR(191),
  "providerChargeId" VARCHAR(191),
  "intendedOrderId" TEXT,
  "ledgerTransactionId" TEXT,
  "expiresAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DepositAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DepositAttempt_publicReference_key"
  ON "DepositAttempt"("publicReference");
CREATE UNIQUE INDEX "DepositAttempt_providerSessionId_key"
  ON "DepositAttempt"("providerSessionId");
CREATE UNIQUE INDEX "DepositAttempt_ledgerTransactionId_key"
  ON "DepositAttempt"("ledgerTransactionId");
CREATE UNIQUE INDEX "DepositAttempt_walletId_idempotencyKey_key"
  ON "DepositAttempt"("walletId", "idempotencyKey");
CREATE INDEX "DepositAttempt_organizationId_status_idx"
  ON "DepositAttempt"("organizationId", "status");
CREATE INDEX "DepositAttempt_provider_providerPaymentId_idx"
  ON "DepositAttempt"("provider", "providerPaymentId");
CREATE INDEX "DepositAttempt_createdAt_idx"
  ON "DepositAttempt"("createdAt");
ALTER TABLE "DepositAttempt"
  ADD CONSTRAINT "DepositAttempt_walletId_fkey"
  FOREIGN KEY ("walletId") REFERENCES "Wallet"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DepositAttempt"
  ADD CONSTRAINT "DepositAttempt_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DepositAttempt"
  ADD CONSTRAINT "DepositAttempt_ledgerTransactionId_fkey"
  FOREIGN KEY ("ledgerTransactionId") REFERENCES "Transaction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PaymentProviderEvent" (
  "id" TEXT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "providerEventId" VARCHAR(191) NOT NULL,
  "eventType" VARCHAR(191) NOT NULL,
  "objectId" VARCHAR(191),
  "depositAttemptId" TEXT,
  "status" "PaymentProviderEventStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "lastError" VARCHAR(100),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentProviderEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentProviderEvent_provider_providerEventId_key"
  ON "PaymentProviderEvent"("provider", "providerEventId");
CREATE INDEX "PaymentProviderEvent_status_availableAt_receivedAt_idx"
  ON "PaymentProviderEvent"("status", "availableAt", "receivedAt");
CREATE INDEX "PaymentProviderEvent_depositAttemptId_idx"
  ON "PaymentProviderEvent"("depositAttemptId");
CREATE INDEX "PaymentProviderEvent_objectId_idx"
  ON "PaymentProviderEvent"("objectId");
ALTER TABLE "PaymentProviderEvent"
  ADD CONSTRAINT "PaymentProviderEvent_depositAttemptId_fkey"
  FOREIGN KEY ("depositAttemptId") REFERENCES "DepositAttempt"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Database-level financial invariants: application checks improve messages,
-- while these constraints prevent a future adapter from persisting impossible
-- amounts during a partial rollout.
ALTER TABLE "DepositAttempt"
  ADD CONSTRAINT "DepositAttempt_amounts_check" CHECK (
    "amount" > 0 AND "walletCredit" > 0 AND "customerFee" >= 0
    AND "walletCredit" + "customerFee" = "amount"
    AND ("providerFee" IS NULL OR "providerFee" >= 0)
  );
ALTER TABLE "Withdrawal"
  ADD CONSTRAINT "Withdrawal_fee_net_check" CHECK (
    "amount" > 0 AND "payoutFee" >= 0 AND "netAmount" >= 0
    AND "netAmount" + "payoutFee" = "amount"
  );
ALTER TABLE "WithdrawalAllocation"
  ADD CONSTRAINT "WithdrawalAllocation_amount_check" CHECK ("amount" > 0);
ALTER TABLE "PublisherBalance"
  ADD CONSTRAINT "PublisherBalance_allocation_check" CHECK (
    "allocationCarryForward" >= 0
    AND "allocationCarryForwardUsed" >= 0
    AND "allocationCarryForwardUsed" <= "allocationCarryForward"
  );
