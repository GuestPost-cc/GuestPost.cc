# Coolify staging deployment

This runbook deploys each independently scaled GuestPost service as its own
Coolify resource, using a new empty Neon project, private Redis, and Cloudflare
R2. Do not treat a successful image build as a database or financial release.
Environment values are managed in Doppler; see
[`DOPPLER_STAGING.md`](DOPPLER_STAGING.md) for per-resource config names,
Coolify references, safe defaults, and the remaining credential checklist.

## Coolify source

Create separate GitHub App application resources in the existing Coolify
project and `staging` environment on the staging server. Select the
repository-restricted Coolify GitHub App, repository
`GuestPost-cc/GuestPost.cc`, and deployment branch `main`. The selected `main`
revision at `d5a60a792ac2d4d071426cac8d928ac2789d1f03` contains the shared web
Dockerfile. Use the repository root as the base directory/build context for
each Dockerfile resource. The
checked-in `infrastructure/coolify/compose.yaml` remains available for local
integration and single-resource previews; it is not the staging resource
layout.

| Coolify resource | Dockerfile | Build-time configuration | Runtime configuration | Route/port |
|---|---|---|---|---|
| `guestpost-staging-redis` | Coolify Redis database resource | `redis:7.2`; persistent `/data` volume; private access | Generated password; copy Coolify's internal Redis URL into app resources; keep on the shared Coolify network | No public route |
| `guestpost-staging-api` | `apps/api/Dockerfile` | Root context | API runtime DB URL, auth DB URL, Redis URL, auth/queue secrets, payout and integrations encryption keyrings, issuer identity, R2 settings, domain-derived CORS/auth settings and locked finance flags | `api.${APP_DOMAIN}` → 4000 |
| `guestpost-staging-website` | `infrastructure/coolify/Dockerfile.web` | `APP_NAME=website` plus all five public URL build args | `PORT=3000`, `NODE_ENV=production` | `${APP_DOMAIN}` → 3000 |
| `guestpost-staging-portal` | `infrastructure/coolify/Dockerfile.web` | `APP_NAME=portal` plus all five public URL build args | `PORT=3000`, `NODE_ENV=production` | `app.${APP_DOMAIN}` → 3000 |
| `guestpost-staging-publisher` | `infrastructure/coolify/Dockerfile.web` | `APP_NAME=publisher` plus all five public URL build args | `PORT=3000`, `NODE_ENV=production` | `publisher.${APP_DOMAIN}` → 3000 |
| `guestpost-staging-admin` | `infrastructure/coolify/Dockerfile.web` | `APP_NAME=admin` plus all five public URL build args | `PORT=3000`, `NODE_ENV=production` | `admin.${APP_DOMAIN}` → 3000 |
| `guestpost-staging-worker-realtime` | `apps/worker/Dockerfile` | Root context | Worker DB URL, Redis URL, queue signing secret, issuer identity, R2 and restricted SMTP settings, and locked finance flags; `WORKER_MODE=realtime` | No public route; health port 3004 |
| `guestpost-staging-worker-jobs` | `apps/worker/Dockerfile` | Root context | Worker DB URL, Redis URL, queue signing secret, issuer identity, and restricted SMTP settings for scheduled communication work; override command to `sh -c 'while :; do sleep 3600; done'` | No public route; Coolify scheduled tasks run here |

For each application, select GitHub App source deployment and configure the
Dockerfile path shown above. Set `APP_DOMAIN=shohan.iam.bd`; derive public
build args as `https://api.${APP_DOMAIN}`, `https://${APP_DOMAIN}`,
`https://app.${APP_DOMAIN}`, `https://publisher.${APP_DOMAIN}`, and
`https://admin.${APP_DOMAIN}`. Mark credentials as secrets. Give every resource
the same Coolify destination/server so they share the private `coolify`
network; use the Redis resource's generated internal URL, never a public Redis
port. Configure each frontend's API URL as a build-time argument because
Next.js embeds `NEXT_PUBLIC_*` values in the browser bundle.

Deploy Redis first, then the API and realtime worker, then the four frontends.
Keep `worker-jobs` idle until its schedules and restricted Stripe test key are
ready. The existing Compose resource is stopped; leave its unsaved form alone
and do not start it alongside these independent resources.

- Keep all staging resources on `main`. Do not commit a `.env` file or pass
  secrets as build args.
- The host already runs Caddy on public ports 80/443. Coolify's Traefik proxy
  binds only to `127.0.0.1:18080`; host Caddy forwards each configured app
  hostname there. Keep those host bindings; do not claim public ports 80/443
  with Coolify or publish application ports publicly.
- Set `APP_DOMAIN` to the selected root domain. Derive the API, website,
  portal, publisher, and admin URLs, trusted origins, CORS origins, and auth
  cookie domain from it. For current staging, set
  `APP_DOMAIN=shohan.iam.bd`.
- Assign these **HTTP** hostnames to the corresponding independently deployed
  application resources and their listening ports so Traefik routes through
  its private HTTP entry point: `api.${APP_DOMAIN}` → API port 4000,
  `${APP_DOMAIN}` → website port 3000, `app.${APP_DOMAIN}` → portal port
  3000, `publisher.${APP_DOMAIN}` → publisher port 3000, and
  `admin.${APP_DOMAIN}` → admin port 3000. Host Caddy terminates public HTTPS
  and proxies each hostname to Traefik on loopback port 18080.
- Point DNS for all five names at the Coolify server and configure matching
  Caddy host blocks. Confirm HTTPS certificates are ready before allowing
  sign-in. The app domain is supplied through Coolify build/runtime
  configuration; DNS and Caddy host blocks remain infrastructure settings.
- The future domain is `guestpost.mvp.bd`. When its DNS is ready, add its five
  Caddy host blocks, update the five Coolify hostnames, then change only
  `APP_DOMAIN` to `guestpost.mvp.bd` and redeploy. Do not serve both unrelated
  root domains as one authenticated deployment: the shared auth cookie is
  scoped to one root domain at a time.

The independent resources are Redis with persistence, four web apps, the API,
one realtime worker, and an idle `worker-jobs` service for Coolify scheduled
tasks. Keep `INTEGRATION_ENCRYPTION_KEY` scoped to the API; the default
realtime and scheduled lanes do not load on-demand integrations. Neon and
Cloudflare R2 remain managed services; the API and workers have no database
migration command in their startup paths.

## Current Neon branch and database provisioning

Use the existing `guestpost-staging` project (`crimson-lab-17945062`) and its
`production` branch (`br-empty-resonance-b5fnktnx`); do not delete or recreate
it. It runs PostgreSQL 18 in AWS US East 2 (Ohio), with database `neondb`.
On 2026-10-11, `scripts/migrate-neon-direct.sh` applied all 100 migrations to
this database. Prisma reported the schema up to date; all application tables
and sequences are owned by `guestpost_schema_owner`; existing RLS flags were
preserved; all seven migration-owned FORCE RLS tables were verified; and the
one-use migration login was removed. The script also installed the 13-role
`NOLOGIN` ACL topology. Full application RLS activation and runtime login
provisioning remain separate gates. Use the actual `neondb` connection path
for migration and runtime URLs unless an operator deliberately provisions a
separate database. Runtime identities must be `NOBYPASSRLS`, non-owner, and
have no DDL. Keep the migration URL outside all reusable runtime services.
Create the isolated identities described in `docs/RLS_ROLLOUT.md` and
`docs/PRODUCTION_RUNBOOK.md`: schema owner/migrator, API runtime, auth runtime,
worker runtime, reporting runtime, RLS authorizer, and the financial repair
guard. Runtime identities must be `NOBYPASSRLS`, non-owner, and have no DDL.
Keep the migration URL outside all reusable runtime services.

The 2026-10-11 read-only Neon catalog audit confirmed all 13 managed roles are
`NOLOGIN` and `NOBYPASSRLS`; only `neondb_owner` can log in, and it has
`BYPASSRLS` and `CREATEROLE`. Never use that owner connection for an app. The
API, realtime worker, and jobs worker each have the right scoped Doppler token
attached in Coolify, but their variable lists have no database or Redis URL
references. The Doppler values therefore are not yet reaching those
containers. Add references only after creating the runtime login credentials
and proving each effective role; do not map the existing owner/migration URL.
Use separate logins for API, Better Auth, realtime worker, and jobs worker.
Each login must be `NOBYPASSRLS`, `NOINHERIT`, and allowed to `SET ROLE` only to
its matching `NOLOGIN` runtime identity. Verify the effective role through the
same pooled connection format that will be stored in Doppler.

Neon does not provide a PostgreSQL superuser to the project owner and rejects
`ALTER ROLE`. The checked-in provisioners therefore validate role attributes
created with the reviewed values. Before migrations, run
`scripts/provision-financial-repair-guard-role.sql`, then create the schema
owner and a one-use migration login with
`scripts/provision-neon-migration-login.sql`. Generate a random password only
in the operator shell and pass it as the required `migrator_password` psql
variable. Run Prisma Migrate through the direct endpoint as
`guestpost_migrator_login`, adding the standard PostgreSQL startup option
`options=-c role=guestpost_schema_owner`. Verify
`session_user=guestpost_migrator_login` and
`current_user=guestpost_schema_owner` before migrating. After migrations,
confirm all application tables and sequences are owned by
`guestpost_schema_owner`, remove the temporary login with
`scripts/cleanup-neon-migration-login.sql`, then run
`scripts/provision-rls-roles.sql` to install and verify the final ACL topology.
Never store the temporary login or owner URL in Coolify.

Run the repeatable direct-Neon sequence from the repository root with the exact
commit configured in Coolify, for example
`NEON_MIGRATION_REF=d5a60a7 bash scripts/migrate-neon-direct.sh`. The script
checks that the selected commit is on `origin/main` and that the local Prisma
schema, migrations, and role-provisioning SQL match it. It prompts for the direct
`neondb_owner` URL without echoing it, validates the Neon host and database,
provisions a fresh one-use migrator, runs `prisma migrate deploy` before the
status check, verifies object ownership, preserves pre-existing RLS flags,
checks all seven migration-owned FORCE RLS tables, removes the one-use login,
and installs the reviewed `NOLOGIN` runtime ACL roles. It does not run the
separate full-application RLS activation. Connection passwords stay in a
mode-0600 temporary password file, removed on exit. Never put the URL in a
command argument, `.env` file, or Coolify variable.

Use the staged sequence in `docs/RLS_ROLLOUT.md`:

1. Migrations, table/sequence ownership, and the reviewed `NOLOGIN` role
   topology are complete. For later schema changes, rerun the direct migration
   script against the exact deployment commit. Provision separate runtime
   logins and passwords; never reuse the migration URL.
2. Verify the role topology and each connection's effective identity and
   grants before starting the API or workers.
3. Configure `API_DATABASE_URL`, `AUTH_DATABASE_URL`, and
   `WORKER_DATABASE_URL` with their distinct identities. Keep
   `RLS_ENFORCEMENT_ENABLED` false until context-aware runtime access and
   inert-policy canaries have passed.
4. Activate full RLS in its own reviewed transaction after signup, session,
   tenant, publisher, staff, and worker canaries pass. Do not combine
   activation with migration or service startup.

## Staging fixture data

The default `scripts/seed.ts` mode remains restricted to a local loopback API
and sentinel-marked Compose database. The explicit staging mode targets only
`https://api.shohan.iam.bd` and a direct TLS `neondb_owner` URL for `neondb` in
the `guestpost-staging` Neon branch. It runs a staging API/Redis readiness
check before writes. The owner URL is only for this one-off seed process; it
must never be saved in Doppler or Coolify. Run it from a protected local
terminal with hidden input for the direct URL:

```sh
(
  read -rs "DATABASE_URL?Direct Neon neondb_owner URL for guestpost-staging: "
  export DATABASE_URL NODE_ENV=production SEED_MODE=staging
  export SEED_API_URL=https://api.shohan.iam.bd
  export SEED_STAGING_CONFIRMATION=guestpost-staging:br-empty-resonance-b5fnktnx
  pnpm seed
)
```

The staging seed intentionally reuses the existing local fixture identities,
staff roles, marketplace catalog, and synthetic `$5,000` wallet ledger deposit.
Those fixture passwords are unsuitable for accounts exposed to untrusted
testers; use the staging environment only for this approved internal stress
test and disable or rotate fixture accounts before broader access. The
synthetic ledger entry is not a Stripe transaction. Keep payouts and Stripe
live mode disabled while seeding; real wallet deposits use Stripe test mode
after runtime and RLS canaries pass.

After the API is healthy and RLS canaries pass, the existing bounded load
harness can exercise wallet-backed order checkout against staging. Its staging
mode requires the same hidden direct-owner URL and exact branch confirmation,
checks the API and database identity before writes, and is capped at 1,000
users with 50 concurrent requests. It provisions synthetic users, API keys,
wallet credits, and orders directly in the staging database, then checks order
debits and reconciliation. The generated rows remain for inspection. This is
not a Stripe deposit test; test-mode deposits should be checked separately
through the API/UI after enabling the Stripe test deposit flag. Never run this
load harness with a live Stripe key or payout execution enabled.

Run the harness from a protected local terminal using hidden URL input:

```sh
(
  read -rs "DATABASE_URL?Direct Neon neondb_owner URL for guestpost-staging: "
  export DATABASE_URL NODE_ENV=production LOAD_TEST_MODE=staging
  export API_URL=https://api.shohan.iam.bd
  export SEED_STAGING_CONFIRMATION=guestpost-staging:br-empty-resonance-b5fnktnx
  pnpm test:load 1000 50
)
```

Neon URLs should use TLS and pooled endpoints for runtime services. Use a
direct, non-pooled endpoint for migrations and ownership/role operations.

## Coolify variables

Set the required variables on each relevant Coolify resource. Mark credentials
as secret. `NEXT_PUBLIC_*` URLs belong in the frontend build arguments; the
same derived URLs belong in the API runtime variables where indicated.

| Variable | Use |
|---|---|
| `APP_DOMAIN` | Root domain used to derive public app URLs and auth/CORS allowlists; current staging value: `shohan.iam.bd`; future cutover value: `guestpost.mvp.bd` |
| `API_DATABASE_URL` | Compose-only name for the Neon API runtime identity; a separate Coolify API resource receives it as `DATABASE_URL` |
| `AUTH_DATABASE_URL` | Neon Better Auth identity |
| `WORKER_DATABASE_URL` | Compose-only name for the Neon worker identity; each separate Coolify worker resource receives it as `DATABASE_URL` |
| `REDIS_PASSWORD` | URL-safe password generated and retained by the private Coolify Redis resource |
| `BETTER_AUTH_SECRET` | Random secret, at least 32 characters |
| `QUEUE_SIGNING_SECRET` | Separate random secret; do not reuse Better Auth secret |
| `INTEGRATION_ENCRYPTION_KEY` | API-only 64-character hexadecimal key for integration credentials |
| `PAYOUT_ENCRYPTION_KEYS`, `PAYOUT_ENCRYPTION_ACTIVE_KEY_ID` | API-only bounded payout keyring and the ID used for new ciphertext |
| `INVOICE_ISSUER_LEGAL_NAME`, `INVOICE_ISSUER_ADDRESS_LINE_1`, `INVOICE_ISSUER_CITY`, `INVOICE_ISSUER_POSTAL_CODE`, `INVOICE_ISSUER_COUNTRY_CODE`, `INVOICE_SUPPORT_EMAIL` | Reviewed staging issuer identity required at API and worker startup |
| `R2_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Dedicated staging R2 bucket and credentials; provision the fixed readiness object before starting API/workers |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional browser-safe Sentry DSN used by web builds |
| `STRIPE_DEPOSIT_RECOVERY_KEY` | Optional until scheduled jobs are enabled; then use a distinct test-mode `rk_test_*` key with only required read access |

At initial staging boot, deposits, Connect, payouts, financial repair, and
email delivery remain disabled or locked. The user wants test-mode Stripe
deposits/Connect/payout flows and a test email path enabled after staging
readiness checks. Keep `STRIPE_LIVE_MODE_ENABLED=false` at all times. Add the
restricted Stripe test credentials, webhook secrets, and Resend sender values
only to Doppler.

The worker on `main` (`d5a60a7`) does not enforce the exact-address
`EMAIL_ALLOWED_RECIPIENTS` setting. Keep email delivery disabled for that image;
enable capture only after the exact-address guard is included in the deployed
commit and verified. Capture mode sends real email through SMTP.

## Worker schedules

After the database and worker identity are ready, add Coolify scheduled tasks on
the `guestpost-staging-worker-jobs` resource:

| Command | Cron (UTC) | Timeout |
|---|---:|---:|
| `WORKER_MODE=scheduled WORKER_TASK=maintenance-dispatch node apps/worker/dist/index.js` | `*/5 * * * *` | 30 minutes |
| `WORKER_MODE=on-demand node apps/worker/dist/index.js` | `*/10 * * * *` | 10 minutes |

The on-demand job requires `STRIPE_DEPOSIT_RECOVERY_KEY` and exits if that
restricted test credential is absent. Leave that schedule disabled until the
key is configured. Scheduled work is safe against duplicate triggers through
the worker's retained BullMQ job IDs; still set Coolify's timeout to the table
values and monitor failed executions.

## First release and checks

1. Confirm the new Neon database is empty, backups/PITR are enabled, and the
   staged identities are separate. On Neon, use the one-use migration login
   procedure above; its LOGIN is dropped after the migration canary.
2. Confirm R2 readiness object exists and only the dedicated staging bucket is
   granted to the app.
3. Run migrations as the isolated one-use migration login with the effective
   schema-owner identity; capture the applied migration list and role
   verification evidence in the deployment record.
4. Start API and realtime worker only after RLS roles and inert policies are
   ready; then start the frontends and validate each public host, health route,
   sign-in, signup, and cross-surface cookies.
5. Complete the RLS canary and activation procedure before onboarding test
   users. Keep finance locked until the Stripe test prerequisites in
   `STRIPE_STAGING_RUNBOOK.md` pass; then enable only test-mode paths with
   `STRIPE_LIVE_MODE_ENABLED=false` and payout sends bounded to Stripe test
   mode.
6. Enable scheduled tasks only after their runtime and restricted Stripe test
   variables are present. Start email in `capture` mode with the recipient
   domain and exact-address allowlists. Before enabling `live` delivery, verify
   the full address in `EMAIL_ALLOWED_RECIPIENTS` and confirm Resend has
   verified the sender.

For rollback, disable scheduled tasks, stop worker services, and redeploy the
last known compatible image. Do not reverse migrations or reuse a runtime
database identity as a migration credential.
