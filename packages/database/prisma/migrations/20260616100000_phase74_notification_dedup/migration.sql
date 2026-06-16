-- Phase 7.4 — Notification dedup (audit #12).
--
-- BullMQ retries failed jobs (default 3 attempts on notification queue);
-- each retry today re-runs `prisma.notification.create(...)` and produces a
-- fresh row. Hourly reconciliation × 3 retries = up to 3 notifications per
-- staff per drift per hour until cleared. This migration enables idempotent
-- writes: a (userId, dedupKey) pair can exist at most once.
--
-- Design:
--   1. `dedupKey VARCHAR(256)` — bounded length is defense-in-depth (the
--      app-level builder also validates ≤256, but a stray direct insert
--      from an admin tool can't blow past it). Nullable: writers that don't
--      yet supply a key keep working — legacy NULL rows coexist freely.
--   2. Partial unique index `WHERE dedupKey IS NOT NULL` — Postgres treats
--      NULL as distinct in plain UNIQUE, but explicit partial-unique
--      removes any ambiguity and keeps the index slim (only deduplicated
--      rows are indexed).
--   3. App-level: writers wrap `notification.create` in try/catch on Prisma
--      P2002 unique-violation and treat it as success (the row already
--      exists for this (userId, dedupKey) — the retry is a no-op).

ALTER TABLE "Notification" ADD COLUMN "dedupKey" VARCHAR(256);

CREATE UNIQUE INDEX "Notification_userId_dedupKey_key"
  ON "Notification" ("userId", "dedupKey")
  WHERE "dedupKey" IS NOT NULL;
