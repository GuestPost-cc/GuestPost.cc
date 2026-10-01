-- Enable the one-account repair test mode on a dedicated staging PostgreSQL
-- cluster only. PostgreSQL role membership is cluster-wide, not database-
-- scoped, so never run this against a cluster shared with production.
-- Run as a trusted database administrator after provision-rls-roles.sql.
-- Example:
--   psql "$ADMIN_DATABASE_URL" -v database_name=guestpost_staging \
--     -v staging_ack=STAGING_ONLY -f scripts/enable-staging-financial-repair-single-actor.sql

\set ON_ERROR_STOP on

\if :{?database_name}
\else
  \echo 'database_name is required'
  \quit 3
\endif
\if :{?staging_ack}
\else
  \echo 'staging_ack=STAGING_ONLY is required'
  \quit 3
\endif
\set QUIET on
SELECT :'staging_ack' = 'STAGING_ONLY' AS staging_ack_matches \gset
\set QUIET off
\if :staging_ack_matches
\else
  \echo 'refusing: staging_ack must equal STAGING_ONLY'
  \quit 3
\endif

\set QUIET on
SELECT current_database() = :'database_name' AS target_database_matches \gset
SELECT current_database() !~* '(prod|production)' AS database_not_production \gset
\set QUIET off
\if :target_database_matches
\else
  \echo 'refusing: connected database does not match database_name'
  \quit 3
\endif
\if :database_not_production
\else
  \echo 'refusing: database name resembles production'
  \quit 3
\endif

BEGIN;
DO $enable_staging_repair$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'guestpost_api_runtime')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'guestpost_financial_repair_staging') THEN
    RAISE EXCEPTION 'required runtime or staging capability role is missing';
  END IF;
  IF pg_catalog.pg_has_role('guestpost_api_runtime', 'guestpost_financial_repair_staging', 'MEMBER') THEN
    RAISE NOTICE 'staging repair capability membership already enabled';
  ELSE
    EXECUTE 'GRANT guestpost_financial_repair_staging TO guestpost_api_runtime WITH INHERIT TRUE, SET FALSE';
  END IF;
END
$enable_staging_repair$;
COMMIT;

SELECT current_database() AS confirmed_database,
  pg_catalog.pg_has_role('guestpost_api_runtime', 'guestpost_financial_repair_staging', 'MEMBER') AS staging_single_actor_enabled;
