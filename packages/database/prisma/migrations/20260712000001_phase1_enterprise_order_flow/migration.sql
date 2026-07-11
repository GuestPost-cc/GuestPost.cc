-- CreateEnum
CREATE TYPE "DeliveryVerificationMethod" AS ENUM ('AUTO', 'MANUAL_ADMIN', 'CUSTOMER_MANUAL');

-- CreateEnum
CREATE TYPE "DeliveryAcceptedMethod" AS ENUM ('CUSTOMER', 'AUTO_TIMEOUT');

-- CreateEnum
CREATE TYPE "VerificationOverrideReason" AS ENUM ('CRAWLER_BLOCKED', 'ROBOTS_TXT', 'LOGIN_REQUIRED', 'JS_RENDERING', 'TEMPORARY_FAILURE', 'OTHER');

-- CreateEnum
CREATE TYPE "SettlementReleasePolicy" AS ENUM ('AUTO', 'MANUAL');

-- AlterEnum — add new OrderEventType values
ALTER TYPE "OrderEventType" ADD VALUE 'VERIFICATION_ESCALATED' BEFORE 'SETTLEMENT_CREATED';
ALTER TYPE "OrderEventType" ADD VALUE 'AUTO_ACCEPTED' BEFORE 'SETTLEMENT_CREATED';
ALTER TYPE "OrderEventType" ADD VALUE 'REVIEW_REMINDER' BEFORE 'SETTLEMENT_CREATED';

-- AlterTable: Order
-- Change verifyMethod from String? to DeliveryVerificationMethod? with data migration
ALTER TABLE "Order"
  ALTER COLUMN "verifyMethod" TYPE "DeliveryVerificationMethod"
  USING (
    CASE "verifyMethod"
      WHEN 'auto' THEN 'AUTO'::"DeliveryVerificationMethod"
      WHEN 'manual' THEN 'MANUAL_ADMIN'::"DeliveryVerificationMethod"
      WHEN 'override' THEN 'MANUAL_ADMIN'::"DeliveryVerificationMethod"
      WHEN 'customer_manual' THEN 'CUSTOMER_MANUAL'::"DeliveryVerificationMethod"
      ELSE NULL
    END
  );

-- Add new columns to Order
ALTER TABLE "Order"
  ADD COLUMN "autoAcceptAt" TIMESTAMP(3),
  ADD COLUMN "deliveryAcceptedMethod" "DeliveryAcceptedMethod";

-- AlterTable: OrderDeliveryVersion
ALTER TABLE "OrderDeliveryVersion"
  ADD COLUMN "adminVerifiedById" TEXT,
  ADD COLUMN "adminOverrideReason" "VerificationOverrideReason",
  ADD COLUMN "adminVerifiedNotes" TEXT;

-- AddForeignKey for adminVerifiedById
ALTER TABLE "OrderDeliveryVersion"
  ADD CONSTRAINT "OrderDeliveryVersion_adminVerifiedById_fkey"
  FOREIGN KEY ("adminVerifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex for adminVerifiedById
CREATE INDEX "OrderDeliveryVersion_adminVerifiedById_idx" ON "OrderDeliveryVersion"("adminVerifiedById");

-- AlterTable: Settlement
ALTER TABLE "Settlement"
  ADD COLUMN "releasePolicy" "SettlementReleasePolicy" NOT NULL DEFAULT 'AUTO';
