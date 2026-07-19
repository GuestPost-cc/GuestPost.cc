-- Payout webhooks must be durably accepted before the provider receives 2xx.
-- The inbox deliberately stores only normalized, allow-listed fields: raw
-- provider payloads and signature headers may contain sensitive information.
CREATE TYPE "PayoutWebhookEventStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'IGNORED'
);

-- A provider transfer must never reconcile more than one local execution.
-- PostgreSQL permits multiple NULL values, so pre-send execution rows remain
-- valid while non-NULL provider references are unique per provider.
CREATE UNIQUE INDEX "PayoutExecution_providerId_providerExecutionId_key"
  ON "PayoutExecution"("providerId", "providerExecutionId");

CREATE TABLE "PayoutWebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "dedupKey" VARCHAR(64) NOT NULL,
  "eventType" VARCHAR(191) NOT NULL,
  "providerExecutionId" VARCHAR(191),
  "providerStatus" VARCHAR(32),
  "rawStatus" VARCHAR(100),
  "status" "PayoutWebhookEventStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "lastError" VARCHAR(100),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PayoutWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayoutWebhookEvent_provider_dedupKey_key"
  ON "PayoutWebhookEvent"("provider", "dedupKey");
CREATE INDEX "PayoutWebhookEvent_status_availableAt_receivedAt_idx"
  ON "PayoutWebhookEvent"("status", "availableAt", "receivedAt");
CREATE INDEX "PayoutWebhookEvent_providerExecutionId_idx"
  ON "PayoutWebhookEvent"("providerExecutionId");
