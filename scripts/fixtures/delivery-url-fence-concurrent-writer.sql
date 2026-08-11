-- Advance the same URL fence after the reader's SERIALIZABLE snapshot exists.

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  UPDATE public."OrderDeliveryVersion"
  SET "normalizedUrl" = "normalizedUrl"
  WHERE "id" = 'migration-rehearsal-settlement-delivery';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'concurrent writer fixture found no delivery row to advance';
  END IF;
END
$$;

COMMIT;
