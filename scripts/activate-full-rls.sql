-- Atomically activate the preinstalled 99-model RLS boundary.
--
-- This is intentionally not a Prisma migration: deployment installs policies
-- first, rolls out context-aware code and separate NOLOGIN identities, runs
-- clone/staging smoke tests, and only then performs this explicit change.
--
-- Example (approved clone/staging only):
--   psql "$ADMIN_DATABASE_URL" -v database_name=guestpost -v activate=YES \
--     -f scripts/activate-full-rls.sql

\set ON_ERROR_STOP on

\if :{?database_name}
\else
  \echo 'database_name is required'
  \quit 3
\endif

\if :{?activate}
\else
  \echo 'activate=YES is required'
  \quit 3
\endif

\set QUIET on
SELECT current_database() = :'database_name' AS target_database_matches \gset
SELECT :'activate' = 'YES' AS activation_confirmed \gset
\set QUIET off

\if :target_database_matches
\else
  \echo 'connected database does not match database_name'
  \quit 3
\endif

\if :activation_confirmed
\else
  \echo 'activation confirmation must be exactly YES'
  \quit 3
\endif

BEGIN;

DO $preflight$
DECLARE
  model_count integer;
  covered_model_count integer;
  policy_count integer;
  bad_role_count integer;
  bad_owner_count integer;
BEGIN
  SELECT count(*) INTO model_count
  FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind = 'r'
    AND relation.relname <> '_prisma_migrations';

  IF model_count <> 99 THEN
    RAISE EXCEPTION 'expected exactly 99 application tables, found %', model_count;
  END IF;

  SELECT count(DISTINCT tablename), count(*)
    INTO covered_model_count, policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND policyname LIKE '%\_full\_boundary\_%' ESCAPE '\';

  IF covered_model_count <> 99 OR policy_count <> 396 THEN
    RAISE EXCEPTION
      'full-boundary policy coverage is incomplete: models %, policies %',
      covered_model_count, policy_count;
  END IF;

  SELECT count(*) INTO bad_role_count
  FROM pg_roles
  WHERE rolname IN (
    'guestpost_schema_owner', 'guestpost_migrator',
    'guestpost_api_group', 'guestpost_api_runtime',
    'guestpost_auth_group', 'guestpost_auth_runtime',
    'guestpost_worker_group', 'guestpost_worker_runtime',
    'guestpost_reporting_group', 'guestpost_reporting_runtime',
    'guestpost_rls_authorizer'
  )
  AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls);

  IF bad_role_count <> 0 THEN
    RAISE EXCEPTION 'managed role has a forbidden privileged attribute';
  END IF;

  IF (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'guestpost_%') < 11 THEN
    RAISE EXCEPTION 'managed role topology is incomplete';
  END IF;

  SELECT count(*) INTO bad_owner_count
  FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = relation.relowner
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'S')
    AND relation.relname <> '_prisma_migrations'
    AND owner_role.rolname <> 'guestpost_schema_owner';

  IF bad_owner_count <> 0 THEN
    RAISE EXCEPTION '% application tables/sequences are not owned by guestpost_schema_owner',
      bad_owner_count;
  END IF;
END
$preflight$;

-- The authorizer is NOLOGIN, has no memberships and has no BYPASSRLS. Its
-- SECURITY DEFINER functions expose booleans only; the SELECT policy branch
-- for this exact role lets those functions inspect policy roots without RLS
-- recursion. Runtime identities cannot SET ROLE to it.
GRANT USAGE ON SCHEMA public, guestpost_rls TO guestpost_rls_authorizer;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO guestpost_rls_authorizer;

DO $function_owners$
DECLARE
  function_row record;
BEGIN
  FOR function_row IN
    SELECT procedure.oid::regprocedure AS identity
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'guestpost_rls'
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s OWNER TO guestpost_rls_authorizer',
      function_row.identity
    );
  END LOOP;
END
$function_owners$;

REVOKE ALL ON SCHEMA guestpost_rls FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA guestpost_rls FROM PUBLIC;
GRANT USAGE ON SCHEMA guestpost_rls
  TO guestpost_api_group, guestpost_auth_group, guestpost_worker_group;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA guestpost_rls
  TO guestpost_api_group, guestpost_auth_group, guestpost_worker_group;

DO $activate$
DECLARE
  table_name text;
BEGIN
  FOR table_name IN
    SELECT relation.relname
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind = 'r'
      AND relation.relname <> '_prisma_migrations'
    ORDER BY relation.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$activate$;

-- Recheck inside the same transaction. Any mismatch rolls back function
-- ownership, grants, and every ENABLE/FORCE change together.
DO $postflight$
DECLARE
  incomplete integer;
BEGIN
  SELECT count(*) INTO incomplete
  FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind = 'r'
    AND relation.relname <> '_prisma_migrations'
    AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity);

  IF incomplete <> 0 THEN
    RAISE EXCEPTION '% application tables are not ENABLE+FORCE RLS', incomplete;
  END IF;
END
$postflight$;

COMMIT;
