# Coolify staging deployment

This runbook deploys each independently scaled GuestPost service as its own
Coolify resource, using a new empty Neon project, private Redis, and Cloudflare
R2. Do not treat a successful image build as a database or financial release.

## Coolify source

Create separate GitHub App application resources in the existing Coolify
project and `staging` environment. Select the repository-restricted Coolify
GitHub App, repository `GuestPost-cc/GuestPost.cc`, and deployment branch
`codex/coolify-staging-rebuild` until the branch is merged. Use the repository
root as the base directory/build context for each Dockerfile resource. The
checked-in `infrastructure/coolify/compose.yaml` remains available for local
integration and single-resource previews; it is not the staging resource
layout.

| Coolify resource | Dockerfile | Build-time configuration | Runtime configuration | Route/port |
|---|---|---|---|---|
| `guestpost-staging-redis` | Coolify Redis database resource | `redis:7.2`; persistent `/data` volume; private access | Generated password; copy Coolify's internal Redis URL into app resources; keep on the shared Coolify network | No public route |
| `guestpost-staging-api` | `apps/api/Dockerfile` | Root context | API runtime DB URL, auth DB URL, Redis URL, auth/queue secrets, issuer identity, R2 settings, domain-derived CORS/auth settings and locked finance flags | `api.${APP_DOMAIN}` → 4000 |
| `guestpost-staging-website` | `infrastructure/coolify/Dockerfile.web` | `APP_NAME=website` plus all five public URL build args | `PORT=3000`, `NODE_ENV=production` | `${APP_DOMAIN}` → 3000 |
| `guestpost-staging-portal` | `infrastructure/coolify/Dockerfile.web` | `APP_NAME=portal` plus all five public URL build args | `PORT=3000`, `NODE_ENV=production` | `app.${APP_DOMAIN}` → 3000 |
| `guestpost-staging-publisher` | `infrastructure/coolify/Dockerfile.web` | `APP_NAME=publisher` plus all five public URL build args | `PORT=3000`, `NODE_ENV=production` | `publisher.${APP_DOMAIN}` → 3000 |
| `guestpost-staging-admin` | `infrastructure/coolify/Dockerfile.web` | `APP_NAME=admin` plus all five public URL build args | `PORT=3000`, `NODE_ENV=production` | `admin.${APP_DOMAIN}` → 3000 |
| `guestpost-staging-worker-realtime` | `apps/worker/Dockerfile` | Root context | Worker DB URL, Redis URL, queue signing secret, issuer identity, R2 settings and locked finance flags; `WORKER_MODE=realtime` | No public route; health port 3004 |
| `guestpost-staging-worker-jobs` | `apps/worker/Dockerfile` | Root context | Same restricted worker runtime variables; override command to `sh -c 'while :; do sleep 3600; done'` | No public route; Coolify scheduled tasks run here |

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

- Keep staging on the selected `codex/coolify-staging-rebuild` deployment
  branch until its changes are merged. Do not commit a `.env` file or pass
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
tasks. Neon and Cloudflare R2 remain managed services; the API and workers
have no database migration command in their startup paths.

## New Neon project and database

Create a new staging project in the Singapore region, PostgreSQL 17, with an
empty `guestpost` database. Do not restore data from the deleted project.
Create the isolated identities described in `docs/RLS_ROLLOUT.md` and
`docs/PRODUCTION_RUNBOOK.md`: schema owner/migrator, API runtime, auth runtime,
worker runtime, reporting runtime, RLS authorizer, and the financial repair
guard. Runtime identities must be `NOBYPASSRLS`, non-owner, and have no DDL.
Keep the migration URL outside all reusable runtime services.

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

Use the staged sequence in `docs/RLS_ROLLOUT.md`:

1. Precreate the financial repair guard role, apply all checked-in Prisma
   migrations with the isolated `DIRECT_DATABASE_URL`, then provision the
   runtime roles and transfer the reviewed table/sequence ownership inventory.
2. Verify the role topology and each connection's effective identity and
   grants before starting the API or workers.
3. Configure `API_DATABASE_URL`, `AUTH_DATABASE_URL`, and
   `WORKER_DATABASE_URL` with their distinct identities. Set
   `RLS_ENFORCEMENT_ENABLED=true` on API and worker resources; deploy only
   after context-aware runtime access and inert-policy canaries have passed.
4. Activate full RLS in its own reviewed transaction after signup, session,
   tenant, publisher, staff, and worker canaries pass. Do not combine
   activation with migration or service startup.

Neon URLs should use TLS and pooled endpoints for runtime services. Use a
direct, non-pooled endpoint for migrations and ownership/role operations.

## Coolify variables

Set the required variables on each relevant Coolify resource. Mark credentials
as secret. `NEXT_PUBLIC_*` URLs belong in the frontend build arguments; the
same derived URLs belong in the API runtime variables where indicated.

| Variable | Use |
|---|---|
| `APP_DOMAIN` | Root domain used to derive public app URLs and auth/CORS allowlists; current staging value: `shohan.iam.bd`; future cutover value: `guestpost.mvp.bd` |
| `API_DATABASE_URL` | Neon API runtime identity |
| `AUTH_DATABASE_URL` | Neon Better Auth identity |
| `WORKER_DATABASE_URL` | Neon worker identity |
| `REDIS_PASSWORD` | URL-safe password generated and retained by the private Coolify Redis resource |
| `BETTER_AUTH_SECRET` | Random secret, at least 32 characters |
| `QUEUE_SIGNING_SECRET` | Separate random secret; do not reuse Better Auth secret |
| `INVOICE_ISSUER_LEGAL_NAME`, `INVOICE_ISSUER_ADDRESS_LINE_1`, `INVOICE_ISSUER_CITY`, `INVOICE_ISSUER_POSTAL_CODE`, `INVOICE_ISSUER_COUNTRY_CODE`, `INVOICE_SUPPORT_EMAIL` | Reviewed staging issuer identity required at API and worker startup |
| `R2_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Dedicated staging R2 bucket and credentials; provision the fixed readiness object before starting API/workers |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional browser-safe Sentry DSN used by web builds |
| `STRIPE_DEPOSIT_RECOVERY_KEY` | Optional until scheduled jobs are enabled; then use a distinct test-mode `rk_test_*` key with only required read access |

At initial staging boot, deposits, Connect, live Stripe, payouts, financial
repair, email delivery, and finance mutations remain disabled or locked. Add
OAuth credentials and sender secrets only when those staging flows are ready.

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
   users. Keep `FINANCE_RUNTIME_MODE=locked` and payout/Stripe gates false.
6. Enable scheduled tasks only after their required runtime and Stripe test
   variables are present. Keep transactional email disabled until the sender
   and allowed recipient policy are reviewed.

For rollback, disable scheduled tasks, stop worker services, and redeploy the
last known compatible image. Do not reverse migrations or reuse a runtime
database identity as a migration credential.
