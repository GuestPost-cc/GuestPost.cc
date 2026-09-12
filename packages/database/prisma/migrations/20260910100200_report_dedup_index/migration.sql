-- Nullable legacy rows remain outside uniqueness until they receive a key.
-- IF NOT EXISTS is intentionally omitted so an invalid interrupted build
-- fails closed; recovery is documented in docs/PRODUCTION_RUNBOOK.md.
CREATE UNIQUE INDEX CONCURRENTLY "Report_dedupKey_key"
  ON public."Report"("dedupKey");
