-- Validate the email-dispatch evidence checks only after the short
-- ACCESS EXCLUSIVE add-column/add-constraint migration has committed.
-- PostgreSQL enforces NOT VALID checks for every new write immediately;
-- validation scans historical rows with the less disruptive lock mode.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

ALTER TABLE "CommunicationDelivery"
  VALIDATE CONSTRAINT "CommunicationDelivery_dispatch_evidence_check";

ALTER TABLE "CommunicationDelivery"
  VALIDATE CONSTRAINT "CommunicationDelivery_uncertain_dispatch_check";

COMMIT;
