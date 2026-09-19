-- Intentionally no IF NOT EXISTS; see the invalid-index recovery runbook.
CREATE INDEX CONCURRENTLY "MarketplaceReview_listingId_status_idx"
  ON public."MarketplaceReview"("listingId", "status");
