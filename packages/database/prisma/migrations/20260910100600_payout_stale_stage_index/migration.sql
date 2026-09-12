-- Intentionally no IF NOT EXISTS; see the invalid-index recovery runbook.
CREATE INDEX CONCURRENTLY "PayoutExecution_stale_stage_idx"
  ON public."PayoutExecution"("status", "stage", "updatedAt", "id");
