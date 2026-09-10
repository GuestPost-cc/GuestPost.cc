CREATE INDEX CONCURRENTLY IF NOT EXISTS "AuditLog_user_action_createdAt_idx"
  ON public."AuditLog"("userId", "action", "createdAt");
