-- Durable, preference-aware communications. Business mutations write a
-- CommunicationEvent in their existing transaction; queue delivery is a
-- recoverable projection of this PostgreSQL state.

CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');
CREATE TYPE "NotificationCategory" AS ENUM (
  'SECURITY',
  'ACCOUNT',
  'ORDERS',
  'BILLING',
  'SETTLEMENTS',
  'PAYOUTS',
  'MARKETPLACE',
  'SUPPORT',
  'STAFF_ALERTS',
  'PRODUCT'
);
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'CRITICAL');
CREATE TYPE "CommunicationEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');
CREATE TYPE "CommunicationDeliveryStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'SENT',
  'FAILED',
  'SUPPRESSED',
  'BOUNCED',
  'COMPLAINED'
);
CREATE TYPE "EmailSuppressionReason" AS ENUM ('HARD_BOUNCE', 'COMPLAINT', 'ADMINISTRATIVE');

CREATE TABLE "CommunicationEvent" (
  "id" TEXT NOT NULL,
  "type" VARCHAR(96) NOT NULL,
  "category" "NotificationCategory" NOT NULL,
  "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
  "aggregateType" VARCHAR(64) NOT NULL,
  "aggregateId" VARCHAR(191) NOT NULL,
  "organizationId" TEXT,
  "title" VARCHAR(160) NOT NULL,
  "message" VARCHAR(2000) NOT NULL,
  "actionPath" VARCHAR(512),
  "payload" JSONB,
  "dedupKey" VARCHAR(256) NOT NULL,
  "status" "CommunicationEventStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "lastError" VARCHAR(100),
  "requestId" VARCHAR(128),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommunicationEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunicationDelivery" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "userId" TEXT,
  "channel" "NotificationChannel" NOT NULL,
  "status" "CommunicationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "provider" VARCHAR(32),
  "providerMessageId" VARCHAR(191),
  "lastError" VARCHAR(100),
  "sentAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "bouncedAt" TIMESTAMP(3),
  "complainedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommunicationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationPreference" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "category" "NotificationCategory" NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailSuppression" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "reason" "EmailSuppressionReason" NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sourceRef" VARCHAR(191),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Notification"
  ADD COLUMN "title" VARCHAR(160),
  ADD COLUMN "category" "NotificationCategory" NOT NULL DEFAULT 'ACCOUNT',
  ADD COLUMN "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
  ADD COLUMN "actionPath" VARCHAR(512),
  ADD COLUMN "readAt" TIMESTAMP(3),
  ADD COLUMN "eventId" TEXT;

UPDATE "Notification"
SET "readAt" = "createdAt"
WHERE "read" = true AND "readAt" IS NULL;

CREATE UNIQUE INDEX "CommunicationEvent_dedupKey_key" ON "CommunicationEvent"("dedupKey");
CREATE INDEX "CommunicationEvent_status_availableAt_createdAt_idx"
  ON "CommunicationEvent"("status", "availableAt", "createdAt");
CREATE INDEX "CommunicationEvent_aggregateType_aggregateId_idx"
  ON "CommunicationEvent"("aggregateType", "aggregateId");
CREATE INDEX "CommunicationEvent_organizationId_createdAt_idx"
  ON "CommunicationEvent"("organizationId", "createdAt");
CREATE INDEX "CommunicationEvent_requestId_idx" ON "CommunicationEvent"("requestId");

CREATE UNIQUE INDEX "CommunicationDelivery_eventId_userId_channel_key"
  ON "CommunicationDelivery"("eventId", "userId", "channel");
CREATE INDEX "CommunicationDelivery_channel_status_availableAt_createdAt_idx"
  ON "CommunicationDelivery"("channel", "status", "availableAt", "createdAt");
CREATE INDEX "CommunicationDelivery_provider_providerMessageId_idx"
  ON "CommunicationDelivery"("provider", "providerMessageId");
CREATE INDEX "CommunicationDelivery_userId_createdAt_idx"
  ON "CommunicationDelivery"("userId", "createdAt");

CREATE UNIQUE INDEX "NotificationPreference_userId_category_channel_key"
  ON "NotificationPreference"("userId", "category", "channel");
CREATE INDEX "NotificationPreference_userId_enabled_idx"
  ON "NotificationPreference"("userId", "enabled");

CREATE UNIQUE INDEX "EmailSuppression_userId_email_key"
  ON "EmailSuppression"("userId", "email");
CREATE INDEX "EmailSuppression_email_active_idx" ON "EmailSuppression"("email", "active");

-- Prisma cannot express this partial unique accurately. Legacy rows have no
-- eventId and remain unrestricted; durable event deliveries are unique.
CREATE UNIQUE INDEX "Notification_eventId_userId_key"
  ON "Notification"("eventId", "userId")
  WHERE "eventId" IS NOT NULL AND "userId" IS NOT NULL;

ALTER TABLE "CommunicationDelivery"
  ADD CONSTRAINT "CommunicationDelivery_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "CommunicationEvent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunicationDelivery"
  ADD CONSTRAINT "CommunicationDelivery_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT "NotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailSuppression"
  ADD CONSTRAINT "EmailSuppression_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "CommunicationEvent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
