-- Disable the database-local single-account reconciliation test capability.
-- Run as a trusted database administrator against the named staging database.
-- This does not execute or reverse any customer repair.

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
SELECT current_database() = :'database_name' AS target_database_matches \gset
SELECT current_database() !~* '(prod|production)' AS database_not_production \gset
\set QUIET off
\if :staging_ack_matches
\else
  \echo 'refusing: staging_ack must equal STAGING_ONLY'
  \quit 3
\endif
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

ALTER ROLE guestpost_api_runtime IN DATABASE :"database_name"
  RESET guestpost.financial_repair_single_actor;
ALTER ROLE guestpost_financial_repair_staging IN DATABASE :"database_name"
  RESET guestpost.financial_repair_single_actor;

SELECT NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting AS setting
    JOIN pg_catalog.pg_roles AS configured_role ON configured_role.oid = setting.setrole
    WHERE setting.setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
      AND configured_role.rolname IN ('guestpost_api_runtime', 'guestpost_financial_repair_staging')
      AND 'guestpost.financial_repair_single_actor=on' = ANY(setting.setconfig)
  ) AS staging_single_actor_disabled \gset
\if :staging_single_actor_disabled
  SELECT current_database() AS confirmed_database,
    :'staging_single_actor_disabled'::boolean AS staging_single_actor_disabled;
\else
  \echo 'error: database-local single-actor capability is still enabled'
  \quit 3
\endif
