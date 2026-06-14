-- Phase 5 cleanup. Drops what's truly dead after the listing-service
-- redesign lands:
--
--   * MarketplacePricingTier table — never read by application code; replaced
--     by per-service pricing on ListingService.
--   * MarketplaceListing.allowGuestPost / allowNicheEdit — replaced by the
--     presence of a ListingService row for each ServiceType on the listing.
--
-- Deferred to a follow-up cleanup pass (not this migration) because they
-- still surface in DTOs and UI display:
--   * MarketplaceListing.type        (drives some search filters + display)
--   * MarketplaceListing.price       (used by toPublicListing fallback)
--   * MarketplaceListing.turnaroundDays / revisionRounds / warrantyDays
--
-- DropForeignKey
ALTER TABLE "MarketplacePricingTier" DROP CONSTRAINT IF EXISTS "MarketplacePricingTier_listingId_fkey";

-- DropTable
DROP TABLE IF EXISTS "MarketplacePricingTier";

-- AlterTable
ALTER TABLE "MarketplaceListing"
  DROP COLUMN IF EXISTS "allowGuestPost",
  DROP COLUMN IF EXISTS "allowNicheEdit";
