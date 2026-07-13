-- Phase X: One active listing per website
--
-- Enforces the business rule that each publisher may have at most one
-- active (non-ARCHIVED) listing per verified website. Multiple service
-- offerings (Guest Post, Outreach Link, etc.) live as ListingService rows
-- under the single listing.
--
-- 1. Data cleanup: Archive duplicate active listings, keeping only the
--    most recently created one per website.
-- 2. Partial unique index: Prevents future duplicates at the DB level.

-- ── Step 1: Deduplicate existing data ──────────────────────────────────────
-- For each websiteId with multiple non-ARCHIVED listings, keep the newest
-- (by createdAt) and archive the rest. Uses a window-function approach that
-- handles ties deterministically (by id).

WITH ranked AS (
  SELECT
    id,
    "websiteId",
    ROW_NUMBER() OVER (
      PARTITION BY "websiteId"
      ORDER BY "createdAt" DESC, id DESC
    ) AS rn
  FROM "MarketplaceListing"
  WHERE
    "websiteId" IS NOT NULL
    AND "status" != 'ARCHIVED'
)
UPDATE "MarketplaceListing"
SET "status" = 'ARCHIVED'
WHERE id IN (
  SELECT id FROM ranked WHERE rn > 1
);

-- Log how many rows were archived for auditability.
-- (DO $block$ … END; lets us RAISE a notice without affecting the transaction.)
DO $$
DECLARE
  archived_count INT;
BEGIN
  GET DIAGNOSTICS archived_count = ROW_COUNT;
  RAISE NOTICE 'Archived % duplicate listing(s) to enforce one-listing-per-website.', archived_count;
END $$;

-- ── Step 2: Create partial unique index ─────────────────────────────────────
-- Only active (non-ARCHIVED) listings with a websiteId are constrained.
-- ARCHIVED listings and listings without a websiteId (platform-owned) are
-- excluded, allowing multiple NULL websiteIds.

CREATE UNIQUE INDEX "MarketplaceListing_websiteId_active_key"
  ON "MarketplaceListing" ("websiteId")
  WHERE "websiteId" IS NOT NULL AND "status" != 'ARCHIVED';
