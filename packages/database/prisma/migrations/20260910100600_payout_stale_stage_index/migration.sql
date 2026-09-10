CREATE INDEX CONCURRENTLY IF NOT EXISTS "PayoutExecution_stale_stage_idx"
  ON public."PayoutExecution"("status", "stage", "updatedAt", "id");
