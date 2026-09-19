-- Incident-only rollback for a verified application lockout.
--
-- This preserves the Phase 1 ApiKey boundary and disables the later 98-table
-- activation atomically. It does not alter roles, credentials, grants,
-- policies, or ownership, so the boundary can be re-enabled after repair.

\set ON_ERROR_STOP on

\if :{?database_name}
\else
  \echo 'database_name is required'
  \quit 3
\endif

\if :{?disable}
\else
  \echo 'disable=EMERGENCY is required'
  \quit 3
\endif

\set QUIET on
SELECT current_database() = :'database_name' AS target_database_matches \gset
SELECT :'disable' = 'EMERGENCY' AS disable_confirmed \gset
\set QUIET off

\if :target_database_matches
\else
  \echo 'connected database does not match database_name'
  \quit 3
\endif

\if :disable_confirmed
\else
  \echo 'disable confirmation must be exactly EMERGENCY'
  \quit 3
\endif

BEGIN;
DO $disable$
DECLARE
  table_name text;
BEGIN
  FOR table_name IN
    SELECT relation.relname
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind = 'r'
      AND relation.relname NOT IN ('_prisma_migrations', 'ApiKey')
  LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$disable$;
COMMIT;
