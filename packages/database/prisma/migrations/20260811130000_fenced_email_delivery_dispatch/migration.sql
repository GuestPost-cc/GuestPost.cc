-- PostgreSQL requires a newly added enum label to commit before a later
-- transaction can use it in a table constraint. Keep this migration separate
-- from the dispatch evidence columns and checks in 20260811131000.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

ALTER TYPE "CommunicationDeliveryStatus"
  ADD VALUE IF NOT EXISTS 'DELIVERY_UNCERTAIN' AFTER 'FAILED';

COMMIT;
