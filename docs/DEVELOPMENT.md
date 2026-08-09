# Development

## Architecture

See `bedrock/Memory/ARCHITECTURE.md` for the canonical architecture
document. This file covers day-to-day development workflows.

## Monorepo structure

```
apps/
  api/          — NestJS backend
  admin/        — Admin dashboard (Next.js)
  portal/       — Customer portal (Next.js)
  publisher/    — Publisher dashboard (Next.js)
  website/      — Public website (Next.js)
  worker/       — Background job worker
packages/
  api-client/   — HTTP client for the GuestPost API
  auth/         — Auth utilities
  database/     — Prisma schema + client
  shared/       — Shared utilities and types
  ui/           — Shared UI component library
```

## Dev workflow

1. Start services: `pnpm services:up`
2. Build shared deps: `pnpm build --filter=@guestpost/shared --filter=@guestpost/database --filter=@guestpost/auth --filter=@guestpost/ui --filter=@guestpost/api-client`
3. With every API and worker process stopped, run migrations: `pnpm db:migrations:deploy`
4. Start individual app: `pnpm dev:portal` or `pnpm dev:api`

For the complete stack, `pnpm dev:all` starts infrastructure, removes stale
Next.js output before the production build, builds the workspace, checks
`pnpm db:migrations:status`, and removes production Next.js output before
launching the development servers. The two cleanup boundaries prevent stale
locks from blocking builds and prevent production route artifacts from hiding
valid development routes. Prisma returns a non-zero status for pending or
failed migrations, so startup fails closed rather than serving requests with
an incompatible generated client and database schema.

`pnpm services:up` loads Compose substitutions from `.env.development`, waits
for the fixed local Postgres and MinIO services to become healthy, installs a
database-side development sentinel, and idempotently creates and verifies
`MINIO_BUCKET` plus the fixed read-only readiness object before returning. It
rejects invalid bucket names or a mismatch between the app's
`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` and the local server's root credentials.
This bootstrap is restricted to the local Compose container; production R2/S3
buckets remain operator-provisioned. A failed bucket check stops `dev:all`
before the delivery-verification worker can consume jobs without durable
snapshot storage.

Object-storage selection is also enforced in application code. `development`
and `test` use only the complete `MINIO_*` bundle at the fixed local HTTP port
9000; any coexisting R2/S3 variables are ignored, and an explicit non-MinIO
provider is rejected. `production` requires `OBJECT_STORAGE_PROVIDER=r2` or
`OBJECT_STORAGE_PROVIDER=s3` and reads only that provider's complete bundle.
Provider fields are never mixed or defaulted. This prevents a developer
snapshot from being redirected to external storage by unrelated credentials.
Before accepting requests or delivery jobs, the API and storage-capable worker
lanes issue a bounded `HeadObject` for
`.guestpost/evidence-storage-ready-v1`; application startup never creates this
object outside the local Compose bootstrap.

The status gate intentionally does not apply migrations automatically. Some
financial evidence migrations reject legacy writer shapes. If the gate fails,
stop all API and worker processes, run `pnpm db:migrations:deploy`, verify
`pnpm db:migrations:status`, and only then restart the stack. Never deploy those
migrations while an old API or worker is still writing.

### Local Stripe deposit testing

Card deposits are disabled in every environment unless
`STRIPE_DEPOSITS_ENABLED=true` is set explicitly. A Stripe-looking key alone
does not enable the API or the customer action. This prevents an expired or
forgotten local credential from advertising a money flow that cannot finish.

Use Stripe test mode only. In the ignored `.env.development`, configure a
current test secret/restricted key, set `STRIPE_DEPOSITS_ENABLED=true`, and set
`STRIPE_WEBHOOK_SECRET` to the signing secret issued by the local Stripe CLI
listener. Never commit either value and never reuse staging/production signing
secrets locally. Restart the API after changing these values so startup
validation and the authenticated capability projection use the same config.

In a separate terminal, forward only the certified deposit/dispute events to
the raw-body webhook boundary:

```bash
stripe listen \
  --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,charge.dispute.created,charge.dispute.closed,radar.early_fraud_warning.created \
  --forward-to http://localhost:4000/api/v1/billing/webhook/stripe
```

The CLI prints a temporary `whsec_...` signing secret; copy it directly into
the ignored environment file without pasting it into logs, issues, chat, or
source control. Complete Checkout with a Stripe test card, then verify that the
signed webhook credits the wallet exactly once and that redelivery is a no-op.
The success redirect never credits money. Without the listener, Checkout may
succeed at Stripe while the portal correctly remains pending and times out
after 60 seconds. Set `STRIPE_DEPOSITS_ENABLED=false` when local provider
testing is finished.

## Testing

- API unit tests: `pnpm --filter @guestpost/api test`
- E2E tests: `npx playwright test`
- UI component tests: `pnpm --filter @guestpost/ui test:coverage`

`pnpm seed` is a local-fixture command, not a staging or production bootstrap.
It requires explicit development/test mode plus a direct loopback PostgreSQL
target on port 5432 and the loopback HTTP API on port 4000. Database connection
query parameters are rejected because PostgreSQL drivers can use them to
override the apparent URI host. The database must also carry the exact sentinel
installed by `pnpm services:up`; the seed checks it before any API or mutating
database work. Before signup, a loopback-only API preflight independently
proves that the API process is in development/test and its own Prisma
connection sees the same sentinel. The preflight also compares PostgreSQL
system identity, database OID, and database name with the seed's direct Prisma
connection, preventing mixed API/direct writes across two local databases. The
command does not override `NODE_ENV` or create an environment file. It fails
closed for every other target because it creates known-password users and
synthetic money evidence. Every fixture authentication must round-trip through
the authoritative session endpoint, and the seed revokes each signup/sign-in
session before continuing or exiting.

The seed uses one synthetic USD deposit for its customer wallet. The unique
ledger row and balance increment commit atomically while holding the wallet
aggregate row lock. Running the seed again is a no-op for funding, including
under a concurrent first run. A uniqueness collision is accepted only after a
fresh locked read proves the complete provider-free row shape and exact
wallet/ledger parity; mismatched identity, currency, linkage, description, or
balance evidence aborts without changing money.

The three demo publisher websites use IANA-reserved `.example` domains, so
there can be no real DNS ownership proof. To keep local checkout testable
without fabricating that proof, the sentinel-gated seed records a distinct
`SUPER_ADMIN_OVERRIDE` with an explicit development-fixture reason, actor,
audit row, and a maximum 90-day expiry. A real `VERIFIED` `DNS_TXT` record is
never replaced. Canonical domains, listing ownership/currency, categories,
services, and source-aware synthetic manual metrics are reconciled on replay;
conflicting ownership aborts.

The seed does not create publisher earnings, settlements, withdrawal
allocations, payout methods, or enabled provider-account evidence. A successful
publisher payout therefore remains intentionally unavailable in the generic
fixture. Test that workflow only with a dedicated evidence-consistent scenario;
never make a balance withdrawable or mark a payout paid with ad hoc SQL.

## Before committing

Run `pnpm check` to verify:
- Biome format + lint + imports
- ESLint (React Hooks)
- TypeScript compilation
- Dependency graph

The pre-commit hook runs Biome on staged files automatically.
