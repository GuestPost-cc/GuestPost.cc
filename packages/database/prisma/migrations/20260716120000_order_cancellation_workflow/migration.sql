-- Order cancellation is a case workflow, not an unrestricted status update.
-- The order keeps financial attribution so publisher trust only reacts to
-- publisher-caused failures.

CREATE TYPE "CancellationRequesterType" AS ENUM (
  'CUSTOMER', 'PUBLISHER', 'STAFF', 'SYSTEM'
);

CREATE TYPE "CancellationRequestStatus" AS ENUM (
  'REQUESTED', 'UNDER_REVIEW', 'PENDING_FINANCE', 'APPROVED',
  'REJECTED', 'WITHDRAWN', 'ESCALATED', 'DISPUTED'
);

CREATE TYPE "CancellationResolution" AS ENUM (
  'FULL_REFUND', 'CONTINUE_ORDER', 'ESCALATE_TO_DISPUTE'
);

CREATE TYPE "CancellationResponsibility" AS ENUM (
  'CUSTOMER', 'PUBLISHER', 'PLATFORM', 'SHARED', 'SYSTEM', 'UNDETERMINED'
);

CREATE TYPE "CancellationReasonCode" AS ENUM (
  'CUSTOMER_CHANGED_MIND', 'CAMPAIGN_CHANGED', 'DUPLICATE_ORDER',
  'CAPACITY_UNAVAILABLE', 'TOPIC_UNSUITABLE', 'WEBSITE_UNAVAILABLE',
  'PRICING_ERROR', 'POLICY_CONFLICT', 'MISSED_DEADLINE', 'QUALITY_FAILURE',
  'PLATFORM_ERROR', 'LEGAL_OR_SECURITY_EMERGENCY', 'OTHER'
);

ALTER TYPE "OrderEventType" ADD VALUE 'CANCELLATION_REQUESTED';
ALTER TYPE "OrderEventType" ADD VALUE 'CANCELLATION_RESPONDED';
ALTER TYPE "OrderEventType" ADD VALUE 'CANCELLATION_RESOLVED';
ALTER TYPE "OrderEventType" ADD VALUE 'ORDER_DECLINED';

ALTER TABLE "Order"
  ADD COLUMN "warrantyDays" INTEGER,
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "fulfillmentDueAt" TIMESTAMP(3),
  ADD COLUMN "warrantyEndsAt" TIMESTAMP(3),
  ADD COLUMN "refundResponsibility" "CancellationResponsibility";

CREATE TABLE "OrderCancellationRequest" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "requestedByUserId" TEXT,
  "requesterType" "CancellationRequesterType" NOT NULL,
  "actorSnapshot" JSONB,
  "reasonCode" "CancellationReasonCode" NOT NULL,
  "note" TEXT,
  "status" "CancellationRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "previousOrderStatus" "OrderStatus" NOT NULL,
  "fulfillmentChannel" "FulfillmentChannel" NOT NULL,
  "responsibility" "CancellationResponsibility" NOT NULL DEFAULT 'UNDETERMINED',
  "requestedResolution" "CancellationResolution" NOT NULL DEFAULT 'FULL_REFUND',
  "responseDeadlineAt" TIMESTAMP(3),
  "respondedByUserId" TEXT,
  "responseNote" TEXT,
  "reviewedByUserId" TEXT,
  "financeApprovedByUserId" TEXT,
  "resolution" "CancellationResolution",
  "resolutionReason" TEXT,
  "refundTransactionId" TEXT,
  "idempotencyKey" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderCancellationRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderCancellationRequest_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OrderCancellationRequest_orderId_idempotencyKey_key"
  ON "OrderCancellationRequest"("orderId", "idempotencyKey");

CREATE INDEX "OrderCancellationRequest_orderId_status_idx"
  ON "OrderCancellationRequest"("orderId", "status");

CREATE INDEX "OrderCancellationRequest_status_responseDeadlineAt_idx"
  ON "OrderCancellationRequest"("status", "responseDeadlineAt");

CREATE INDEX "OrderCancellationRequest_createdAt_idx"
  ON "OrderCancellationRequest"("createdAt");

-- A database invariant closes the request/request race. Terminal cases remain
-- as immutable history while a new case can be opened later if necessary.
CREATE UNIQUE INDEX "OrderCancellationRequest_orderId_active_unique"
  ON "OrderCancellationRequest"("orderId")
  WHERE "status" IN ('REQUESTED', 'UNDER_REVIEW', 'PENDING_FINANCE', 'ESCALATED');

-- Backfill lifecycle timestamps conservatively from existing immutable events.
UPDATE "Order" o
SET "submittedAt" = e."createdAt"
FROM (
  SELECT "orderId", MIN("createdAt") AS "createdAt"
  FROM "OrderEvent"
  WHERE "eventType" = 'ORDER_SUBMITTED'
  GROUP BY "orderId"
) e
WHERE o."id" = e."orderId" AND o."submittedAt" IS NULL;

UPDATE "Order" o
SET "acceptedAt" = e."createdAt"
FROM (
  SELECT "orderId", MIN("createdAt") AS "createdAt"
  FROM "OrderEvent"
  WHERE "eventType" = 'ORDER_ACCEPTED'
  GROUP BY "orderId"
) e
WHERE o."id" = e."orderId" AND o."acceptedAt" IS NULL;
