-- Create an isolated one-use LOGIN for Prisma Migrate on Neon. The role is
-- dropped immediately after migrations because Neon does not allow ALTER ROLE
-- to disable its login afterward. See docs/COOLIFY_STAGING_RUNBOOK.md.

\set ON_ERROR_STOP on

\if :{?database_name}
\else
  \echo 'database_name is required'
  \quit 3
\endif
\if :{?migrator_password}
\else
  \echo 'migrator_password is required'
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

BEGIN;

DO $schema_owner_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_schema_owner'
  ) THEN
    CREATE ROLE guestpost_schema_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'guestpost_schema_owner'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
        OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'guestpost_schema_owner has unsafe attributes';
  END IF;
END
$schema_owner_role$;

DO $temporary_migrator_role$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_migrator_login'
  ) THEN
    RAISE EXCEPTION 'guestpost_migrator_login already exists; inspect before retrying';
  END IF;
END
$temporary_migrator_role$;

CREATE ROLE guestpost_migrator_login
  LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT CONNECT ON DATABASE :"database_name" TO guestpost_migrator_login;
GRANT CREATE ON DATABASE :"database_name" TO guestpost_schema_owner;
GRANT USAGE, CREATE ON SCHEMA public TO guestpost_schema_owner;
DO $temporary_owner_membership$
BEGIN
  EXECUTE format(
    'GRANT guestpost_schema_owner TO %I WITH INHERIT FALSE, SET TRUE',
    current_user
  );
END
$temporary_owner_membership$;
ALTER SCHEMA public OWNER TO guestpost_schema_owner;
GRANT guestpost_schema_owner TO guestpost_migrator_login
  WITH INHERIT FALSE, SET TRUE;
GRANT guestpost_financial_repair_guard TO guestpost_schema_owner
  WITH INHERIT FALSE, SET TRUE;

COMMIT;
