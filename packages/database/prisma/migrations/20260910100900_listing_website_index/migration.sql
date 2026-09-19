-- Intentionally no IF NOT EXISTS; see the invalid-index recovery runbook.
CREATE INDEX CONCURRENTLY "MarketplaceListing_websiteId_idx"
  ON public."MarketplaceListing"("websiteId");
