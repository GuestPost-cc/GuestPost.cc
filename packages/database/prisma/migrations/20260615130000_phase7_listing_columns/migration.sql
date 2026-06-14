-- Phase 7 (final) — drop the deprecated MarketplaceListing legacy columns
-- and the ListingType enum that backed them.
--
-- Pre-flight (verified before running this migration):
--   * grep audit: no source reader of listing.type / .price /
--     .turnaroundDays / .revisionRounds / .warrantyDays in apps/api,
--     apps/worker, packages/api-client, or the three frontends. All UI
--     surfaces have been migrated to priceFrom + serviceTypes[] + services[]
--     (see Phase 7 task 31).
--   * Backend shim removed (Phase 7 task 32): LISTING_TYPE_TO_SERVICE_TYPE
--     bridge map + single-service create shim gone; related-listings /
--     recommendations / admin filter all rewritten to query
--     services.some({ serviceType }).
--   * createPlatformWebsite + updatePlatformWebsite no longer write the
--     deprecated columns; the listing row is created with the new shape.
--
-- Indexes dropped alongside the columns (Prisma also drops the FK / @@index
-- declarations in the schema):
--   * MarketplaceListing_type_idx
--   * MarketplaceListing_price_idx

-- DropIndex
DROP INDEX IF EXISTS "MarketplaceListing_type_idx";
DROP INDEX IF EXISTS "MarketplaceListing_price_idx";

-- AlterTable
ALTER TABLE "MarketplaceListing"
  DROP COLUMN IF EXISTS "type",
  DROP COLUMN IF EXISTS "price",
  DROP COLUMN IF EXISTS "turnaroundDays",
  DROP COLUMN IF EXISTS "revisionRounds",
  DROP COLUMN IF EXISTS "warrantyDays";

-- DropEnum
DROP TYPE IF EXISTS "ListingType";
