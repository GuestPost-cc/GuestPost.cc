-- Phase 7.13.2B (part 2 of 2) — rename new unique to canonical Prisma name.
-- Closes the Phase 7.13.2 umbrella; this part runs after the part-1 DROP.
--
-- Why a separate migration from part 1: see part-1 header. tldr: prisma@7.8.0
-- wraps multi-statement migration files in a transaction; DROP INDEX
-- CONCURRENTLY can't run inside one. So DROP + RENAME ship as two
-- single-statement migration files.
--
-- Part 1 freed the canonical name `MarketplaceFavorite_userId_listingId_serviceType_key`.
-- Part 2 rebinds the 7.13.2A NULLS-NOT-DISTINCT index to that canonical
-- name so Prisma's drift detection sees the schema.prisma @@unique
-- declaration matching the live index.
--
-- ALTER INDEX RENAME is metadata-only — no data movement, brief
-- catalog-level lock, no impact on race-proofing.
--
-- Order matters: part-1 (DROP) must apply BEFORE part-2 (RENAME);
-- otherwise the RENAME would error attempting to use a name already
-- in use. Prisma's migrate runner applies migrations in lexicographic
-- order by directory name, so the timestamp prefixes guarantee this.

ALTER INDEX "MarketplaceFavorite_uniq_nullsnotdistinct"
  RENAME TO "MarketplaceFavorite_userId_listingId_serviceType_key";
