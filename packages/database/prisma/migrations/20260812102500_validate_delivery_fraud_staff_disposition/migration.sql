-- The original disposition constraint was installed NOT VALID so pre-
-- classification rows could be preserved without inventing staff evidence.
-- This release gate validates the retained history and fails closed if any
-- legacy STAFF_CLEARED row still lacks the required bounded disposition.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

ALTER TABLE public."DeliveryFraudFlagResolution"
  VALIDATE CONSTRAINT "DeliveryFraudFlagResolution_staff_disposition_check";

COMMIT;
