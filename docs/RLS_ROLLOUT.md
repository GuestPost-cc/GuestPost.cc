# Full application row-level security rollout

## Status and scope

The repository contains a staged RLS boundary for all 99 Prisma application
models. It covers customer, publisher, staff, authentication, webhook, worker,
and catalog workloads. The full boundary is not activated by a normal Prisma
migration:

- `20260908130000_full_application_rls_boundary/migration.sql` installs four
  explicit command policies for the 98 not-yet-forced models but leaves them
  inert; it does not touch the six live Phase 1 `ApiKey` policies.
- `scripts/provision-rls-roles.sql` reconciles the least-privilege database
  role and ACL topology while leaving every credential role `NOLOGIN`.
- `scripts/activate-full-rls.sql` performs guarded, atomic `ENABLE` + `FORCE`
  activation only after exact catalog, policy, role, privilege, and ownership
  checks pass.
- `scripts/emergency-disable-full-rls.sql` atomically disables the full
  boundary while preserving the independently proven Phase 1 `ApiKey`
  boundary.

No repository script enables a login, creates a password, changes an
environment, or targets a hosted database automatically.

## Policy boundary

| Workload | Database identity | Row authority |
| --- | --- | --- |
| Customer API | `guestpost_api_runtime` | Live, active `Membership`, non-suspended `User`, and active organization. API keys additionally require live `OWNER` authority. |
| Publisher API | `guestpost_api_runtime` | Live `PublisherMembership`, non-suspended `User`, active publisher, and resources rooted through publisher/website/order relationships. |
| Staff API | `guestpost_api_runtime` | Live `StaffMembership` and non-suspended staff user. `SUPER_ADMIN`, `OPERATIONS`, and `FINANCE` use explicit command/model matrices; caller-provided staff role settings never grant authority. |
| Better Auth | `guestpost_auth_runtime` | Separate table-level identity for account/session and birth-time provisioning tables only. It has no order, marketplace, payout, or reporting table privilege. |
| Public catalog | API identity with `PUBLIC` context | Approved and verified listings whose website is active and verified, plus only their catalog-visible related rows. Anonymous telemetry cannot claim a user ID. |
| Signed webhook | API identity with fixed server-selected ingress | Explicit Stripe, payout-provider, or integration-OAuth table allowlist. Handler signature/state verification remains mandatory before mutation. |
| Worker | `guestpost_worker_runtime` | Explicit platform-worker model allowlist and a nonempty server-selected queue name. It has no `BYPASSRLS`; missing context returns no rows. |
| Reporting | `guestpost_reporting_runtime` | Fail closed: connection and schema usage only, with no table grants. |

Marketplace browsing is an intentional shared boundary: a live customer or
publisher can read the reviewed catalog while retaining access to its own
private resources. Draft, unverified, inactive-site, and cross-tenant rows stay
hidden. Catalog telemetry writes require either no user for anonymous traffic
or the exact live actor ID for an authenticated request. Review author names
and images are display-safe snapshots on `MarketplaceReview`; public catalog
queries do not receive the related private `User` row. Website metrics are
visible only through a reviewed listing on an active, verified website.

Mutation policies are command-aware. Live owners control customer and
publisher membership grants, non-owner invite acceptance is limited by a
database trigger to an otherwise unchanged PENDING-to-ACTIVE transition, and
Operations cannot mutate staff authority. Audit rows are append-only. Separate
last-owner triggers reject deletion or demotion of the final active customer or
publisher owner, preventing an administrative or self-service lockout.

RLS is a row boundary, not column masking. Public-facing application queries
must continue selecting only approved response fields. A holder of a runtime
database credential can also set custom PostgreSQL settings, so the settings
are an application context channel—not authentication for hostile arbitrary
SQL. Protect credentials, prohibit user-controlled raw SQL, retain API guards
and projections, and alert on unexpected role use.

## Runtime context and pool safety

The API initializes an `AsyncLocalStorage` scope before global guards. Better
Auth validates the session first through `AUTH_DATABASE_URL`; the API then uses
an `AUTH_BOOTSTRAP` context to resolve only the actor's durable authority.
`CurrentAuthorityGuard` replaces it with a customer, publisher, or staff
context before a protected handler runs.

The central Prisma proxy wraps every model/raw operation in an interactive
transaction and calls `set_config(..., true)` for every supported setting.
Those settings are transaction-local, all unused values are cleared, and
PostgreSQL removes them at commit/rollback. A pooled connection therefore
cannot carry one request's tenant or role into another. Existing interactive
transactions receive context once on the exact transaction client; array-form
transactions fail closed while enforcement is enabled.

The worker establishes the same request/job scope around bootstrap and each
BullMQ processor. Integrations create RLS-aware clients. When
`RLS_ENFORCEMENT_ENABLED` is absent or not exactly `true`, the proxy remains
inert for pre-rollout and local compatibility.

## Role topology

`scripts/provision-rls-roles.sql` owns 11 roles and exactly five membership
edges:

The reconciliation leaves all credential roles `NOLOGIN`; enabling credentials
is a separate administrator action after connection-level verification.

| Roles | Purpose |
| --- | --- |
| `guestpost_schema_owner`, `guestpost_migrator` | `NOLOGIN` schema owner plus isolated migration identity. Migrator is `NOINHERIT` and may only `SET ROLE` to the owner. |
| `guestpost_api_group`, `guestpost_api_runtime` | API DML identity, never owner/DDL/bypass. |
| `guestpost_auth_group`, `guestpost_auth_runtime` | Better Auth and account birth-time tables only. |
| `guestpost_worker_group`, `guestpost_worker_runtime` | Platform job tables only, subject to forced policies. |
| `guestpost_reporting_group`, `guestpost_reporting_runtime` | Starts with no table access. |
| `guestpost_rls_authorizer` | `NOLOGIN`, `NOINHERIT`, no membership and no bypass; owns boolean-only `SECURITY DEFINER` policy helpers after activation. |

Every managed role is `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
`NOREPLICATION`, and `NOBYPASSRLS`. Provisioning removes unexpected direct or
transitive membership edges and reconciles database/schema/relation/function
ACLs in one transaction. It creates no password and leaves credential roles
`NOLOGIN`; credential activation is a separate approved administrator change.

## Required migration grant checklist

Default privileges grant no application access. Every migration that creates a table or sequence
(or adds a policy root) must update all of the following in the same change:

- the Prisma model manifest and full-boundary migration/next policy migration;
- the exact API, auth, worker, or reporting relation grants, plus read-only
  `guestpost_rls_authorizer` access for every new policy root;
- the activation catalog count and the destructive boundary test;
- command-specific policy tests, including a non-owner and no-context case.

Reviewers must reject blanket application-role default privileges and require
object-specific grants for every newly created relation.

## Lockout-safe deployment order

Never combine these stages into one production command. Rehearse every step on
a current, disposable clone first.

1. **Prove the clone.** Apply all migrations, provision roles, transfer the
   reviewed public table/sequence ownership inventory to
   `guestpost_schema_owner`, activate the clone, and run
   `scripts/test-full-rls-boundary.sql` as a cluster administrator. The test is
   destructive and uses fixed fixtures, so it is for a fresh ephemeral
   database only. GitHub CI performs this entire sequence in a dedicated
   `guestpost_rls_boundary_test` database.
2. **Install inert policies.** Deploy the Prisma migration normally. Verify 98
   covered models and 392 full-boundary policies, plus the six Phase 1
   `ApiKey` policies. Do not activate the generalized boundary yet.
3. **Provision disabled identities.** Run the role recipe through a protected
   administrator connection with the exact target database name. Transfer
   ownership from an explicit inventory. Create independent TLS/password or
   certificate credentials out of band, then enable only the approved login
   roles. Never give a runtime the migrator/owner secret.
4. **Verify each connection.** Connect with each new URL and check
   `session_user`, `current_user`, membership edges, `rolbypassrls=false`, and
   expected table grants/denials. The migrator must enter as
   `guestpost_migrator` with `current_user=guestpost_schema_owner`; runtime
   sessions must remain their runtime identity.
5. **Deploy context-aware code while policies are inert.** Configure the API
   `DATABASE_URL` with the API runtime identity, `AUTH_DATABASE_URL` with the
   auth runtime identity, and worker `DATABASE_URL` with the worker runtime
   identity. Set `RLS_ENFORCEMENT_ENABLED=true` on API and worker. API startup
   deliberately fails if enforcement is enabled without `AUTH_DATABASE_URL`,
   preventing a session-wide lockout caused by sending Better Auth through the
   tenant-scoped API client.
6. **Canary before activation.** Exercise signup/sign-in/sign-out/password
   reset, customer owner/member switching, publisher private listings and
   orders, customer invitation acceptance/decline, review creation/rendering,
   marketplace metric filtering, all staff roles, public catalog,
   Stripe/payout callbacks, and each worker queue. Confirm transaction latency
   and pool saturation are within limits. Because the 98 new policy sets are
   still inert and the proven Phase 1 `ApiKey` policies remain unchanged, a
   generalized context bug cannot lock users out during this stage.
7. **Activate atomically.** Through an approved admin session, run:

   ```sh
   psql "$ADMIN_DATABASE_URL" \
     -v database_name=<exact_database_name> \
     -v activate=YES \
     -f scripts/activate-full-rls.sql
   ```

   The script aborts unless the database name and confirmation match exactly,
   all 98 staged model policy sets and all six Phase 1 `ApiKey` policies exist,
   managed roles lack privileged attributes, and every application
   table/sequence has the reviewed owner. It transfers helper ownership,
   grants only the three runtime groups access to the private helper schema,
   atomically swaps `ApiKey` from its six Phase 1 policies to four
   full-boundary policies, enables and forces every table, and verifies the
   final 99-model/396-policy result before commit.
8. **Prove provisioning reruns.** Re-run the role recipe after activation and
   repeat the boundary matrix. Its atomic ACL reconciliation must retain the
   authorizer's schema usage and read-only access to every current policy root.
9. **Post-activation canary.** Repeat the step 6 journey with two distinct
   customer organizations and publishers. Include demotion/removal/suspension
   while a session is active. Alert on RLS denials, missing request context,
   authentication errors, transaction timeouts, and queue retries.
10. **Emergency recovery.** If activation causes lockout, keep the new roles and
   code in place and run the guarded emergency script through the approved
   administrator connection:

   ```sh
   psql "$ADMIN_DATABASE_URL" \
     -v database_name=<exact_database_name> \
     -v disable=EMERGENCY \
     -f scripts/emergency-disable-full-rls.sql
   ```

   This disables/no-forces the generalized policies atomically but preserves
   `ApiKey` RLS. Re-run the canary before deciding whether a code rollback or
   corrected policy activation is required. Record the incident and never
   treat emergency disablement as the steady state.

## Required verification

The checked-in suites cover three layers:

- unit/contract tests verify the 99-model manifest, staged four-policy
  generation, the lockout-safe activation-time `ApiKey` policy swap,
  all context variants, context clearing, proxy behavior, guard switching,
  explicit database URL support, and activation/rollback safeguards;
- the existing API-key PostgreSQL integration test proves owner-only CRUD and
  opaque presented-key narrowing;
- `scripts/test-full-rls-boundary.sql` proves actual forced-policy behavior for
  customer owner/member, publisher, Operations/Finance/Super Admin, auth,
  public, and worker identities, including cross-tenant update denial,
  telemetry spoofing denial, membership self-promotion denial, safe invite
  acceptance, last-owner preservation, append-only audit, filtered public
  review/metric reads, no-context denial, transaction-local reset, suspension,
  and live authority revocation.

Useful post-activation catalog checks:

```sql
SELECT count(*) AS fully_forced_tables
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public'
  AND relation.relkind = 'r'
  AND relation.relname <> '_prisma_migrations'
  AND relation.relrowsecurity
  AND relation.relforcerowsecurity;

SELECT count(DISTINCT tablename) AS covered_tables,
       count(*) AS command_policies
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname LIKE '%\_full\_boundary\_%' ESCAPE '\';

WITH public_acl AS (
  SELECT table_schema, table_name, privilege_type
  FROM information_schema.table_privileges
  WHERE table_schema = 'public' AND grantee = 'PUBLIC'
)
SELECT * FROM public_acl;

SELECT rolname, rolsuper, rolcreaterole, rolcreatedb,
       rolreplication, rolbypassrls
FROM pg_roles
WHERE rolname LIKE 'guestpost_%'
ORDER BY rolname;
```

Before activation, expected full-boundary values are 98 covered tables and 392
command policies, alongside six Phase 1 `ApiKey` policies. After activation,
expected values are 99 forced tables, 99 covered tables, 396 command policies,
and `false` for every privileged role attribute. Treat any mismatch as a
failed deployment gate.
