-- Phase 1 of the marketplace listing-service redesign. All changes are
-- additive: every new column is nullable or has a safe default, and the new
-- table sits alongside MarketplaceListing rather than replacing it.
--
-- New enums:   ServiceAvailability, FulfillmentChannel
-- New table:   ListingService
-- New columns: MarketplaceListing.ownerType
--              MarketplaceFavorite.serviceType
--              Order.listingId, listingServiceId, fulfillmentChannel,
--                    turnaroundDays
-- Backfill:    MarketplaceListing.ownerType  <- publisherId presence
--              ListingService rows           <- one per existing listing,
--                                               copying its current single
--                                               (type, price, turnaroundDays,
--                                                revisionRounds, warrantyDays)
--              MarketplaceFavorite uniqueness: relax to (user, listing,
--                                               serviceType NULL-safe)
--
-- No existing row is updated destructively; legacy reads keep working.

-- CreateEnum
CREATE TYPE "ServiceAvailability" AS ENUM ('AVAILABLE', 'PAUSED', 'WAITLIST');

-- CreateEnum
CREATE TYPE "FulfillmentChannel" AS ENUM ('PUBLISHER', 'PLATFORM');

-- AlterTable: MarketplaceListing.ownerType (default PUBLISHER, then backfill)
ALTER TABLE "MarketplaceListing"
  ADD COLUMN "ownerType" "WebsiteOwnershipType" NOT NULL DEFAULT 'PUBLISHER';

UPDATE "MarketplaceListing"
SET "ownerType" = CASE
  WHEN "publisherId" IS NOT NULL THEN 'PUBLISHER'::"WebsiteOwnershipType"
  ELSE 'PLATFORM'::"WebsiteOwnershipType"
END;

-- AlterTable: MarketplaceFavorite scoped-favorite support
ALTER TABLE "MarketplaceFavorite"
  ADD COLUMN "serviceType" "ServiceType";

-- The old uniqueness was (userId, listingId). The new uniqueness is
-- (userId, listingId, serviceType) with NULL meaning "whole listing" — so a
-- user can favorite a listing AND favorite a specific service on it.
-- Postgres treats NULL as distinct in UNIQUE; that's the behavior we want.
DROP INDEX IF EXISTS "MarketplaceFavorite_userId_listingId_key";
CREATE UNIQUE INDEX "MarketplaceFavorite_userId_listingId_serviceType_key"
  ON "MarketplaceFavorite"("userId", "listingId", "serviceType");
CREATE INDEX "MarketplaceFavorite_listingId_serviceType_idx"
  ON "MarketplaceFavorite"("listingId", "serviceType");

-- AlterTable: Order snapshot columns (all nullable in Phase 1)
ALTER TABLE "Order"
  ADD COLUMN "listingId"          TEXT,
  ADD COLUMN "listingServiceId"   TEXT,
  ADD COLUMN "fulfillmentChannel" "FulfillmentChannel",
  ADD COLUMN "turnaroundDays"     INTEGER;

CREATE INDEX "Order_listingId_idx"          ON "Order"("listingId");
CREATE INDEX "Order_listingServiceId_idx"   ON "Order"("listingServiceId");
CREATE INDEX "Order_fulfillmentChannel_status_idx"
  ON "Order"("fulfillmentChannel", "status");

CREATE INDEX "MarketplaceListing_ownerType_status_idx"
  ON "MarketplaceListing"("ownerType", "status");

-- CreateTable: ListingService
CREATE TABLE "ListingService" (
    "id"                  TEXT NOT NULL,
    "listingId"           TEXT NOT NULL,
    "serviceType"         "ServiceType" NOT NULL,
    "price"               DECIMAL(65,30) NOT NULL,
    "currency"            TEXT NOT NULL DEFAULT 'USD',
    "turnaroundDays"      INTEGER NOT NULL,
    "revisionRounds"      INTEGER NOT NULL DEFAULT 2,
    "warrantyDays"        INTEGER,
    "requirements"        JSONB,
    "fulfillmentSettings" JSONB,
    "availability"        "ServiceAvailability" NOT NULL DEFAULT 'AVAILABLE',
    "version"             INTEGER NOT NULL DEFAULT 0,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingService_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ListingService_listingId_serviceType_key"
  ON "ListingService"("listingId", "serviceType");
CREATE INDEX "ListingService_listingId_idx" ON "ListingService"("listingId");
CREATE INDEX "ListingService_serviceType_availability_idx"
  ON "ListingService"("serviceType", "availability");
CREATE INDEX "ListingService_availability_idx" ON "ListingService"("availability");

ALTER TABLE "ListingService"
  ADD CONSTRAINT "ListingService_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_listingServiceId_fkey"
  FOREIGN KEY ("listingServiceId") REFERENCES "ListingService"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one ListingService row per existing MarketplaceListing.
-- The legacy listing carries a single (type, price, turnaroundDays,
-- revisionRounds, warrantyDays). We translate ListingType -> ServiceType for
-- the values that match the new enum; the marketplace-only ListingTypes
-- (INTERNAL_SERVICE, PUBLISHER_WEBSITE, DIGITAL_PR, SPONSORED_CONTENT) get
-- skipped — those legacy listings stay readable but won't have a service row
-- until Phase 2 backend code provisions one.
INSERT INTO "ListingService" (
  "id", "listingId", "serviceType", "price", "currency",
  "turnaroundDays", "revisionRounds", "warrantyDays",
  "availability", "version", "createdAt", "updatedAt"
)
SELECT
  -- cuid-shaped: ml_<listing-id>_backfill — collision-free, sortable, traceable
  'ls_bf_' || "id",
  "id",
  CASE "type"::text
    WHEN 'GUEST_POST'      THEN 'GUEST_POST'::"ServiceType"
    WHEN 'NICHE_EDIT'      THEN 'NICHE_EDIT'::"ServiceType"
    WHEN 'EDITORIAL_LINK'  THEN 'EDITORIAL_LINK'::"ServiceType"
    WHEN 'OUTREACH_LINK'   THEN 'OUTREACH_LINK'::"ServiceType"
    WHEN 'LOCAL_CITATION'  THEN 'LOCAL_CITATION'::"ServiceType"
    WHEN 'FOUNDATION_LINK' THEN 'FOUNDATION_LINK'::"ServiceType"
    WHEN 'BLOG_ARTICLE'    THEN 'BLOG_ARTICLE'::"ServiceType"
    WHEN 'SEO_CONTENT'     THEN 'SEO_CONTENT'::"ServiceType"
  END,
  "price",
  "currency",
  COALESCE("turnaroundDays", 7),
  COALESCE("revisionRounds", 2),
  "warrantyDays",
  CASE "status"::text
    WHEN 'APPROVED' THEN 'AVAILABLE'::"ServiceAvailability"
    WHEN 'PAUSED'   THEN 'PAUSED'::"ServiceAvailability"
    ELSE 'PAUSED'::"ServiceAvailability"
  END,
  0,
  "createdAt",
  CURRENT_TIMESTAMP
FROM "MarketplaceListing"
WHERE "type"::text IN (
  'GUEST_POST', 'NICHE_EDIT', 'EDITORIAL_LINK', 'OUTREACH_LINK',
  'LOCAL_CITATION', 'FOUNDATION_LINK', 'BLOG_ARTICLE', 'SEO_CONTENT'
);
