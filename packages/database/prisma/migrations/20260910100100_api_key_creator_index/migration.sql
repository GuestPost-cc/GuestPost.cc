-- Single-statement migration: Prisma 7.8 leaves this outside its implicit
-- multi-statement transaction, which PostgreSQL requires for online builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ApiKey_createdByUserId_idx"
  ON public."ApiKey"("createdByUserId");
