-- Phase 8.12 — Cascade SetNull for Notification + TicketMessage foreign keys
--
-- Makes userId nullable so user deletion (when built) nullifies the
-- reference instead of blocking the delete or cascading the removal.
-- The userId column remains populated for all live rows; this change
-- is schema evolution for future hard-delete support.

-- TicketMessage: drop existing FK, recreate with ON DELETE SET NULL
DO $$
DECLARE
  fk_name text;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'TicketMessage'::regclass
    AND contype = 'f'
    AND confrelid = 'User'::regclass
    AND conname ~ 'userId'
  ORDER BY conname
  LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "TicketMessage" DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

ALTER TABLE "TicketMessage" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "TicketMessage"
  ADD CONSTRAINT "TicketMessage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL;

-- Notification: drop existing FK, recreate with ON DELETE SET NULL
DO $$
DECLARE
  fk_name text;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'Notification'::regclass
    AND contype = 'f'
    AND confrelid = 'User'::regclass
    AND conname ~ 'userId'
  ORDER BY conname
  LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "Notification" DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

ALTER TABLE "Notification" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL;
