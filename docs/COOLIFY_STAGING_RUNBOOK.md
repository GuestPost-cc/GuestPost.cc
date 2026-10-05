# Coolify staging deployment

This runbook deploys the current GitHub `main` application to a domain selected
through Coolify variables, using Coolify, a new empty Neon project, internal
Redis, and the existing Cloudflare R2 integration. Do not treat a successful
image build as a database or financial release.

## Coolify source

Create a Docker Compose resource in the existing Coolify project:

- Repository: this GitHub repository.
- Branch: `main` after this deployment change is merged; use the deployment
  branch only for a temporary preview.
- Base directory: `/` (repository root).
- Compose file: `infrastructure/coolify/compose.yaml`.
- Set the required variables from the sections below in Coolify before the
  first build. Do not commit a `.env` file or paste secrets into build args.
- The host already runs Caddy on public ports 80/443. Coolify's Traefik proxy
  binds only to `127.0.0.1:18080`; host Caddy forwards each configured app
  hostname there. Keep those host bindings; do not claim public ports 80/443
  with Coolify or publish application ports publicly.
- Set `APP_DOMAIN` to the selected root domain. Compose derives the API,
  website, portal, publisher, and admin URLs, trusted origins, CORS origins,
  and auth cookie domain from it. For current staging, set
  `APP_DOMAIN=shohan.iam.bd`.
- In the Coolify Compose resource, assign these **HTTP** hostnames derived
  from `APP_DOMAIN` so Traefik routes on its private HTTP entry point:
  `api.${APP_DOMAIN}` → `api:4000`, `${APP_DOMAIN}` → `website:3000`,
  `app.${APP_DOMAIN}` → `portal:3000`,
  `publisher.${APP_DOMAIN}` → `publisher:3000`, and
  `admin.${APP_DOMAIN}` → `admin:3000`. Host Caddy terminates public HTTPS
  and proxies each hostname to Traefik on loopback port 18080.
- Point DNS for all five names at the Coolify server and configure matching
  Caddy host blocks. Confirm HTTPS certificates are ready before allowing
  sign-in. The app domain is not hardcoded in Compose; domain-specific DNS and
  reverse-proxy host blocks remain infrastructure configuration.
- The future domain is `guestpost.mvp.bd`. When its DNS is ready, add its five
  Caddy host blocks, update the five Coolify hostnames, then change only
  `APP_DOMAIN` to `guestpost.mvp.bd` and redeploy. Do not serve both unrelated
  root domains as one authenticated deployment: the shared auth cookie is
  scoped to one root domain at a time.

The Compose stack includes Redis with persistence, four web apps, the API, one
realtime worker, and an idle `worker-jobs` service for Coolify scheduled tasks.
Neon and Cloudflare R2 remain managed services; the API and workers have no
database migration command in their startup paths.

## New Neon project and database

Create a new staging project in the Singapore region, PostgreSQL 17, with an
empty `guestpost` database. Do not restore data from the deleted project.
Create the isolated identities described in `docs/RLS_ROLLOUT.md` and
`docs/PRODUCTION_RUNBOOK.md`: schema owner/migrator, API runtime, auth runtime,
worker runtime, reporting runtime, RLS authorizer, and the financial repair
guard. Runtime identities must be `NOBYPASSRLS`, non-owner, and have no DDL.
Keep the migration URL outside all reusable runtime services.

Use the staged sequence in `docs/RLS_ROLLOUT.md`:

1. Precreate the financial repair guard role, apply all checked-in Prisma
   migrations with the isolated `DIRECT_DATABASE_URL`, then provision the
   runtime roles and transfer the reviewed table/sequence ownership inventory.
2. Verify the role topology and each connection's effective identity and
   grants before starting the API or workers.
3. Configure `API_DATABASE_URL`, `AUTH_DATABASE_URL`, and
   `WORKER_DATABASE_URL` with their distinct identities. The Compose stack sets
   `RLS_ENFORCEMENT_ENABLED=true`; deploy only after context-aware runtime
   access and inert-policy canaries have passed.
4. Activate full RLS in its own reviewed transaction after signup, session,
   tenant, publisher, staff, and worker canaries pass. Do not combine
   activation with migration or service startup.

Neon URLs should use TLS and pooled endpoints for runtime services. Use a
direct, non-pooled endpoint for migrations and ownership/role operations.

## Coolify variables

Set these as Coolify runtime variables. Mark secrets as secret. Coolify expands
the same names during Compose interpolation and build arguments.

| Variable | Use |
|---|---|
| `APP_DOMAIN` | Root domain for all public app URLs and auth/CORS allowlists; current staging value: `shohan.iam.bd`; future cutover value: `guestpost.mvp.bd` |
| `API_DATABASE_URL` | Neon API runtime identity |
| `AUTH_DATABASE_URL` | Neon Better Auth identity |
| `WORKER_DATABASE_URL` | Neon worker identity |
| `REDIS_PASSWORD` | Random URL-safe password, generated for this staging stack |
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
the `worker-jobs` container:

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

1. Confirm the new Neon database is empty, backups/PITR are enabled, and all
   staged identities are separate.
2. Confirm R2 readiness object exists and only the dedicated staging bucket is
   granted to the app.
3. Run migrations as the isolated migration role; capture the applied migration
   list and role verification evidence in the deployment record.
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
