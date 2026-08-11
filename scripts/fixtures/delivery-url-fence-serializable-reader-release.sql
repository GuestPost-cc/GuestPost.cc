-- Continue the already-open SERIALIZABLE reader only after the concurrent
-- writer commits. ON_ERROR_STOP makes SQLSTATE 40001 terminate psql; a COMMIT
-- here would therefore be unreachable and could obscure the expected failure.

\set ON_ERROR_STOP on
\set VERBOSITY verbose

SELECT public."acquire_delivery_url_claim_fence"(
  'https://metrics-rehearsal.invalid/rehearsal-article'
);
