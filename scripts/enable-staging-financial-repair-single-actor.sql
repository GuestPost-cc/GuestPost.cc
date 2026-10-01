-- Enable the one-account repair test mode for this database only. PostgreSQL
-- role settings scoped IN DATABASE do not enable this capability in other
-- databases on the same cluster. Run only against a confirmed staging DB.
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

DO $enable_staging_repair$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'guestpost_api_runtime') THEN
    RAISE EXCEPTION 'required API runtime role is missing';
  END IF;
END
$enable_staging_repair$;

ALTER ROLE guestpost_api_runtime IN DATABASE :"database_name"
  SET guestpost.financial_repair_single_actor = 'on';

SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting AS setting
    JOIN pg_catalog.pg_roles AS configured_role ON configured_role.oid = setting.setrole
    WHERE setting.setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
      AND configured_role.rolname = 'guestpost_api_runtime'
      AND 'guestpost.financial_repair_single_actor=on' = ANY(setting.setconfig)
  ) AS staging_single_actor_enabled \gset
\if :staging_single_actor_enabled
  SELECT current_database() AS confirmed_database,
    :'staging_single_actor_enabled'::boolean AS staging_single_actor_enabled;
\else
  \echo 'refusing: database-local single-actor capability was not enabled'
  \quit 3
\endif
