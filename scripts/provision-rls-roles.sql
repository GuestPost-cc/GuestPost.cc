-- Bootstrap the non-production role topology for the staged RLS rollout.
--
-- Run only through psql as a cluster administrator on an approved local or
-- staging clone. It deliberately contains no password values and does not
-- transfer ownership of an existing database: both actions require a separate
-- controlled change. See docs/RLS_ROLLOUT.md before using this file.
--
-- Example:
--   psql "$ADMIN_DATABASE_URL" -v database_name=guestpost -f scripts/provision-rls-roles.sql

\set ON_ERROR_STOP on

\if :{?database_name}
\else
  \echo 'database_name is required (for example: -v database_name=guestpost)'
  \quit 3
\endif

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_schema_owner') THEN
    CREATE ROLE guestpost_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_migrator') THEN
    CREATE ROLE guestpost_migrator LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_api_group') THEN
    CREATE ROLE guestpost_api_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_worker_group') THEN
    CREATE ROLE guestpost_worker_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_reporting_group') THEN
    CREATE ROLE guestpost_reporting_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_api_runtime') THEN
    CREATE ROLE guestpost_api_runtime LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_worker_runtime') THEN
    CREATE ROLE guestpost_worker_runtime LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_reporting_runtime') THEN
    CREATE ROLE guestpost_reporting_runtime LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
END
$roles$;

-- Make the safe attributes idempotent even if a role predated this rollout.
ALTER ROLE guestpost_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE guestpost_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE guestpost_api_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE guestpost_worker_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE guestpost_reporting_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE guestpost_api_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE guestpost_worker_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE guestpost_reporting_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;

ALTER ROLE guestpost_migrator SET search_path = pg_catalog, public;
ALTER ROLE guestpost_api_runtime SET search_path = pg_catalog, public;
ALTER ROLE guestpost_worker_runtime SET search_path = pg_catalog, public;
ALTER ROLE guestpost_reporting_runtime SET search_path = pg_catalog, public;

GRANT guestpost_schema_owner TO guestpost_migrator;
GRANT guestpost_api_group TO guestpost_api_runtime;
GRANT guestpost_worker_group TO guestpost_worker_runtime;
GRANT guestpost_reporting_group TO guestpost_reporting_runtime;

-- Do not leave access to a newly provisioned database to implicit PUBLIC
-- privileges. Existing application roles must be explicitly reviewed before
-- this is used against a shared environment.
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_migrator;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_api_runtime;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_worker_runtime;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_reporting_runtime;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM guestpost_api_group;
REVOKE CREATE ON SCHEMA public FROM guestpost_worker_group;
REVOKE CREATE ON SCHEMA public FROM guestpost_reporting_group;
GRANT USAGE ON SCHEMA public TO guestpost_api_group;
GRANT USAGE ON SCHEMA public TO guestpost_worker_group;
GRANT USAGE ON SCHEMA public TO guestpost_reporting_group;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- Compatibility baseline for the existing API/worker graph. The inventory
-- currently contains 99 Prisma models and over 2,000 call sites, including
-- Better Auth's pre-authorization reads. It receives normal DML but no DDL,
-- role, replication, superuser, or RLS-bypass ability. Each future RLS phase
-- must replace these broad relation grants with its documented table matrix.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO guestpost_api_group;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO guestpost_worker_group;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO guestpost_api_group;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO guestpost_worker_group;

-- The delivery verification worker and API delivery flows call this
-- SECURITY INVOKER fence directly. Functions were revoked from PUBLIC above,
-- so retain only this audited runtime surface for the two callers.
GRANT EXECUTE ON FUNCTION public."acquire_delivery_url_claim_fence"(text)
  TO guestpost_api_group, guestpost_worker_group;

-- Reporting starts fail-closed: connect + schema usage but no table, sequence,
-- or function privileges. Add an approved view/query grant per report.

-- Do not let new relations/functions silently recreate PUBLIC access. New
-- application grants are an explicit migration-review responsibility.
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
