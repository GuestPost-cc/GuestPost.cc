-- Establish a SERIALIZABLE snapshot before another connection advances the
-- URL fence. The harness keeps this psql session open through a FIFO, runs the
-- writer to completion, and then streams the release fixture into this same
-- transaction.

\set ON_ERROR_STOP on
\set VERBOSITY verbose

BEGIN ISOLATION LEVEL SERIALIZABLE;

SELECT count(*)
FROM public."OrderDeliveryVersion"
WHERE "normalizedUrl" =
  'https://metrics-rehearsal.invalid/rehearsal-article';

\echo SERIALIZABLE_SNAPSHOT_READY
