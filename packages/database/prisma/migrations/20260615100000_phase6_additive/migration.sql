-- Phase 6 additive bundle. Every change here is non-destructive: new columns
-- default NULL or to safe defaults, new indexes are concurrent-safe in
-- spirit (small dev DB; production deploy should add CREATE INDEX
-- CONCURRENTLY wrappers manually). No existing row is rewritten.
--
-- Covers:
--   1. Settlement.{listingServiceId, serviceType, ownerType, fulfillmentChannel, unitPrice}
--   2. PlatformRevenue.{same five}
--   3. Order.briefData JSONB
--   4. MarketplaceListingClick.serviceType
--   5. MarketplaceSearchHistory.serviceType
--   6. ListingService composite indexes (availability, serviceType, price)
--      and (availability, turnaroundDays)
--   7. Website.managedByUserId + FK + index
--   8. Ticket.{fulfillmentChannel, assignedToUserId, assignedPublisherId} + FKs + indexes
--   9. Settlement / PlatformRevenue serviceType + fulfillmentChannel + listingServiceId indexes

-- ── 1. Settlement snapshots ────────────────────────────────────────────
ALTER TABLE "Settlement"
  ADD COLUMN "listingServiceId"   TEXT,
  ADD COLUMN "serviceType"        "ServiceType",
  ADD COLUMN "ownerType"          "WebsiteOwnershipType",
  ADD COLUMN "fulfillmentChannel" "FulfillmentChannel",
  ADD COLUMN "unitPrice"          DECIMAL(65,30);

ALTER TABLE "Settlement"
  ADD CONSTRAINT "Settlement_listingServiceId_fkey"
  FOREIGN KEY ("listingServiceId") REFERENCES "ListingService"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Settlement_serviceType_idx"        ON "Settlement"("serviceType");
CREATE INDEX "Settlement_fulfillmentChannel_idx" ON "Settlement"("fulfillmentChannel");
CREATE INDEX "Settlement_listingServiceId_idx"   ON "Settlement"("listingServiceId");

-- ── 2. PlatformRevenue snapshots ───────────────────────────────────────
ALTER TABLE "PlatformRevenue"
  ADD COLUMN "listingServiceId"   TEXT,
  ADD COLUMN "serviceType"        "ServiceType",
  ADD COLUMN "ownerType"          "WebsiteOwnershipType",
  ADD COLUMN "fulfillmentChannel" "FulfillmentChannel",
  ADD COLUMN "unitPrice"          DECIMAL(65,30);

ALTER TABLE "PlatformRevenue"
  ADD CONSTRAINT "PlatformRevenue_listingServiceId_fkey"
  FOREIGN KEY ("listingServiceId") REFERENCES "ListingService"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PlatformRevenue_serviceType_idx"        ON "PlatformRevenue"("serviceType");
CREATE INDEX "PlatformRevenue_fulfillmentChannel_idx" ON "PlatformRevenue"("fulfillmentChannel");
CREATE INDEX "PlatformRevenue_listingServiceId_idx"   ON "PlatformRevenue"("listingServiceId");

-- ── 3. Order.briefData ─────────────────────────────────────────────────
-- JSONB so the publisher inbox / admin tooling can build GIN indexes
-- later if we add brief search. NULL on every existing row; populated
-- for new orders by the Zod registry in @guestpost/shared.
ALTER TABLE "Order" ADD COLUMN "briefData" JSONB;

-- ── 4. Analytics serviceType columns ───────────────────────────────────
ALTER TABLE "MarketplaceListingClick" ADD COLUMN "serviceType" "ServiceType";
CREATE INDEX "MarketplaceListingClick_serviceType_idx"
  ON "MarketplaceListingClick"("serviceType");

ALTER TABLE "MarketplaceSearchHistory" ADD COLUMN "serviceType" "ServiceType";
CREATE INDEX "MarketplaceSearchHistory_serviceType_idx"
  ON "MarketplaceSearchHistory"("serviceType");

-- ── 5. ListingService search hot-path indexes ──────────────────────────
CREATE INDEX "ListingService_availability_serviceType_price_idx"
  ON "ListingService"("availability", "serviceType", "price");
CREATE INDEX "ListingService_availability_turnaroundDays_idx"
  ON "ListingService"("availability", "turnaroundDays");

-- ── 6. Website.managedByUserId ─────────────────────────────────────────
ALTER TABLE "Website" ADD COLUMN "managedByUserId" TEXT;

ALTER TABLE "Website"
  ADD CONSTRAINT "Website_managedByUserId_fkey"
  FOREIGN KEY ("managedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Website_managedByUserId_ownershipType_idx"
  ON "Website"("managedByUserId", "ownershipType");

-- ── 7. Ticket routing columns ──────────────────────────────────────────
ALTER TABLE "Ticket"
  ADD COLUMN "fulfillmentChannel"  "FulfillmentChannel",
  ADD COLUMN "assignedToUserId"    TEXT,
  ADD COLUMN "assignedPublisherId" TEXT;

ALTER TABLE "Ticket"
  ADD CONSTRAINT "Ticket_assignedToUserId_fkey"
  FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Ticket"
  ADD CONSTRAINT "Ticket_assignedPublisherId_fkey"
  FOREIGN KEY ("assignedPublisherId") REFERENCES "Publisher"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Ticket_assignedToUserId_status_idx"
  ON "Ticket"("assignedToUserId", "status");
CREATE INDEX "Ticket_assignedPublisherId_status_idx"
  ON "Ticket"("assignedPublisherId", "status");
CREATE INDEX "Ticket_fulfillmentChannel_status_idx"
  ON "Ticket"("fulfillmentChannel", "status");
