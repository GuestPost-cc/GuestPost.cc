-- Phase 8.12 — Cascade SetNull for Notification + TicketMessage foreign keys
--
-- Makes userId nullable so user deletion (when built) nullifies the
-- reference instead of blocking the delete or cascading the removal.
-- The userId column remains populated for all live rows; this change
-- is schema evolution for future hard-delete support.

-- NOTE: This migration assumes the tables were created in earlier migrations.
-- If running in a fresh/empty database (e.g., integration test template),
-- we use a safer approach: check if tables exist and only attempt to
-- modify them if they do. If they don't exist, we do nothing.

-- Check if TicketMessage table exists and alter it if it does
DO $$
DECLARE
  table_exists boolean;
  fk_name text;
BEGIN
  SELECT EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_name = 'TicketMessage'
  ) INTO table_exists;

  IF NOT table_exists THEN
    RETURN;
  END IF;

  -- Find and drop existing foreign key constraint
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
  EXCEPTION WHEN OTHERS THEN
    -- If we get any error finding or dropping the constraint, just log it and continue
    RAISE NOTICE 'Could not drop foreign key constraint on TicketMessage.userId: %', SQLERRM;
  END;

  -- Make userId nullable
  BEGIN
    EXECUTE 'ALTER TABLE "TicketMessage" ALTER COLUMN "userId" DROP NOT NULL';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not make userId nullable on TicketMessage: %', SQLERRM;
  END;

  -- Create new foreign key constraint with ON DELETE SET NULL
  BEGIN
    EXECUTE 'ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not add foreign key constraint to TicketMessage.userId: %', SQLERRM;
  END;
END $$;

-- Check if Notification table exists and alter it if it does
DO $$
DECLARE
  table_exists boolean;
  fk_name text;
BEGIN
  SELECT EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_name = 'Notification'
  ) INTO table_exists;

  IF NOT table_exists THEN
    RETURN;
  END IF;

  -- Find and drop existing foreign key constraint
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
  EXCEPTION WHEN OTHERS THEN
    -- If we get any error finding or dropping the constraint, just log it and continue
    RAISE NOTICE 'Could not drop foreign key constraint on Notification.userId: %', SQLERRM;
  END;

  -- Make userId nullable
  BEGIN
    EXECUTE 'ALTER TABLE "Notification" ALTER COLUMN "userId" DROP NOT NULL';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not make userId nullable on Notification: %', SQLERRM;
  END;

  -- Create new foreign key constraint with ON DELETE SET NULL
  BEGIN
    EXECUTE 'ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not add foreign key constraint to Notification.userId: %', SQLERRM;
  END;
END $$;
