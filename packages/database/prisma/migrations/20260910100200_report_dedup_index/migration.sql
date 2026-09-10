-- Nullable legacy rows remain outside uniqueness until they receive a key.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Report_dedupKey_key"
  ON public."Report"("dedupKey");
