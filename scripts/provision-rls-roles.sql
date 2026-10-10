-- Bootstrap the non-production role topology for the staged RLS rollout.
--
-- Run only through psql as a trusted database administrator on an approved
-- local or staging clone. Neon uses the project owner: final role attributes
-- are verified rather than altered, and the public schema is transferred to
-- the schema owner so its ACL/default-privilege reconciliation remains valid.
-- See docs/RLS_ROLLOUT.md before using this file.
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

SELECT CASE WHEN rolsuper THEN 'true' ELSE 'false' END AS is_superuser FROM pg_roles WHERE rolname = current_user \gset

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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_auth_group') THEN
    CREATE ROLE guestpost_auth_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_auth_runtime') THEN
    CREATE ROLE guestpost_auth_runtime NOLOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_worker_runtime') THEN
    CREATE ROLE guestpost_worker_runtime NOLOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_reporting_runtime') THEN
    CREATE ROLE guestpost_reporting_runtime NOLOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_rls_authorizer') THEN
    CREATE ROLE guestpost_rls_authorizer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_financial_repair_guard') THEN
    CREATE ROLE guestpost_financial_repair_guard NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_financial_repair_staging') THEN
    CREATE ROLE guestpost_financial_repair_staging NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END
$roles$;

-- Disable credential use before reconciling any role that predated this
-- rollout. Credential activation is a separate controlled change after this
-- transaction commits and authentication is configured.
\if :is_superuser
ALTER ROLE guestpost_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE guestpost_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE guestpost_auth_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE guestpost_worker_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE guestpost_reporting_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;

-- Make the remaining safe attributes idempotent too.
ALTER ROLE guestpost_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE guestpost_api_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE guestpost_auth_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE guestpost_worker_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE guestpost_reporting_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE guestpost_rls_authorizer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE guestpost_financial_repair_guard NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE guestpost_financial_repair_staging NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

ALTER ROLE guestpost_migrator SET search_path = pg_catalog, public;
ALTER ROLE guestpost_api_runtime SET search_path = pg_catalog, public;
ALTER ROLE guestpost_auth_runtime SET search_path = pg_catalog, public;
ALTER ROLE guestpost_worker_runtime SET search_path = pg_catalog, public;
ALTER ROLE guestpost_reporting_runtime SET search_path = pg_catalog, public;
\else
  DO $verify_neon_roles$
  BEGIN
    IF (SELECT count(*) FROM pg_roles WHERE rolname IN (
      'guestpost_schema_owner', 'guestpost_migrator',
      'guestpost_api_group', 'guestpost_auth_group',
      'guestpost_worker_group', 'guestpost_reporting_group',
      'guestpost_api_runtime', 'guestpost_auth_runtime',
      'guestpost_worker_runtime', 'guestpost_reporting_runtime',
      'guestpost_rls_authorizer', 'guestpost_financial_repair_guard',
      'guestpost_financial_repair_staging'
    )) <> 13 THEN
      RAISE EXCEPTION 'Neon role topology is incomplete';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_roles
      WHERE rolname IN (
        'guestpost_schema_owner', 'guestpost_migrator',
        'guestpost_api_group', 'guestpost_auth_group',
        'guestpost_worker_group', 'guestpost_reporting_group',
        'guestpost_api_runtime', 'guestpost_auth_runtime',
        'guestpost_worker_runtime', 'guestpost_reporting_runtime',
        'guestpost_rls_authorizer', 'guestpost_financial_repair_guard',
        'guestpost_financial_repair_staging'
      )
        AND (rolsuper OR rolcanlogin OR rolcreatedb OR rolcreaterole
          OR rolreplication OR rolbypassrls)
    ) THEN
      RAISE EXCEPTION 'Neon managed roles must be created NOLOGIN and without privileged attributes';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_roles
      WHERE (rolname IN ('guestpost_migrator', 'guestpost_rls_authorizer',
          'guestpost_financial_repair_guard', 'guestpost_financial_repair_staging')
        AND rolinherit)
        OR (rolname IN ('guestpost_api_runtime', 'guestpost_auth_runtime',
          'guestpost_worker_runtime', 'guestpost_reporting_runtime')
        AND NOT rolinherit)
    ) THEN
      RAISE EXCEPTION 'Neon managed roles have an unexpected INHERIT attribute';
    END IF;
  END
  $verify_neon_roles$;
\endif

-- Reconcile the application membership topology. Neon and PostgreSQL 16+
-- preserve a creator's admin-only, non-inheriting, non-settable self-grant;
-- keep that provider/engine edge separate from the seven application edges.
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
    WHERE (granted_role.rolname IN (
      'guestpost_schema_owner',
      'guestpost_migrator',
      'guestpost_api_group',
      'guestpost_api_runtime',
      'guestpost_auth_group',
      'guestpost_auth_runtime',
      'guestpost_worker_group',
      'guestpost_worker_runtime',
      'guestpost_reporting_group',
      'guestpost_reporting_runtime',
      'guestpost_rls_authorizer',
      'guestpost_financial_repair_guard',
      'guestpost_financial_repair_staging'
    )
    OR member_role.rolname IN (
      'guestpost_schema_owner',
      'guestpost_migrator',
      'guestpost_api_group',
      'guestpost_api_runtime',
      'guestpost_auth_group',
      'guestpost_auth_runtime',
      'guestpost_worker_group',
      'guestpost_worker_runtime',
      'guestpost_reporting_group',
      'guestpost_reporting_runtime',
      'guestpost_rls_authorizer',
      'guestpost_financial_repair_guard',
      'guestpost_financial_repair_staging'
    ))
    AND NOT (
      member_role.rolname = current_user
      AND auth_membership.admin_option
      AND NOT auth_membership.inherit_option
      AND NOT auth_membership.set_option
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
\if :is_superuser
ALTER ROLE guestpost_migrator RESET role;
ALTER ROLE guestpost_api_runtime RESET role;
ALTER ROLE guestpost_auth_runtime RESET role;
ALTER ROLE guestpost_worker_runtime RESET role;
ALTER ROLE guestpost_reporting_runtime RESET role;
ALTER ROLE guestpost_migrator IN DATABASE :"database_name" RESET role;
ALTER ROLE guestpost_api_runtime IN DATABASE :"database_name" RESET role;
ALTER ROLE guestpost_auth_runtime IN DATABASE :"database_name" RESET role;
ALTER ROLE guestpost_worker_runtime IN DATABASE :"database_name" RESET role;
ALTER ROLE guestpost_reporting_runtime IN DATABASE :"database_name" RESET role;
-- Reconciliation's single-actor staging exception is explicitly database-
-- scoped and is disabled whenever the role topology is reprovisioned.
ALTER ROLE guestpost_api_runtime IN DATABASE :"database_name"
  RESET guestpost.financial_repair_single_actor;
ALTER ROLE guestpost_api_runtime IN DATABASE :"database_name"
  RESET guestpost.financial_repair_single_actor;
ALTER ROLE guestpost_financial_repair_staging IN DATABASE :"database_name"
  RESET guestpost.financial_repair_single_actor;
\endif

GRANT guestpost_schema_owner TO guestpost_migrator WITH INHERIT FALSE, SET TRUE;
GRANT guestpost_api_group TO guestpost_api_runtime WITH INHERIT TRUE, SET FALSE;
GRANT guestpost_auth_group TO guestpost_auth_runtime WITH INHERIT TRUE, SET FALSE;
GRANT guestpost_worker_group TO guestpost_worker_runtime WITH INHERIT TRUE, SET FALSE;
GRANT guestpost_reporting_group TO guestpost_reporting_runtime WITH INHERIT TRUE, SET FALSE;
GRANT guestpost_financial_repair_staging TO guestpost_api_runtime
  WITH INHERIT FALSE, SET FALSE;
-- Only the trusted schema owner may SET ROLE to this NOLOGIN, NO-BYPASSRLS
-- owner used by tightly scoped financial-repair row-lock trigger functions.
-- No API, worker, auth, reporting, or credential runtime role is a member.
GRANT guestpost_financial_repair_guard TO guestpost_schema_owner
  WITH INHERIT FALSE, SET TRUE;

\if :is_superuser
ALTER ROLE guestpost_migrator IN DATABASE :"database_name"
  SET role TO 'guestpost_schema_owner';
\endif

-- Do not leave access to a newly provisioned database to implicit PUBLIC
-- privileges. Existing application roles must be explicitly reviewed before
-- this is used against a shared environment.
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
REVOKE ALL ON DATABASE :"database_name" FROM
  guestpost_schema_owner,
  guestpost_api_group,
  guestpost_auth_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_auth_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime,
  guestpost_rls_authorizer,
  guestpost_financial_repair_guard,
  guestpost_financial_repair_staging;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_migrator;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_api_runtime;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_auth_runtime;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_worker_runtime;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_reporting_runtime;

\if :is_superuser
  ALTER SCHEMA public OWNER TO guestpost_schema_owner;
  SET ROLE guestpost_schema_owner;
\else
  DO $temporary_schema_owner_membership$
  BEGIN
    EXECUTE format(
      'GRANT guestpost_schema_owner TO %I WITH INHERIT FALSE, SET TRUE',
      current_user
    );
  END
  $temporary_schema_owner_membership$;
  ALTER SCHEMA public OWNER TO guestpost_schema_owner;
  SET ROLE guestpost_schema_owner;
\endif

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM
  guestpost_api_group,
  guestpost_auth_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_auth_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime,
  guestpost_rls_authorizer,
  guestpost_financial_repair_guard,
  guestpost_financial_repair_staging;
GRANT USAGE, CREATE ON SCHEMA public TO guestpost_schema_owner;
GRANT USAGE ON SCHEMA public TO guestpost_api_group;
GRANT USAGE ON SCHEMA public TO guestpost_auth_group;
GRANT USAGE ON SCHEMA public TO guestpost_worker_group;
GRANT USAGE ON SCHEMA public TO guestpost_reporting_group;

-- Prisma owns its migration ledger outside the application RLS boundary.
-- Leave its ACL with that owner; the schema owner deliberately does not own
-- _prisma_migrations, so a blanket ON ALL TABLES revoke breaks reruns.
DO $revoke_application_table_privileges$
DECLARE
  relation_row record;
BEGIN
  FOR relation_row IN
    SELECT namespace.nspname, relation.relname
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND relation.relname <> '_prisma_migrations'
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC, guestpost_api_group, guestpost_auth_group, guestpost_worker_group, guestpost_reporting_group, guestpost_migrator, guestpost_api_runtime, guestpost_auth_runtime, guestpost_worker_runtime, guestpost_reporting_runtime, guestpost_rls_authorizer, guestpost_financial_repair_guard, guestpost_financial_repair_staging',
      relation_row.nspname,
      relation_row.relname
    );
  END LOOP;
END
$revoke_application_table_privileges$;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM
  guestpost_api_group,
  guestpost_auth_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_auth_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime,
  guestpost_rls_authorizer,
  guestpost_financial_repair_guard,
  guestpost_financial_repair_staging;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM
  guestpost_api_group,
  guestpost_auth_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_auth_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime,
  guestpost_rls_authorizer,
  guestpost_financial_repair_guard,
  guestpost_financial_repair_staging;

-- The API and worker need relation-level DML for the reviewed 105-model graph;
-- FORCE RLS and the command-aware policy matrix decide which rows each
-- workload may actually read or change. These grants confer no DDL, role,
-- replication, superuser, or RLS-bypass ability. Default privileges below
-- remain empty so a future relation fails closed until its ACL, policy root,
-- manifest entry, activation count, and tests are reviewed together.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO guestpost_api_group;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO guestpost_worker_group;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO guestpost_api_group;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO guestpost_worker_group;

-- A post-activation rerun must preserve the SECURITY DEFINER authorizer's
-- ability to read policy roots. This role is NOLOGIN, NOINHERIT, has no
-- memberships, and receives no mutation privilege.
GRANT USAGE ON SCHEMA public TO guestpost_rls_authorizer;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO guestpost_rls_authorizer;

-- Preserve the repair guard's object-specific ACLs on a post-migration rerun.
-- Initial provisioning runs before the repair tables exist, so this block is
-- intentionally conditional and never grants broad table access.
DO $financial_repair_guard_grants$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_financial_repair_guard'
  ) AND to_regclass('public."ReconciliationRepairProposal"') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA public, guestpost_rls
      TO guestpost_financial_repair_guard;
    GRANT SELECT ON public."ReconciliationCase", public."Order",
      public."Transaction", public."Wallet", public."PublisherCompensation",
      public."Website", public."Settlement", public."OrderEvent",
      public."PaymentDispute", public."OrderDispute",
      public."DeliveryFraudFinding", public."ReconciliationCaseSnapshot",
      public."ReconciliationRepairProposal", public."ReconciliationRepairApproval",
      public."ReconciliationRepairExecution"
      TO guestpost_financial_repair_guard;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA guestpost_rls
      TO guestpost_financial_repair_guard;
    GRANT UPDATE ("version") ON public."ReconciliationCase",
      public."Order", public."Wallet" TO guestpost_financial_repair_guard;
    GRANT UPDATE ("description") ON public."Transaction"
      TO guestpost_financial_repair_guard;
    GRANT UPDATE ("createdAt") ON public."PublisherCompensation",
      public."ReconciliationRepairProposal", public."ReconciliationRepairApproval",
      public."ReconciliationRepairExecution" TO guestpost_financial_repair_guard;
  END IF;
END
$financial_repair_guard_grants$;

-- Better Auth is isolated from the API runtime. It owns session/account flows
-- and the atomic birth-time provisioning transaction, but no marketplace,
-- order, payout, or reporting tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public."User",
  public."LegalAcceptance",
  public."Session",
  public."Account",
  public."Verification",
  public."ActiveContext",
  public."Organization",
  public."Membership",
  public."PublisherMembership",
  public."Publisher",
  public."PublisherBalance",
  public."Wallet",
  public."AuditLog"
TO guestpost_auth_group;

-- The delivery verification worker and API delivery flows call this
-- SECURITY INVOKER fence directly. Functions were revoked from PUBLIC above,
-- so retain only this audited runtime surface for the two callers.
DO $delivery_fence_grant$
BEGIN
  IF to_regprocedure('public.acquire_delivery_url_claim_fence(text)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public."acquire_delivery_url_claim_fence"(text)
      TO guestpost_api_group, guestpost_worker_group;
  END IF;
END
$delivery_fence_grant$;

-- Reporting starts fail-closed: connect + schema usage but no table, sequence,
-- or function privileges. Add an approved view/query grant per report.

-- Do not let new relations/functions silently recreate PUBLIC access. Every
-- relation-creating migration must carry its reviewed, object-specific API,
-- worker, and authorizer grants; see the required checklist in RLS_ROLLOUT.md.
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON TABLES FROM
  guestpost_api_group,
  guestpost_auth_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_auth_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime,
  guestpost_rls_authorizer,
  guestpost_financial_repair_guard;
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM
  guestpost_api_group,
  guestpost_auth_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_auth_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime,
  guestpost_rls_authorizer,
  guestpost_financial_repair_guard;
ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM
  guestpost_api_group,
  guestpost_auth_group,
  guestpost_worker_group,
  guestpost_reporting_group,
  guestpost_migrator,
  guestpost_api_runtime,
  guestpost_auth_runtime,
  guestpost_worker_runtime,
  guestpost_reporting_runtime,
  guestpost_rls_authorizer,
  guestpost_financial_repair_guard;

RESET ROLE;

\if :is_superuser
\else
  DO $remove_temporary_schema_owner_membership$
  BEGIN
    EXECUTE format('REVOKE guestpost_schema_owner FROM %I', session_user);
  END
  $remove_temporary_schema_owner_membership$;
\endif

COMMIT;

-- Existing passwords are preserved, but every credential role remains
-- NOLOGIN. Enable LOGIN only in a separate approved change after passwords or
-- certificate mappings and host authentication rules have been configured.
