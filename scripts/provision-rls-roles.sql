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

\set QUIET on
SELECT current_database() = :'database_name' AS target_database_matches \gset
\set QUIET off
\if :target_database_matches
\else
  \echo 'connected database does not match database_name'
  \quit 3
\endif

-- PostgreSQL role and ACL changes are transactional. Keep the complete
-- reconciliation atomic so ON_ERROR_STOP causes an implicit rollback on any
-- failure rather than committing a partially updated security boundary.
BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_schema_owner') THEN
    CREATE ROLE guestpost_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_migrator') THEN
    CREATE ROLE guestpost_migrator NOLOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
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
    CREATE ROLE guestpost_api_runtime NOLOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_worker_runtime') THEN
    CREATE ROLE guestpost_worker_runtime NOLOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_reporting_runtime') THEN
    CREATE ROLE guestpost_reporting_runtime NOLOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
END
$roles$;

-- Disable credential use before reconciling any role that predated this
-- rollout. Credential activation is a separate controlled change after this
-- transaction commits and authentication is configured.
ALTER ROLE guestpost_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE guestpost_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE guestpost_worker_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE guestpost_reporting_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;

-- Make the remaining safe attributes idempotent too.
ALTER ROLE guestpost_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE guestpost_api_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE guestpost_worker_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE guestpost_reporting_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

ALTER ROLE guestpost_migrator SET search_path = pg_catalog, public;
ALTER ROLE guestpost_api_runtime SET search_path = pg_catalog, public;
ALTER ROLE guestpost_worker_runtime SET search_path = pg_catalog, public;
ALTER ROLE guestpost_reporting_runtime SET search_path = pg_catalog, public;

-- This recipe owns the complete membership topology for its managed roles.
-- Remove both direct and transitive surprises left by an earlier/manual setup,
-- then recreate only the four reviewed edges below. This is safe to rerun.
DO $memberships$
DECLARE
  membership_row record;
BEGIN
  FOR membership_row IN
    SELECT
      granted_role.rolname AS granted_role_name,
      member_role.rolname AS member_role_name
    FROM pg_auth_members AS auth_membership
    JOIN pg_roles AS granted_role ON granted_role.oid = auth_membership.roleid
    JOIN pg_roles AS member_role ON member_role.oid = auth_membership.member
    WHERE granted_role.rolname IN (
      'guestpost_schema_owner',
      'guestpost_migrator',
      'guestpost_api_group',
      'guestpost_api_runtime',
      'guestpost_worker_group',
      'guestpost_worker_runtime',
      'guestpost_reporting_group',
      'guestpost_reporting_runtime'
    )
    OR member_role.rolname IN (
      'guestpost_schema_owner',
      'guestpost_migrator',
      'guestpost_api_group',
      'guestpost_api_runtime',
      'guestpost_worker_group',
      'guestpost_worker_runtime',
      'guestpost_reporting_group',
      'guestpost_reporting_runtime'
    )
  LOOP
    EXECUTE format(
      'REVOKE %I FROM %I',
      membership_row.granted_role_name,
      membership_row.member_role_name
    );
  END LOOP;
END
$memberships$;

-- Remove connection-time role defaults that could survive from an earlier
-- setup. Runtime sessions stay on their login identities. Migrator sessions
-- switch to the schema owner automatically for this database only, including
-- every separate connection opened by Prisma Migrate.
ALTER ROLE guestpost_migrator RESET role;
ALTER ROLE guestpost_api_runtime RESET role;
ALTER ROLE guestpost_worker_runtime RESET role;
ALTER ROLE guestpost_reporting_runtime RESET role;
ALTER ROLE guestpost_migrator IN DATABASE :"database_name" RESET role;
ALTER ROLE guestpost_api_runtime IN DATABASE :"database_name" RESET role;
ALTER ROLE guestpost_worker_runtime IN DATABASE :"database_name" RESET role;
ALTER ROLE guestpost_reporting_runtime IN DATABASE :"database_name" RESET role;

GRANT guestpost_schema_owner TO guestpost_migrator WITH INHERIT FALSE, SET TRUE;
GRANT guestpost_api_group TO guestpost_api_runtime WITH INHERIT TRUE, SET FALSE;
GRANT guestpost_worker_group TO guestpost_worker_runtime WITH INHERIT TRUE, SET FALSE;
GRANT guestpost_reporting_group TO guestpost_reporting_runtime WITH INHERIT TRUE, SET FALSE;

ALTER ROLE guestpost_migrator IN DATABASE :"database_name"
  SET role TO 'guestpost_schema_owner';

-- Do not leave access to a newly provisioned database to implicit PUBLIC
-- privileges. Existing application roles must be explicitly reviewed before
-- this is used against a shared environment.
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
REVOKE ALL ON DATABASE :"database_name" FROM
  guestpost_schema_owner,
  guestpost_api_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_migrator;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_api_runtime;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_worker_runtime;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_reporting_runtime;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM
  guestpost_api_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO guestpost_schema_owner;
GRANT USAGE ON SCHEMA public TO guestpost_api_group;
GRANT USAGE ON SCHEMA public TO guestpost_worker_group;
GRANT USAGE ON SCHEMA public TO guestpost_reporting_group;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM
  guestpost_api_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM
  guestpost_api_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM
  guestpost_api_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime;

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

-- Do not let new relations/functions silently recreate PUBLIC access. Every
-- relation-creating migration must carry its reviewed, object-specific API and
-- worker table/sequence grants; see the required checklist in RLS_ROLLOUT.md.
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON TABLES FROM
  guestpost_api_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM
  guestpost_api_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM
  guestpost_api_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime;

COMMIT;

-- Existing passwords are preserved, but every credential role remains
-- NOLOGIN. Enable LOGIN only in a separate approved change after passwords or
-- certificate mappings and host authentication rules have been configured.
