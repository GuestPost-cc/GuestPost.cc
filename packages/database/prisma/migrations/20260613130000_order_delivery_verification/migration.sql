-- CreateEnum
CREATE TYPE "FulfillmentAssignmentStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'MANUAL_REVIEW', 'RETRYING');

-- CreateEnum
CREATE TYPE "DeliveryInterventionStatus" AS ENUM ('NONE', 'APPROVED', 'REJECTED', 'OVERRIDDEN');

-- DropForeignKey

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "activeDeliveryVersionId" TEXT;

-- CreateTable
CREATE TABLE "FulfillmentAssignment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "assignedToUserId" TEXT NOT NULL,
    "assignedByUserId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" "FulfillmentAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfillmentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderDeliveryVersion" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "publishedUrl" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "articleTitle" TEXT,
    "notes" TEXT,
    "screenshotUrl" TEXT,
    "submittedByUserId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verificationStatus" "DeliveryVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verificationFailureReason" TEXT,
    "interventionStatus" "DeliveryInterventionStatus" NOT NULL DEFAULT 'NONE',
    "supersededByVersion" INTEGER,
    "verificationVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDeliveryVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryVerificationEvidence" (
    "id" TEXT NOT NULL,
    "deliveryVersionId" TEXT NOT NULL,
    "pageTitle" TEXT,
    "metaTitle" TEXT,
    "canonicalUrl" TEXT,
    "resolvedUrl" TEXT NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "anchorFound" BOOLEAN NOT NULL DEFAULT false,
    "linkFound" BOOLEAN NOT NULL DEFAULT false,
    "targetUrlMatched" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAnchorText" TEXT,
    "verifiedTargetUrl" TEXT,
    "htmlHash" TEXT,
    "redirectChain" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryVerificationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliverySnapshot" (
    "id" TEXT NOT NULL,
    "deliveryVersionId" TEXT NOT NULL,
    "htmlObjectKey" TEXT NOT NULL,
    "screenshotObjectKey" TEXT,
    "responseHeaders" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliverySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryFraudFlag" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "deliveryVersionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryFraudFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FulfillmentAssignment_orderId_idx" ON "FulfillmentAssignment"("orderId");

-- CreateIndex
CREATE INDEX "FulfillmentAssignment_assignedToUserId_status_idx" ON "FulfillmentAssignment"("assignedToUserId", "status");

-- CreateIndex
CREATE INDEX "FulfillmentAssignment_status_idx" ON "FulfillmentAssignment"("status");

-- CreateIndex
CREATE INDEX "OrderDeliveryVersion_orderId_idx" ON "OrderDeliveryVersion"("orderId");

-- CreateIndex
CREATE INDEX "OrderDeliveryVersion_verificationStatus_idx" ON "OrderDeliveryVersion"("verificationStatus");

-- CreateIndex
CREATE INDEX "OrderDeliveryVersion_normalizedUrl_idx" ON "OrderDeliveryVersion"("normalizedUrl");

-- CreateIndex
CREATE UNIQUE INDEX "OrderDeliveryVersion_orderId_version_key" ON "OrderDeliveryVersion"("orderId", "version");

-- CreateIndex
CREATE INDEX "DeliveryVerificationEvidence_deliveryVersionId_idx" ON "DeliveryVerificationEvidence"("deliveryVersionId");

-- CreateIndex
CREATE INDEX "DeliverySnapshot_deliveryVersionId_idx" ON "DeliverySnapshot"("deliveryVersionId");

-- CreateIndex
CREATE INDEX "DeliveryFraudFlag_orderId_idx" ON "DeliveryFraudFlag"("orderId");

-- CreateIndex
CREATE INDEX "DeliveryFraudFlag_deliveryVersionId_idx" ON "DeliveryFraudFlag"("deliveryVersionId");

-- CreateIndex
CREATE INDEX "DeliveryFraudFlag_type_idx" ON "DeliveryFraudFlag"("type");

-- AddForeignKey

-- AddForeignKey
ALTER TABLE "FulfillmentAssignment" ADD CONSTRAINT "FulfillmentAssignment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDeliveryVersion" ADD CONSTRAINT "OrderDeliveryVersion_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryVerificationEvidence" ADD CONSTRAINT "DeliveryVerificationEvidence_deliveryVersionId_fkey" FOREIGN KEY ("deliveryVersionId") REFERENCES "OrderDeliveryVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliverySnapshot" ADD CONSTRAINT "DeliverySnapshot_deliveryVersionId_fkey" FOREIGN KEY ("deliveryVersionId") REFERENCES "OrderDeliveryVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryFraudFlag" ADD CONSTRAINT "DeliveryFraudFlag_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryFraudFlag" ADD CONSTRAINT "DeliveryFraudFlag_deliveryVersionId_fkey" FOREIGN KEY ("deliveryVersionId") REFERENCES "OrderDeliveryVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Backfill: existing single-delivery orders -> immutable v1 ───────────────
-- Every order that was already published becomes delivery version 1. Orders
-- already VERIFIED/DELIVERED/SETTLED/COMPLETED keep VERIFIED status so prior
-- settlements are not retroactively blocked; still-in-flight published orders
-- become PENDING and will be picked up by the verification worker on next action.
INSERT INTO "OrderDeliveryVersion" (
  "id", "orderId", "version", "publishedUrl", "normalizedUrl",
  "submittedByUserId", "submittedAt", "verificationStatus", "interventionStatus",
  "verificationVersion", "createdAt"
)
SELECT
  'odv_' || "id",
  "id",
  1,
  "publishedUrl",
  lower("publishedUrl"),
  COALESCE("assigneeId", "verifiedBy", 'system'),
  COALESCE("publishedAt", "createdAt"),
  CASE WHEN "status" IN ('VERIFIED','DELIVERED','SETTLED','COMPLETED') THEN 'VERIFIED'::"DeliveryVerificationStatus"
       ELSE 'PENDING'::"DeliveryVerificationStatus" END,
  'NONE'::"DeliveryInterventionStatus",
  0,
  COALESCE("publishedAt", "createdAt")
FROM "Order"
WHERE "publishedUrl" IS NOT NULL AND "publishedUrl" <> '';

-- Point each backfilled order at its v1 as the active delivery.
UPDATE "Order" SET "activeDeliveryVersionId" = 'odv_' || "id"
WHERE "publishedUrl" IS NOT NULL AND "publishedUrl" <> '';
