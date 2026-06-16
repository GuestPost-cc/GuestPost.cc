-- Phase 7.7 A1 — Promote requestId from AuditLog.metadata JSON to an indexed
-- top-level column. Existing rows backfilled from metadata->>'requestId'
-- where present; pre-Phase-7.0 rows stay NULL (no requestId was captured).
--
-- Index is partial (WHERE requestId IS NOT NULL) to keep size proportional
-- to actually-correlated rows, not total audit history. Same precedent as
-- Phase 7.4's Notification.dedupKey partial unique.
--
-- Note: plain CREATE INDEX (not CONCURRENTLY) — Prisma 6.19.3 wraps each
-- migration in a transaction and CONCURRENTLY can't run inside one
-- (prisma#14456; fixed in Prisma 7.4+). Brief ACCESS EXCLUSIVE lock on
-- AuditLog during build is acceptable: AuditLog isn't on the order-
-- fulfillment hot path, and at current scale the build completes in
-- well under a second. Off-peak prod apply still recommended in the
-- runbook for safety.
--
-- IF NOT EXISTS on every DDL — Prisma runs migrations once in prod, but in
-- dev a developer may apply this against a partially-recovered DB (manual
-- psql edit, a failed prior migration, a restored backup). All three
-- statements stay safely re-applicable.

ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "requestId" VARCHAR(128);

UPDATE "AuditLog"
  SET "requestId" = metadata->>'requestId'
  WHERE "requestId" IS NULL
    AND metadata->>'requestId' IS NOT NULL;

CREATE INDEX IF NOT EXISTS "AuditLog_requestId_idx" ON "AuditLog" ("requestId")
  WHERE "requestId" IS NOT NULL;
