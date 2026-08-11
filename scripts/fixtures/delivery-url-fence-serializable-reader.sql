-- Establish a SERIALIZABLE snapshot before another connection advances the
-- URL fence. The harness expects the final function call to fail with 40001.

\set ON_ERROR_STOP on
\set VERBOSITY verbose

BEGIN ISOLATION LEVEL SERIALIZABLE;

SELECT count(*)
FROM public."OrderDeliveryVersion"
WHERE "normalizedUrl" =
  'https://metrics-rehearsal.invalid/rehearsal-article';

\echo SERIALIZABLE_SNAPSHOT_READY

SELECT pg_sleep(5);

SELECT public."acquire_delivery_url_claim_fence"(
  'https://metrics-rehearsal.invalid/rehearsal-article'
);

COMMIT;
