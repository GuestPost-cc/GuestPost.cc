# Row-level security rollout

## Status

This is a staged security boundary, not a claim that all application data has
row-level security.

Phase 1 protects `ApiKey` with `ENABLE ROW LEVEL SECURITY` and `FORCE ROW
LEVEL SECURITY`. An active customer owner can CRUD only keys for the active
organization. The opaque key-authentication path can read and update only the
one row that matches the presented key hash. There is no staff, worker,
reporting, owner, or `PUBLIC` policy bypass.

The API derives the values from the durable `CurrentAuthority` after session
validation and pins them to the same interactive Prisma transaction using
`set_config(..., true)`. PostgreSQL clears those values at commit or rollback,
so a pooled connection cannot retain a prior request's context. The policy also
checks the live `Membership` and `User` records, so a deactivated or demoted
customer owner loses access even if the request began before that change.

The remaining 98 Prisma models are deliberately outside this first RLS phase.
They continue to rely on their existing API guards and service-level ownership
checks. Do not describe the platform as fully RLS-isolated until each listed
table has a documented policy, context producer, non-owner test, and rollout
decision.

## Role topology

`scripts/provision-rls-roles.sql` is a reviewed bootstrap recipe for an
approved local or staging clone. It creates:

| Role | Attributes | Purpose |
| --- | --- | --- |
| `guestpost_schema_owner` | `NOLOGIN`, no superuser or bypass | Owns schema and migrations. |
| `guestpost_migrator` | bootstrap leaves `NOLOGIN`, `NOINHERIT`, no superuser or bypass | Sets role to the schema owner only for migration runs after controlled activation. |
| `guestpost_api_group` / `guestpost_api_runtime` | group is `NOLOGIN`; bootstrap leaves runtime `NOLOGIN`, with no DDL or bypass | API service connection after controlled activation. |
| `guestpost_worker_group` / `guestpost_worker_runtime` | group is `NOLOGIN`; bootstrap leaves runtime `NOLOGIN`, with no DDL or bypass | Queue/worker service connection after controlled activation. |
| `guestpost_reporting_group` / `guestpost_reporting_runtime` | both remain `NOLOGIN` until approved; no DDL or bypass | Fail-closed reporting identity. |

All roles are `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`,
and `NOBYPASSRLS`. Database access, schema usage, and relation permissions are
explicit; the recipe revokes implicit `PUBLIC` privileges on the target
database, schema, existing relations, sequences, and functions. It creates no
passwords. Put independent runtime credentials in the deployment secret store
and enforce them with TLS and database host authentication rules.

The API and worker group grants are a compatibility baseline while the
99-model/2,000+-operation permission inventory is being split. They provide
normal DML only—never schema ownership, role administration, superuser, or
RLS bypass. Reporting gets no table grants until a report-specific view/query
is approved. Every later phase must replace the broad DML baseline with a
table/column grant matrix; it must not add a role-wide RLS bypass.

The bootstrap recipe is authoritative for its eight managed roles: in one
transaction it disables the four credential roles, removes every existing
membership edge involving a managed role, restores only the four documented
edges, and reconciles direct and default ACLs. Credential roles remain
`NOLOGIN` afterward. Do not attach ad hoc memberships or direct grants to these
roles; rerunning the recipe will intentionally remove them.

The migrator membership is `INHERIT FALSE, SET TRUE`. The recipe persists a
database-scoped `role=guestpost_schema_owner` session default for
`guestpost_migrator`, so every connection opened by Prisma Migrate starts with
`session_user=guestpost_migrator` and `current_user=guestpost_schema_owner`.
Runtime memberships are `INHERIT TRUE, SET FALSE`, and any global or
target-database connection-time role defaults on runtime identities are reset.

## Required migration grant checklist

Default privileges deliberately grant nothing to application roles. Every
migration that creates a table or sequence must therefore include reviewed,
object-specific grants in that same migration before it can be merged:

- identify whether the API, worker, both, or neither may use each new object;
- grant only the required `SELECT`, `INSERT`, `UPDATE`, and `DELETE` table
  operations to `guestpost_api_group` and/or `guestpost_worker_group`;
- grant sequence `USAGE` and `SELECT` only when inserts use that sequence;
- add a migration contract test that names the object and exact grantees; and
- reject blanket application-role default privileges and `PUBLIC` access.

A migration that creates no table or sequence records that fact during review
and needs no synthetic grant. The Phase 1 `ApiKey` migration changes policies
on an existing table, so its compatibility grant comes from the reviewed
bootstrap inventory rather than a new-relation grant.

## Controlled rollout

1. On a disposable clone, inventory current ownership, privileges, `PUBLIC`
   grants, direct SQL functions, and every API/worker connection identity.
   Confirm the migration job, API, worker, reporting process, and local tests
   have separate connection strings. Do not run the bootstrap recipe against
   production as a discovery mechanism.
2. Execute the role recipe through a protected administrator connection with
   `-v database_name=<approved_clone>`. It commits the complete role/ACL graph
   atomically and leaves all credential roles `NOLOGIN`. Set distinct passwords
   or certificate mappings and the matching host authentication rules out of
   band. No application service receives the migrator or schema-owner secret.
3. Transfer schema/table ownership to `guestpost_schema_owner` using an
   explicit, reviewed ownership inventory. The migration job connects as
   `guestpost_migrator`; the database-scoped role default applied by the recipe
   makes each Prisma Migrate connection run as `guestpost_schema_owner`. Before
   deployment, connect with the migration URL and require
   `session_user = 'guestpost_migrator'` and
   `current_user = 'guestpost_schema_owner'`; abort on any mismatch. API and
   worker jobs never receive the migration URL.
4. After credentials, certificate mappings, host authentication, ownership,
   and catalog checks are approved, explicitly enable only the required
   credential roles in a separate administrator change. Then connect with each
   new identity and verify its `session_user`, `current_user`, role memberships,
   and denied operations before switching API or worker configuration. Revoke
   the former runtime identity's owner/DDL capabilities only after the new
   bootstrap/auth checks pass. Better Auth performs database reads before a
   request has a user or organization context, so the auth tables and the
   pre-auth path must be validated before tenant policies are enabled.
5. Apply the migration on the clone, validate the catalog queries below, run
   the cross-tenant integration test as a non-owner runtime role, and exercise
   API authentication, worker jobs, staff flows, and public catalog reads.
   Promote only through the normal staging/production change process.

No environment, hosted database, deployment, or credential is changed by this
repository change. The local `guestpost` development database is intentionally
not a target; the integration suite uses only `guestpost_test_template` and
disposable `test_*` clones.

## Policy contract

The API-key owner context contains only server-derived values:

```text
guestpost.rls_workload=API
guestpost.rls_actor_kind=CUSTOMER
guestpost.rls_actor_id=<durable User.id>
guestpost.rls_organization_id=<durable Organization.id>
guestpost.rls_organization_role=OWNER
```

`ApiKeysService` accepts `DurableCurrentAuthority`, not a client-supplied user
or organization ID. The service opens an interactive transaction, sets local
configuration, and performs the protected Prisma operation through that exact
transaction client. The opaque API-key validation path sets only a validated
SHA-256 key hash and cannot assume a staff, worker, or tenant identity.

Custom PostgreSQL settings are an application-to-database context channel, not
an authentication mechanism for a hostile holder of the runtime database
credential. RLS protects against omitted or incorrect tenant predicates from
the application; it does not make arbitrary runtime SQL or a stolen database
credential safe. Protect runtime credentials, limit raw SQL, monitor role use,
and retain the API authorization layer. A future hardened design may move
context assertion into a narrowly scoped, audited database interface, but must
not introduce a generic `SECURITY DEFINER` or `BYPASSRLS` escape hatch.

## Required catalog checks

Run these on the approved clone using a migration/admin identity, never a
production database during development:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'ApiKey';

SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'ApiKey'
ORDER BY policyname;

SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public' AND table_name = 'ApiKey'
ORDER BY grantee, privilege_type;

-- This PUBLIC audit must return zero rows after provisioning. acldefault()
-- expands built-in defaults when a catalog ACL is NULL.
WITH public_acl AS (
  SELECT
    'database'::text AS object_type,
    d.datname::text AS object_name,
    acl.privilege_type
  FROM pg_database AS d
  CROSS JOIN LATERAL aclexplode(
    COALESCE(d.datacl, acldefault('d', d.datdba))
  ) AS acl
  WHERE d.datname = current_database() AND acl.grantee = 0

  UNION ALL

  SELECT 'schema', n.nspname, acl.privilege_type
  FROM pg_namespace AS n
  CROSS JOIN LATERAL aclexplode(
    COALESCE(n.nspacl, acldefault('n', n.nspowner))
  ) AS acl
  WHERE n.nspname = 'public' AND acl.grantee = 0

  UNION ALL

  SELECT
    'table',
    format('%I.%I', p.table_schema, p.table_name),
    p.privilege_type::text
  FROM information_schema.table_privileges AS p
  WHERE p.table_schema = 'public' AND p.grantee = 'PUBLIC'

  UNION ALL

  SELECT
    'sequence',
    format('%I.%I', n.nspname, c.relname),
    acl.privilege_type
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(
    COALESCE(c.relacl, acldefault('s', c.relowner))
  ) AS acl
  WHERE n.nspname = 'public' AND c.relkind = 'S' AND acl.grantee = 0

  UNION ALL

  SELECT
    'function',
    format(
      '%I.%I(%s)',
      n.nspname,
      p.proname,
      pg_get_function_identity_arguments(p.oid)
    ),
    acl.privilege_type
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(
    COALESCE(p.proacl, acldefault('f', p.proowner))
  ) AS acl
  WHERE n.nspname = 'public' AND acl.grantee = 0
)
SELECT object_type, object_name, privilege_type
FROM public_acl
ORDER BY object_type, object_name, privilege_type;

SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
FROM pg_roles
WHERE rolname LIKE 'guestpost_%'
ORDER BY rolname;
```

The integration test at
`apps/api/src/__tests__/integration/rls/api-key-tenant-isolation.integration.spec.ts`
proves SELECT, INSERT, UPDATE, and DELETE behavior for two organizations using
a temporary non-owner, `NOBYPASSRLS` role. It also proves no-context denial,
staff denial, presented-key narrowing, and denial after membership deactivation.

## Next phases

Prioritize tables by the harm from cross-tenant disclosure or mutation, not by
alphabetical model order:

1. Customer order/billing path: `Order`, `OrderItem`, `OrderEvent`, wallet and
   billing relations, with explicit customer-owner/member rules.
2. Publisher path: publisher-owned listings, services, integrations, payout
   projections, and publisher-membership context.
3. Support and staff path: tickets, messages, assignments, Operations scopes,
   Finance scopes, and audited Super Admin capabilities.
4. Public catalog: approved/verified listing projections only; never grant a
   generic anonymous policy to source tables that contain drafts, contacts, or
   finance data.
5. Worker/system flows: distinct workload context, job authentication, and
   explicit operation-specific policies. Background work does not inherit an
   end-user policy.

Each phase needs a schema migration, a server-side context wrapper, explicit
`FOR SELECT/INSERT/UPDATE/DELETE` policies, a non-owner database-role test,
two-tenant CRUD tests, auth/bootstrap regression coverage, and a role/grant
review. `FORCE ROW LEVEL SECURITY` is mandatory unless a documented migration
exception is approved.
