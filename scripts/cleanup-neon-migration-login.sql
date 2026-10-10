-- Remove the one-use Neon migration login after ownership and migration
-- status have been verified. DROP ROLE fails if the identity owns any objects.

\set ON_ERROR_STOP on

\if :{?database_name}
\else
  \echo 'database_name is required'
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
REVOKE CREATE ON DATABASE :"database_name" FROM guestpost_schema_owner;
REVOKE guestpost_schema_owner FROM guestpost_migrator_login;
REVOKE CONNECT ON DATABASE :"database_name" FROM guestpost_migrator_login;
DROP ROLE guestpost_migrator_login;
COMMIT;
