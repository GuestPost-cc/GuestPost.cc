CREATE INDEX CONCURRENTLY IF NOT EXISTS "AuditLog_action_createdAt_id_idx"
  ON public."AuditLog"("action", "createdAt", "id");
