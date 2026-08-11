-- Advance the same URL fence after the reader's SERIALIZABLE snapshot exists.

\set ON_ERROR_STOP on

BEGIN;

UPDATE public."OrderDeliveryVersion"
SET "normalizedUrl" = "normalizedUrl"
WHERE "id" = 'migration-rehearsal-settlement-delivery';

COMMIT;
