-- Single-statement migration: Prisma 7.8 leaves this outside its implicit
-- multi-statement transaction, which PostgreSQL requires for online builds.
-- IF NOT EXISTS is intentionally omitted; see the concurrent-index recovery
-- procedure in docs/PRODUCTION_RUNBOOK.md for invalid interrupted builds.
CREATE INDEX CONCURRENTLY "ApiKey_createdByUserId_idx"
  ON public."ApiKey"("createdByUserId");
