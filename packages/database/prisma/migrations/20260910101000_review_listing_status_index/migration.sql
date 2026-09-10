CREATE INDEX CONCURRENTLY IF NOT EXISTS "MarketplaceReview_listingId_status_idx"
  ON public."MarketplaceReview"("listingId", "status");
