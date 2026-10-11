# Doppler for Coolify staging

The Doppler project `guestpost_staging` is the source of environment values for
the Coolify staging resources. Its `stg` root config holds shared, non-secret
staging values. Service configs branch from `stg`, so common values are copied
to those configs when the root changes and service-specific values remain
isolated.

| Coolify resource | Doppler config | Config-specific values |
|---|---|---|
| API | `stg_api` | API/auth database URLs, Redis URLs, auth, queue, payout, and integrations encryption secrets, issuer identity, R2 credentials, auth/CORS settings, and test-only Stripe gates |
| Website | `stg_website` | `APP_NAME=website`, `PORT=3000`, plus shared Next.js build URLs |
| Portal | `stg_portal` | `APP_NAME=portal`, `PORT=3000`, plus shared Next.js build URLs |
| Publisher | `stg_publisher` | `APP_NAME=publisher`, `PORT=3000`, plus shared Next.js build URLs |
| Admin | `stg_admin` | `APP_NAME=admin`, `PORT=3000`, plus shared Next.js build URLs |
| Realtime worker | `stg_worker_realtime` | Worker database/Redis URLs, queue signing secret, issuer identity, R2 credentials, and restricted email settings |
| Jobs worker | `stg_worker_jobs` | Worker database/Redis URLs, queue signing secret, issuer identity, and restricted email settings. Add the restricted Stripe recovery key only before enabling its scheduled task. |

The shared `stg` values are `APP_DOMAIN=shohan.iam.bd`, `NODE_ENV=production`,
`NEXT_PUBLIC_ALLOWED_APP_DOMAINS=shohan.iam.bd`, and the five derived public
URLs (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WEBSITE_URL`,
`NEXT_PUBLIC_PORTAL_URL`, `NEXT_PUBLIC_PUBLISHER_URL`, and
`NEXT_PUBLIC_ADMIN_URL`). `guestpost.mvp.bd` is reserved for a later DNS/Caddy
cutover; change `APP_DOMAIN` and redeploy only when that cutover is ready.
Keep the API's `INTEGRATION_ENCRYPTION_KEY` scoped to `stg_api`; the default
realtime and idle jobs lanes do not load the on-demand integration worker.

The API config also has port 4000, HTTPS auth/CORS/trusted-origin settings,
`AUTH_COOKIE_DOMAIN=shohan.iam.bd`, `OBJECT_STORAGE_PROVIDER=r2`, the known
Cloudflare R2 account/endpoint/bucket, and explicit safe defaults. The
realtime worker has `WORKER_MODE=realtime`, health port 3004, and the known R2
account/endpoint/bucket. The jobs worker must keep its idle resource command
configured in Coolify. Keep live Stripe, legacy payout, and financial-repair
gates false; keep `RLS_ENFORCEMENT_ENABLED=false` until the reviewed role/login
canaries and RLS rollout steps pass. Keep the initial finance posture locked.
Enable Stripe test flows only after clean finance migrations and the checks in
`STRIPE_STAGING_RUNBOOK.md`, with `STRIPE_LIVE_MODE_ENABLED=false`. Both
workers have SMTP settings and the user-approved exact-address/domain
allowlists configured. `EMAIL_DELIVERY_MODE=disabled` is saved in both worker
configs until the exact-address guard is in the deployed code. Capture mode
sends real messages through SMTP, so keep the approved allowlists narrow.

## Coolify connection

Keep email delivery disabled until the deployed worker enforces
`EMAIL_ALLOWED_RECIPIENTS` as exact addresses. The guard is included in PR
#158; enable restricted capture only after that revision is deployed and
verified. Capture mode sends real mail through SMTP.

Coolify supports Doppler as a secret manager. Create a read-only Doppler
service token for each config in that table, then add the tokens under
Coolify **Keys & Tokens → Integration Tokens**. A Doppler service token is
already scoped to one project/config. Use these resource-specific token names:
`coolify-guestpost-stg-api`, `coolify-guestpost-stg-website`,
`coolify-guestpost-stg-portal`, `coolify-guestpost-stg-publisher`,
`coolify-guestpost-stg-admin`, `coolify-guestpost-stg-worker-realtime`, and
`coolify-guestpost-stg-worker-jobs`. On each Coolify resource's Environment
Variables page, select its token and reference values as `{{vault.KEY}}`. For
the four Next.js resources, set the five `NEXT_PUBLIC_*` values and `APP_NAME`
as build-time variables. Redeploy after changing a build-time value.

Keep provider credentials in Doppler and use its read-only, config-scoped
service tokens for Coolify. If an AI tool later needs access, give it a separate
read-only token scoped to the staging config it needs; never reuse a Coolify
integration token or grant access to the Production config.

On 2026-10-11, the Coolify API now maps runtime-only `{{vault.KEY}}` references
for `DATABASE_URL`, `AUTH_DATABASE_URL`, `REDIS_URL`, and `QUEUE_REDIS_URL`.
Both workers map `DATABASE_URL`, `REDIS_URL`, and `QUEUE_REDIS_URL` as
runtime-only references. API/auth/worker database URLs use separate
least-privilege logins. Do not map a `neondb_owner` or migration connection
into a service.

## Values still required

On 2026-10-11, four unique pooled Neon login URLs were saved to the matching
Doppler configs: API, Better Auth, realtime worker, and jobs worker. The
runtime login attributes and one intended membership per login were verified
in Neon's catalog, and the URLs are mapped to their Coolify resources. Doppler
values remain masked; actual pooled login and application connectivity
canaries are still pending. The current Neon Console view
is project `guestpost-staging` (`crimson-lab-17945062`), branch
`production` (`br-empty-resonance-b5fnktnx`), PostgreSQL 18 in AWS US East 2
(Ohio), database `neondb`. The 100-migration schema is present there. Start the
API and workers with these restricted URLs to run the connection and
effective-role canaries. Keep full RLS activation gated until grants and
context-aware application flows pass.

- App secrets are saved: `stg_api` has `BETTER_AUTH_SECRET`,
  `QUEUE_SIGNING_SECRET`, the payout encryption keyring and active ID, and
  `INTEGRATION_ENCRYPTION_KEY`. The same queue signing secret is saved in
  `stg_worker_realtime` and `stg_worker_jobs`. The integration key stays API-only;
  the default realtime and idle jobs lanes do not load integration workers.
- A staging-only invoice bundle is now saved in `stg_api`,
  `stg_worker_realtime`, and `stg_worker_jobs`: prefix `STGTEST`, issuer
  `GuestPost LLC`, city `NewYork`, postal code `12000`, country `US`, support
  `info@mail.shohan.iam.bd`, and street line `STAGING ONLY - NOT A REAL
  ADDRESS`. The street line is the user's requested dummy placeholder, not a
  legal address. Use generated invoices only for staging tests; replace the
  placeholder with the reviewed issuer identity before any real invoice use.
  `STRIPE_DEPOSIT_RECOVERY_KEY` is needed only before enabling the jobs
  resource's on-demand schedule and must be a distinct restricted `rk_test_*`
  key.
- The API and realtime worker now have a new restricted Stripe test key, and
  `stg_api` has three separate test webhook signing secrets for the configured
  deposit, platform transfer, and connected-account destinations. Stripe
  deposit/Connect/live flags remain false until database and finance rollout
  checks pass. Earlier existing Stripe test keys were exposed in browser
  accessibility output; they were not reused, but remain active pending
  consumer review and rotation. Never copy a live key into staging.
- Resend's verified `mail.shohan.iam.bd` sender uses a replacement
  sending-only key stored in both worker configs. The initially exposed key was
  revoked. SMTP host, port, TLS, user, sender, and the exact-address/domain
  allowlists are configured for both workers. The user approved three
  mailboxes; keep those exact allowlists narrow. Delivery is disabled until the
  deployed worker enforces the exact-address allowlist.

On 2026-10-11, the guarded direct-Neon migration ran against this branch using
the exact Coolify `main` revision `d5a60a7`. Prisma applied all 100 migrations
and reported the schema up to date. The postflight verified application table
and sequence ownership by `guestpost_schema_owner`, preserved existing RLS
flags, confirmed all seven migration-owned FORCE RLS tables, removed the
one-use migration login, and installed the reviewed 13-role `NOLOGIN` ACL
topology. The Neon Console now shows the migrated application schema. The
owner URL that was previously echoed has been rotated, according to the user.

The apps remain stopped pending merge and deployment. Four separate
least-privilege logins have been provisioned and catalog-verified; their URLs
are in Doppler and Coolify. Actual connection/effective-role canaries, service
health, and R2 upload/retrieve checks still need to run. The direct owner URL
is for one-time seed or database administration only; never place it in an app
config. The reviewed RLS activation preflight accepts only Neon's exact
non-inheritable/non-settable owner provider edge and the intended schema-owner
`SET ROLE` edge. Keep `RLS_ENFORCEMENT_ENABLED=false` until session identity,
grants, and context-aware application canaries pass.

Use distinct Neon runtime logins for API, Better Auth, and worker. Never put the
schema-owner or one-use migration URL in an application config. Use the
internal private Redis URL from Coolify, not a public Redis endpoint. The
Cloudflare account API token is not an R2 S3 credential; the dedicated
`guestpost-staging` bucket's R2 access key ID and secret are now present in
`stg_api` and `stg_worker_realtime`. The readiness object
`.guestpost/evidence-storage-ready-v1` now exists in the bucket; complete the
runtime storage canary before starting delivery-capable services.

See [the Coolify staging runbook](COOLIFY_STAGING_RUNBOOK.md) for the database,
RLS, deployment, DNS, and release sequence.
