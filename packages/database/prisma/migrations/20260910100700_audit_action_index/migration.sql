-- Intentionally no IF NOT EXISTS; see the invalid-index recovery runbook.
CREATE INDEX CONCURRENTLY "AuditLog_action_createdAt_id_idx"
  ON public."AuditLog"("action", "createdAt", "id");
