-- Intentionally no IF NOT EXISTS; see the invalid-index recovery runbook.
CREATE INDEX CONCURRENTLY "AuditLog_user_action_createdAt_idx"
  ON public."AuditLog"("userId", "action", "createdAt");
