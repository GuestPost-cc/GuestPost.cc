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
| Realtime worker | `stg_worker_realtime` | Worker database/Redis URLs, queue and integrations encryption secrets, issuer identity, R2 credentials, and controlled email/test-finance settings |
| Jobs worker | `stg_worker_jobs` | Worker database/Redis URLs, queue and integrations encryption secrets, issuer identity, and controlled email/test-finance settings. Add the restricted Stripe test key only before enabling its on-demand schedule. |

The shared `stg` values are `APP_DOMAIN=shohan.iam.bd`, `NODE_ENV=production`,
the secret `INTEGRATION_ENCRYPTION_KEY` (use the same value for API and both
workers because they encrypt and decrypt the same provider credentials),
`NEXT_PUBLIC_ALLOWED_APP_DOMAINS=shohan.iam.bd`, and the five derived public
URLs (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WEBSITE_URL`,
`NEXT_PUBLIC_PORTAL_URL`, `NEXT_PUBLIC_PUBLISHER_URL`, and
`NEXT_PUBLIC_ADMIN_URL`). `guestpost.mvp.bd` is reserved for a later DNS/Caddy
cutover; change `APP_DOMAIN` and redeploy only when that cutover is ready.

The API config also has port 4000, HTTPS auth/CORS/trusted-origin settings,
`AUTH_COOKIE_DOMAIN=shohan.iam.bd`, `OBJECT_STORAGE_PROVIDER=r2`, the known
Cloudflare R2 account/endpoint/bucket, and explicit safe defaults. The
realtime worker has `WORKER_MODE=realtime`, health port 3004, and the known R2
account/endpoint/bucket. The jobs worker must keep its idle resource command
configured in Coolify. The user wants Stripe deposit/Connect/payout tests and
a test email path in staging. Keep live Stripe, legacy payout, and financial
repair gates false; `RLS_ENFORCEMENT_ENABLED` remains false until the documented
role canaries and rollout steps are complete. Keep the initial finance posture
locked. Enable Stripe test flows only with restricted test keys,
`STRIPE_LIVE_MODE_ENABLED=false`, clean finance migrations, and the rollout
checks in `STRIPE_STAGING_RUNBOOK.md`. Start email in `capture` mode with
`EMAIL_ALLOWED_RECIPIENT_DOMAINS` set to the exact test recipient's domain;
enable external delivery only to the approved test recipient after Resend
verifies the sender.

## Coolify connection

Coolify supports Doppler as a secret manager. Create a read-only Doppler
service token for each config in that table, then add the tokens under
Coolify **Keys & Tokens → Integration Tokens**. A Doppler service token is
already scoped to one project/config; name each token for its resource, such as
`coolify-stg-api`. On each Coolify resource's Environment Variables page, select
its token and reference values as `{{vault.KEY}}`. For the four Next.js
resources, set the five `NEXT_PUBLIC_*` values and `APP_NAME` as build-time
variables. Redeploy after changing a build-time value.

Keep provider credentials in Doppler and use its read-only, config-scoped
service tokens for Coolify. If an AI tool later needs access, give it a separate
read-only token scoped to the staging config it needs; never reuse a Coolify
integration token or grant access to the Production config.

## Values still required

These values have not been added because the corresponding credentials or
operator-approved identity details are not available yet:

- `stg_api`: `DATABASE_URL` for the API runtime role, `AUTH_DATABASE_URL` for
  the separate Better Auth role, `REDIS_URL`, `QUEUE_REDIS_URL`,
  `BETTER_AUTH_SECRET`, `QUEUE_SIGNING_SECRET`, `PAYOUT_ENCRYPTION_KEYS`,
  `PAYOUT_ENCRYPTION_ACTIVE_KEY_ID`, `INTEGRATION_ENCRYPTION_KEY`,
  `INVOICE_ISSUER_LEGAL_NAME`, `INVOICE_ISSUER_ADDRESS_LINE_1`,
  `INVOICE_ISSUER_CITY`, `INVOICE_ISSUER_POSTAL_CODE`,
  `INVOICE_ISSUER_COUNTRY_CODE`, `INVOICE_SUPPORT_EMAIL`, plus
  `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
- `stg_worker_realtime`: `DATABASE_URL` for the worker runtime role,
  `REDIS_URL`, `QUEUE_REDIS_URL`, `QUEUE_SIGNING_SECRET`,
  `INTEGRATION_ENCRYPTION_KEY`, the same six reviewed issuer fields, and the
  R2 access key/secret.
- `stg_worker_jobs`: `DATABASE_URL` for the worker runtime role, `REDIS_URL`,
  `QUEUE_REDIS_URL`, `QUEUE_SIGNING_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, and
  the same six reviewed issuer fields. `STRIPE_DEPOSIT_RECOVERY_KEY` is needed
  only before enabling its on-demand schedule and must be a distinct restricted
  `rk_test_*` key.
- Resend `SMTP_PASS` is needed for the email capture/live test worker after
  the sender configuration is ready. External delivery must be restricted to
  the exact user-approved test recipient; the recipient has not been supplied
  yet.

Use distinct Neon runtime logins for API, Better Auth, and worker. Never put the
schema-owner or one-use migration URL in an application config. Use the
internal private Redis URL from Coolify, not a public Redis endpoint. The
Cloudflare account API token is not an R2 S3 credential; create an R2 key scoped
to the `guestpost-staging` bucket. Provision the readiness object and complete
the storage canary before starting delivery-capable services.

See [the Coolify staging runbook](COOLIFY_STAGING_RUNBOOK.md) for the database,
RLS, deployment, DNS, and release sequence.
