-- Phase 7.5 — Backfill Phase 6 snapshot fields on historical Settlement +
-- PlatformRevenue rows (audit #21).
--
-- Phase 6's additive migration (20260615100000_phase6_additive) added five
-- nullable snapshot columns to both tables without backfilling historical
-- rows. Pre-Phase-6 rows therefore have NULL listingServiceId / serviceType /
-- unitPrice / ownerType / fulfillmentChannel forever. Phase 7.1's revenue
-- dashboard collapses all such rows into a single "(unknown)" bucket — the
-- data exists in the source Order rows but isn't snapshotted onto the
-- Settlement / PlatformRevenue rows where the dashboard queries.
--
-- This migration JOINs back to Order → ListingService + Website and fills
-- the NULL snapshot fields from the source-of-truth columns. Idempotent:
-- WHERE col IS NULL skips rows that already have the snapshot baked in
-- (post-Phase-6 writes via order-review.service.ts / settlements.service.ts).
--
-- For pre-Phase-4 orders (Order.listingServiceId IS NULL — listing service
-- snapshot was never captured at order creation), the LEFT JOINs produce
-- NULL on the ListingService side, and COALESCE leaves the Settlement
-- snapshot NULL. That's the audit's accepted behavior: "row stays NULL"
-- (data that was never recorded cannot be reconstructed). Phase 7.1's
-- dashboard handles these via the "(unknown)" bucket — coverage just
-- shrinks rather than going to zero.
--
-- COALESCE(existing, computed) protects partially-populated rows: if a
-- settlement somehow has serviceType set but listingServiceId NULL (legacy
-- edge case), the populated field is preserved while only the NULL field
-- gets filled. Avoids silently overwriting good data.
--
-- ownerType + fulfillmentChannel: snapshot-first / ownership-fallback pattern
-- matches Phase 7.1's reporting.service.ts:32 fix (audit #15). Snapshot from
-- Order.fulfillmentChannel when present; fall back to Website.ownershipType
-- for legacy rows.

-- ── Settlement backfill ────────────────────────────────────────────────────
UPDATE "Settlement" s
SET
  "listingServiceId"   = COALESCE(s."listingServiceId",   o."listingServiceId"),
  "serviceType"        = COALESCE(s."serviceType",        ls."serviceType"),
  "unitPrice"          = COALESCE(s."unitPrice",          ls."price"),
  "fulfillmentChannel" = COALESCE(s."fulfillmentChannel", o."fulfillmentChannel"),
  "ownerType"          = COALESCE(s."ownerType",          w."ownershipType")
FROM "Order" o
LEFT JOIN "ListingService" ls ON o."listingServiceId" = ls.id
LEFT JOIN "Website" w         ON o."websiteId"        = w.id
WHERE s."orderId" = o.id
  AND (
    s."listingServiceId"   IS NULL OR
    s."serviceType"        IS NULL OR
    s."unitPrice"          IS NULL OR
    s."fulfillmentChannel" IS NULL OR
    s."ownerType"          IS NULL
  );

-- ── PlatformRevenue backfill (same shape, same join chain) ────────────────
UPDATE "PlatformRevenue" pr
SET
  "listingServiceId"   = COALESCE(pr."listingServiceId",   o."listingServiceId"),
  "serviceType"        = COALESCE(pr."serviceType",        ls."serviceType"),
  "unitPrice"          = COALESCE(pr."unitPrice",          ls."price"),
  "fulfillmentChannel" = COALESCE(pr."fulfillmentChannel", o."fulfillmentChannel"),
  "ownerType"          = COALESCE(pr."ownerType",          w."ownershipType")
FROM "Order" o
LEFT JOIN "ListingService" ls ON o."listingServiceId" = ls.id
LEFT JOIN "Website" w         ON o."websiteId"        = w.id
WHERE pr."orderId" = o.id
  AND (
    pr."listingServiceId"   IS NULL OR
    pr."serviceType"        IS NULL OR
    pr."unitPrice"          IS NULL OR
    pr."fulfillmentChannel" IS NULL OR
    pr."ownerType"          IS NULL
  );
