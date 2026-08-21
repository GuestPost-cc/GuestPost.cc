---
note_type: domain-memory
domain: infrastructure
project: guestpost-platform
updated: 2026-08-15
---

# Infrastructure

## Hosting model (2026-06-14)

Currently **laptop-only** for development. A 2GB VPS attempt at `103.42.5.163` (Ubuntu 24.04, BDIX-class provider) was provisioned + bootstrapped + populated with the full stack on 2026-06-14, then deleted same day — Next dev mode + nest --watch + tsx --watch + Docker (postgres/redis/mailpit) exceeded RAM and the first compiled request hung. The repo was scrubbed of VPS artifacts (`infrastructure/vps/`, `infrastructure/caddy/`, `infrastructure/docker/docker-compose.staging.yml`, per-app Dockerfiles, `scripts/vps-sync.sh`, `.env.vps.example`, README VPS section, plan-file Part 2 — all gone).

Shared dev/testing host is an **open question** (see `bedrock/Work/open-questions.md`): bigger VPS, cloud sandbox (Railway/Fly/Render), or production-build (`next build` once + `next start`) instead of dev mode to cut RAM. The image-based staging path was NOT tried — would be significantly cheaper at runtime.

## Render staging and Northflank worker

`render.yml` defines the active Render staging topology for `guestpost.pro.bd`: one NestJS API and four Next.js web services in the Singapore region, all built from the monorepo root. The worker is intentionally not deployed on Render while the workspace is on free-tier testing; run it locally for queue processing.

The staging worker is deployed separately on Northflank as `guestpost-worker`
from the repository's `main` branch. It shares the Render API's staging
`DATABASE_URL`, `REDIS_URL`, `QUEUE_SIGNING_SECRET`, and
`INTEGRATION_ENCRYPTION_KEY`; secret values are stored only in the deployment
platforms. The worker exposes its health server on port 3004 and was verified
`Running`, `1/1 passing`, with zero restarts after the 2026-07-19 environment
rollout. A queue-signature failure during rollout was traced to a mismatched
Northflank signing key and fixed by aligning it to Render before restarting.

External infrastructure is bring-your-own for staging: Neon Postgres, Upstash Redis, Resend SMTP, Cloudflare R2, Sentry, and ReadyBD DNS. Render uses `sync: false` or `generateValue` for secrets so active credentials are not committed. Web services are configured on Render's free instance type for internal testing.

The API build is compile-only (`pnpm turbo build --filter=@guestpost/api...`) because Render free web services cannot use `preDeployCommand`, and running Prisma migrations in the build phase was unreliable with Neon. Prisma config supports `DIRECT_DATABASE_URL` for direct Neon migrations; run migrations manually/one-off before deploys that require schema changes, or move this to Render predeploy once the workspace upgrades.

Auth is served from `api.guestpost.pro.bd` while the website and dashboards run on sibling subdomains. Staging sets `AUTH_COOKIE_DOMAIN=guestpost.pro.bd` so Better Auth issues a shared secure, HttpOnly session cookie. Browser authentication is opaque database-session based, not JWT/bearer based. Middleware recognizes both `guestpost.session_token` (dev) and `__Secure-guestpost.session_token` (production); mutation clients send the CSRF protection header and the API validates exact configured origins.

Staging incident note (2026-07-18): deployed API commit `a5edf8a` returned 500s for customer orders/billing and admin operations because the Neon staging schema was three migrations behind (`20260713120000_listing_per_website_unique`, `20260716030403_fin02_transaction_provider_unique`, `20260716120000_order_cancellation_workflow`). Applying `prisma migrate deploy` against Neon fixed the missing `OrderCancellationRequest` table and restored customer, publisher, and admin API reads. Render free web services block Shell and One-Off Jobs, so migrations currently require a local/direct Neon run or a temporary Render plan upgrade.

Staging Redis note (2026-07-18): `packages/integrations` queue producers previously ignored `REDIS_URL` and fell back to `REDIS_HOST`/`REDIS_PORT` (`localhost:6379`), causing Render API startup log noise and broken integration enqueue paths even while `/health/ready` was green. Commit `19c7024` added an integration Redis helper that uses `REDIS_URL` first, matching Upstash/Render configuration.

The historical Blueprint contained an inline Neon database credential. The active Blueprint has removed inline database values, and the Neon role password was rotated during staging setup, but the old credential still exists in git history.

The staging BullMQ connection now uses a dedicated Upstash Free Tier database
in AWS Singapore (`ap-southeast-1`) with eviction disabled. Its credentials are
kept only in deployment secret storage. TLS connectivity and worker
realtime/on-demand/scheduled modes were verified against the database on
2026-07-20; command usage still needs post-cutover monitoring.

## Hybrid worker architecture (2026-07-19)

The worker has four explicit runtime modes. `all` remains the safe default for
local development and rollback; `realtime` runs only email, notification,
requested website verification, and requested delivery verification;
`on-demand` drains burst queues and the PostgreSQL payout-webhook inbox before
exiting; `scheduled` executes either one allowlisted maintenance task or the
deterministic five-minute maintenance dispatcher and then exits. Northflank
must configure the non-default mode explicitly, and scheduled jobs must use a
forbid-concurrency policy. Because free projects allow only two jobs, the
deployment uses one API-triggerable on-demand job with a ten-minute catch-up
schedule and one five-minute maintenance dispatcher.

Runtime composition is declared in a side-effect-free typed plan. The
entrypoint executes that plan through injected factories and capabilities, so
tests boot `all`, `realtime`, `on-demand`, and `scheduled` without Redis,
Postgres, or provider secrets and assert exact lane ownership. Partial factory
failure drains already-created resources while preserving the originating
error; TERM/INT cleanup is single-flight. A narrow source boundary remains
only to forbid an eager integration-worker import before lane selection.

Queue traffic can be isolated through `QUEUE_REDIS_URL`, with `REDIS_URL` kept
as a compatibility fallback. BullMQ's worker drain delay and stalled-job scan
interval default to five minutes for the externally hosted Redis deployment,
and queue-metric snapshots default to a 30-minute cache. These settings reduce
idle Redis commands without changing retry or signature validation behavior.

The API can send a least-privilege, bearer-authenticated wake request to the
official Northflank run-job endpoint after a report, publisher-trust, or
payout-webhook record is durably committed. The project-scoped token needs only
`Project > Jobs > General > Read`. Wake failure is intentionally non-fatal: a
mandatory 10-minute catch-up schedule is the durable recovery path. Production
wake URLs are restricted to the official Northflank HTTPS host/path and cannot
contain embedded credentials, query parameters, or fragments. See
`docs/WORKER_ARCHITECTURE.md` for the deployment contract, task schedule,
rollout, rollback, and quota-monitoring procedure.

## Controlled finance-hardening cutover (2026-08-14)

The reviewed hardening release is merged at `main` SHA `512b851`. GitHub push
CI run `31729969759` passed all 75 migrations, the populated historical-data
rehearsal, unit/integration/package/UI suites, every production build, and the
self-starting Chromium journeys.

Neon's `production` branch has all 75 migrations applied. The cutover was
rehearsed first against an exact child clone, and the permanent restore branch
`pre-migration-512b851-20260814` was created immediately before the production
deploy. Pre/post row counts matched; all public constraints and indexes are
valid; expected finance triggers and lifecycle enums are present; all 28
financial incident-query blocks passed. The API/worker role remains
`guestpost_runtime` on a pooled endpoint with no owner, schema-create, trigger,
or role-escalation capability. Schema-owner passwords were reset on both
production and the permanent restore branch after postflight; disposable
rehearsal branches were deleted; all local connection/key files were
destroyed.

Render API deploy `dep-d9v0sf7qj5pc738no0o0` is live from exact SHA `512b851`.
It is intentionally held with `FINANCE_RUNTIME_MODE=locked`,
`PAYOUT_EXECUTION_ENABLED=false`, and `STRIPE_DEPOSITS_ENABLED=false`; the v2
payout keyring is stored only in Render. Both `/api/v1/health` and the
dependency-aware `/api/v1/health/ready` passed after the deploy. A startup
Redis warning cleared on the API readiness path, but that does not prove queue
capacity: the Northflank queue Redis quota remained exhausted and must be
restored before any worker canary.

Northflank is a deliberate full-fleet hold. `guestpost-on-demand` and
`guestpost-maintenance-dispatch` have inactive schedules and CD disabled. The
continuous `guestpost-worker` (`WORKER_MODE=realtime`) was discovered during
the final topology audit still running `1/1` on incompatible historical SHA
`0e68af7`; it was immediately scaled to `0/0`, and its CI and CD controls are
both disabled. Never scale that deployment up, resume a schedule, or manually
run either job.

The retired realtime pod's final log stream ended at `2026-08-13T19:09:03Z`
with all four queues (email, notification, website verification, and delivery
verification) repeatedly failing closed because the Upstash request quota was
exhausted. Delivery verification was still a material mixed-version risk: the
old image did not honor the new finance lock and could have written verification
evidence, snapshots, fraud holds, or order state. A least-privilege production
audit used the committed migration window
`2026-08-13T18:31:56.762Z..18:32:03.594Z` and found no timestamped database
activity during or after it, no old-image snapshot key
`deliveries/{deliveryVersionId}/page.html`, no realtime-lane evidence, unchanged
financial baselines, and zero lifecycle/settlement/payout/schema anomalies.
The temporary local DSN file and audit script were destroyed immediately.

Northflank requires an operator password re-check to open protected environment
settings. First restore or upgrade Redis capacity. After re-authentication,
configure the least-privilege runtime DSN, finance lock, disabled payout/deposit
flags, and the same v2 keyring on all three workloads; build/deploy exact SHA
`512b851`; verify each workload's SHA, explicit mode, and protected environment;
canary the realtime service at one replica in locked mode; and only then scale
or resume schedules deliberately.

## Confirmed-fraud migration cutover contract (2026-08-15)

Migration `20260815120000_delivery_fraud_findings` is additive in table shape
but mixed-writer incompatible. It installs append-only finding, cancellation,
and linked-refund guards and changes automated restoration behavior. Its
release therefore requires a populated Neon branch/clone rehearsal, a rotated
direct deploy-role connection, a PITR marker, and a hard drain of the API plus
all Northflank `realtime`, `on-demand`, `scheduled`, and ad-hoc `all` writers.
A pooled runtime DSN is never a migration connection, and any credential that
appeared in chat, logs, history, or a ticket is rotated before use.

The migration revokes `DeliveryFraudFinding` from `PUBLIC`. Before the matching
image starts, the restricted runtime role receives table `SELECT` and
column-scoped `INSERT` for only the Prisma-generated ID and application-written
finding facts. `createdAt` remains database-owned. Runtime UPDATE, DELETE,
TRUNCATE, TRIGGER, trigger-function EXECUTE, schema CREATE/ownership,
deploy-role inheritance, superuser, and `BYPASSRLS` remain forbidden and are
verified through the exact pooled API/worker connection.

The no-EXECUTE proof includes the deferred
`assert_confirmed_fraud_terminal_outcome()` trigger function. Its constraint
trigger must be enabled, deferrable, and initially deferred on `Order`: the
canonical refund updates Order first and linked cancellation second, so only
the complete transaction can be validated. Direct execution is not an
application call surface.

The matching release starts in `FINANCE_RUNTIME_MODE=recovery_only`. After
migration status, privilege denial proofs, invariant postflights,
reconciliation, and audience/outbox canaries pass, returning to server-only
`normal` is an intentional operator decision; `PAYOUT_EXECUTION_ENABLED`
remains independently false. Rollback retains the guards and uses an
evidence-aware forward fix. Once a finding exists an old image is never a
rollback target; a database-level failure uses the pre-cutover PITR marker
under incident control rather than a destructive down migration.


## Docker Compose

`infrastructure/docker/docker-compose.yml`:
- **Traefik v3.3** — reverse proxy (:80, :8080 dashboard)
- **PostgreSQL 17 Alpine** — primary database (:5432)
- **Redis 7 Alpine** — cache + BullMQ queue (:6379)
- **MinIO** — S3-compatible object storage (:9000 API, :9001 console)
- **Mailpit** — dev SMTP server (:1025 SMTP, :8025 UI)

`pnpm services:up` uses `.env.development` for Compose substitution, verifies
the fixed local Postgres service, installs the database-side sentinel required
by the privileged known-password seed, waits for the fixed local MinIO service
to become healthy, and idempotently creates and verifies `MINIO_BUCKET` with
the client bundled in that container. Invalid
bucket names or app/server credential drift fail startup. This path cannot
target R2/S3 and never auto-creates production storage; those buckets remain an
operator responsibility.

Runtime provider selection is atomic and environment-bound. Development/test
read only the complete `MINIO_*` bundle and require the fixed local HTTP port
9000, even if external credentials coexist. Production requires an explicit
`OBJECT_STORAGE_PROVIDER=r2|s3`, reads only that provider's complete bundle,
requires HTTPS external endpoints, and never falls back to MinIO. API and only
worker lanes that can consume delivery-verification jobs validate this contract
before serving or consuming; unrelated worker lanes do not receive the storage
credentials.

Production readiness performs only a bounded `HeadObject` for the fixed
operator-provisioned sentinel. That proves endpoint, bucket, identity, and read
authority; it deliberately does not prove `PutObject` permission. Before
delivery or Finance lanes are opened in staging/production, operators must run
an audited upload-and-retrieve canary with the exact runtime role, verify the
bytes/checksum, and remove only that canary object under the retention policy.

## Environment

- `.env.development` — dev env vars (loaded when `NODE_ENV=development`)
- `.env.example` — template with all required vars
- Runtime env validation at startup (required: `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`; production also requires `QUEUE_SIGNING_SECRET` and trusted origins)
- `NODE_ENV` guards production behaviors
- Local development keeps a separate `INTEGRATION_ENCRYPTION_KEY` from staging;
  the ignored `.env.development` file is owner-readable only (`0600`).

## CI/CD

`.github/workflows/ci.yml` is the single GitHub Actions gate for pull requests
to `main`, pushes to `main`, and manual runs. The stable required check name is
`CI / build-and-test`; the older duplicate `main.yml` and `pr.yml` workflows
were removed.

The workflow uses read-only repository permissions, non-persistent checkout
credentials, immutable action and service-image SHAs, superseded-run
cancellation, and no deployment secrets. It installs from the frozen lockfile,
blocks moderate-or-higher production dependency advisories, applies and checks
all migrations on PostgreSQL 17, provisions the integration-test template,
runs type/lint/dependency checks plus API/package/UI tests, and builds all 12
production targets. It then runs Chromium onboarding checks against
self-started API/customer/publisher processes. The browser harness is fixed to
loopback, uses deterministic run/test/retry-scoped account identities, starts
an isolated MinIO instance with the evidence-readiness object, and retains
failure traces, screenshots, and videos for seven days.

Render remains the deployment owner. Every Blueprint service uses
`autoDeployTrigger: off`; a green push does not deploy. Operators manually
promote one reviewed commit only after its migration, runtime-role,
configuration, drain, and staging gates pass. GitHub Actions does not receive
Neon, Upstash, Render, R2, Resend, Google, or Sentry deployment credentials.

## Build System

- **pnpm 11** workspace monorepo
- **Turbo 2** for task orchestration (all apps + packages)
- 11 build targets across all apps/packages

## Dev Commands

- `pnpm dev:all` — compose + all apps (stable local stack). It removes generated
  `apps/*/.next` state before the production build to clear abandoned locks,
  checks `prisma migrate status` after the build, removes production Next output
  again, and only then starts API, worker, and Next dev servers. Pending, failed,
  or unreachable migration state therefore fails before any application writer
  starts; committed migrations remain an explicit hard-drain deploy operation.
- `pnpm -F @guestpost/api test` — unit jest project only (fast feedback; ~5s for 47 suites / 652 tests)
- `pnpm -F @guestpost/api test:integration` — integration jest project only (real-DB; ~3s/spec)
- `pnpm -F @guestpost/api test:all` — both projects (48 suites / 653 tests as of 2026-06-22)
- `pnpm test:concurrency` — parallel attack scenarios
- `pnpm test:load [users=1000] [concurrency=50]` — load test
- `pnpm seed` — local-only known-password/demo-data fixture; refuses remote or
  indirect API/database targets, missing database sentinel, and
  non-development/test modes

## Prisma 7 + adapter-pg (Phase 7.13, 2026-06-21)

- **prisma + @prisma/client** pinned at `^7.8.0` (was 6.19.3). Classic Rust query engine removed; `@prisma/adapter-pg` + WASM Query Compiler now load-bearing.
- **Pool tuning** lives in `PoolConfig` form (was URL params on the old engine): `{ max: 25, idleTimeoutMillis: 20_000 }` for apps/api NestJS service; default pool for the global singleton.
- **`createPrismaClient()` / `createPrismaAdapter()` helpers** at `packages/database/src/create-prisma-client.ts`. Dual-helper design: full helper for direct-instantiation sites (the global singleton); adapter helper for NestJS's `PrismaService extends PrismaClient` (must call `super(...)`, can't substitute the full client helper).
- **Runtime DATABASE_URL guard**: `createPrismaAdapter()` throws `"DATABASE_URL is required"` at construction time if env unset. Converts confusing first-query failures into clear startup errors. `apps/api/jest.setup.js` sets a dummy `DATABASE_URL` so unit specs that transitively import `@guestpost/auth` (which eagerly evaluates the global singleton) don't fail at module-load time.
- **`CREATE INDEX CONCURRENTLY` unlocked**: Prisma 6 wrapped every migration in an implicit transaction (prisma#14456); Prisma 7.4+ does NOT wrap single-statement migrations. Confirmed empirically across Phases 7.13.1, 7.13.2A, 7.14.

### Migration rule: single-statement when combining `* CONCURRENTLY` (Phase 7.13.2B finding)

prisma@7.8.0's migrate runner DOES wrap **multi-statement** migration files in an implicit transaction (even though it doesn't wrap single-statement ones). This breaks `* CONCURRENTLY` ops with `ERROR: ... CONCURRENTLY cannot run inside a transaction block`. **Rule**: any migration that combines a `* CONCURRENTLY` operation with another DDL statement MUST be split into separate single-statement files. Pattern discovered when Phase 7.13.2B's intended single-file `DROP INDEX CONCURRENTLY` + `ALTER INDEX RENAME` failed; split into two single-statement migrations works.

## Test DB management (Phase 7.10.2, 2026-06-21)

- **`guestpost_test_template`** — dedicated empty-then-migrated DB used as the source for `CREATE DATABASE ... TEMPLATE guestpost_test_template` clones in integration tests. NEVER receives app writes; only `prisma migrate deploy` modifies it. Decouples integration tests from dev workflow (a dev can `prisma migrate dev` against their `guestpost` without affecting any test run).
- **Setup** (one-time per dev / per CI runner; CI integration step lands in Phase 7.10.2.1):
  ```bash
  docker exec gp-postgres psql -U guestpost -c "DROP DATABASE IF EXISTS guestpost_test_template;"
  docker exec gp-postgres psql -U guestpost -c "CREATE DATABASE guestpost_test_template;"
  DATABASE_URL=postgresql://guestpost:guestpost@localhost:5432/guestpost_test_template \
    pnpm -F @guestpost/database exec prisma migrate deploy
  ```
- **Template-clone is the only viable DB-isolation strategy for this codebase** — 51 `$transaction` callbacks across 28 services rule out tx-rollback isolation (Prisma 7 forbids nested `$transaction`). Per-test `migrate deploy` is too slow (~3-5s); TEMPLATE clone is ~150ms.
- **Parallel-clone safety verified** (Phase 7.10.2 Gate 0.5): 8 concurrent `CREATE DATABASE ... TEMPLATE guestpost_test_template` calls succeed in 1139ms wall time. Integration jest project can use default `--maxWorkers` (no need for `--maxWorkers=1`).

## Jest config patterns (Phase 7.10.2, 2026-06-21)

- **Jest projects** at `apps/api/jest.config.js`: `unit` (existing 47 suites) + `integration` (greenfield, rootDir `src/__tests__/integration`). `pnpm test` → unit only; `pnpm test:integration` → integration only; `pnpm test:all` → both.
- **`isolatedModules: true`** on ts-jest is required under the projects shape — default full-program type-checking trips on type errors in transitively-mocked deps (e.g. `@guestpost/auth`'s `better-auth` imports correctly mocked at runtime via `moduleNameMapper`). Side benefit: ~10x speedup on unit project (53s → 5.4s).
- **`forceExit: true` at root level** — jest's `projects` array doesn't honor per-project `forceExit`. Unit project needs it (grandfathered from Phase 7.8 PR #5 — pre-existing leaks). Integration project inherits as a side effect; future PR can split into separate jest configs if integration leak-detection becomes more important.
- **Integration helpers** at `apps/api/src/__tests__/integration/helpers/`: `test-db.ts` (`createTestDatabase()` returns `{ dbName, url, teardown }`) + `create-test-app.ts` (`createTestApp()` returns `{ app, prisma, dbName, cleanup }`). DATABASE_URL mutation happens BEFORE first AppModule import; Gate 0.75 confirmed env mutation reaches PrismaService cleanly.
- **psql multi-statement gotcha**: `psql -c "stmt1; stmt2"` wraps multi-statement input in an implicit transaction — an error rolls back earlier statements. For per-statement auto-commit, use `docker exec -i gp-postgres psql ... <<'SQL'` heredoc form. Discovered Phase 7.14 Gate 0.5.

## Prisma Connection Pool Sizing

### Architecture
- Two independent pools exist per deployment: NestJS API (`PrismaService`, resolves `PRISMA_POOL_MAX` env var) and global singleton (used by worker, pg default `max: 10`).
- The env var `PRISMA_POOL_MAX` controls the API pool. The worker pool is not configurable via env var (separate override if needed).
- Precedence: `options.max` > `PRISMA_POOL_MAX` env var > `PRISMA_POOL_MAX_DEFAULT` (10).
- Validation: non-integer, zero, or negative env var values throw at startup with a clear error. Values exceeding `PRISMA_POOL_MAX_RECOMMENDED` (25) emit a `console.warn`.

### Sizing formula (multi-replica)

```
per_process_max = (max_connections - superuser_reserved - worker_connections) / replica_count
```

Typical Postgres SaaS plan: `max_connections = 100`, `superuser_reserved = 3`, worker pool = ~10.

| Replicas | Recommended `PRISMA_POOL_MAX` |
|----------|-------------------------------|
| 1        | 10 (safe for laptop dev)      |
| ≤ 3      | 10–15                         |
| ≤ 5      | 10                            |
| > 5      | Recompute formula; consider raising `max_connections` |

The default of 10 is conservative — suitable for up to ~5 API replicas sharing 100 Postgres connections with 3 reserved for superuser access.

### Per-environment config
- **Laptop dev**: unset (defaults to 10) — both API and worker run locally, total 20 connections.
- **Staging**: `PRISMA_POOL_MAX=10` — matches production without driving up the staging Postgres plan.
- **Production**: Set based on the formula above. Monitor pool utilization via `SELECT count(*) FROM pg_stat_activity WHERE state = 'active'` and alert at 80% of the budget.

### Related findings
- #7 (Critical): pool was hardcoded to `max: 25` with no env-var override → closed by adding `PRISMA_POOL_MAX` + default 10.
- #30 (Medium): pool config had no validation → closed by adding `parsePoolMax()` + `console.warn` on excess.

## Integration Credential Encryption And Rotation

Integration access and refresh tokens use AES-256-GCM and are encrypted as one
credential pair. Every configured master key must be exactly 64 hexadecimal
characters (32 bytes); malformed or explicitly empty values fail in every
environment, and production has no fallback.

`ExternalAccount.encryptionKeyVersion` records the key version shared by both
token fields. New versioned deployments use
`INTEGRATION_ENCRYPTION_KEYS={"1":"<old-64-hex>","2":"<new-64-hex>"}` plus
`INTEGRATION_ENCRYPTION_ACTIVE_VERSION`. The keyring is bounded to 16 distinct
positive versions; the active version must exist, be the highest configured
version, and be at least 2. Do not configure the legacy
`INTEGRATION_ENCRYPTION_KEY` at the same time.

Version 2+ ciphertext carries a `v{version}:` envelope and AES-GCM additional
authenticated data bound to provider, external user id, owner type, owner id,
and token purpose (`access` or `refresh`). Copying ciphertext between accounts
or token fields therefore fails authentication. OAuth, refresh, reconnect, and
rotation update both ciphertexts and the stored version atomically; refresh
uses compare-and-swap so it cannot overwrite a concurrent reconnect or rekey.
Version 1 remains read-compatible only while its key is present.

Hard rotation procedure:

1. Add a new, distinct 64-hex key under a higher keyring version; keep every
   version still referenced by an `ExternalAccount` row.
2. Set that version as `INTEGRATION_ENCRYPTION_ACTIVE_VERSION`, deploy the
   dual-read/new-write configuration, and stop if startup validation fails.
3. Run `pnpm tsx scripts/rotate-integration-encryption.ts --verify-only` before
   mutation, then run the command without `--verify-only`. It processes bounded
   batches, locks each account, authenticates both old envelopes, and replaces
   the pair with an exact compare-and-swap update.
4. Run `--verify-only` again and confirm no active credential row references an
   older version before removing any old key. A missing key, newer stored
   version, invalid envelope, or concurrent credential change is a hard
   failure—not a skipped success.

Never log keys, plaintext tokens, or decrypted payloads. Rotation output is
limited to row ids and normalized failure classes.

## Payout Encryption v2 And Hard Rotation

Payout encryption writes format-2 envelopes as
`p2:<opaque-key-id>:<canonical-base64>`. The database integer records envelope
format, not key identity. AES-256-GCM uses a random 12-byte IV and 16-byte tag;
additional authenticated data binds payout-method details to method ID,
publisher ID, and type, and provider config to provider ID and name.

`PAYOUT_ENCRYPTION_KEYS` is a bounded JSON keyring of at most 16 distinct
64-hex keys. `PAYOUT_ENCRYPTION_ACTIVE_KEY_ID` selects the sole write key; all
other IDs are decrypt-only. `PAYOUT_ENCRYPTION_KEY` is a separate v0/v1 read
key during migration and is never a v2 write key. Missing or malformed v2
configuration fails every non-test runtime. Deterministic material is available
only inside a Jest worker with `NODE_ENV=test` and no payout key setting.

`PayoutEncryptionKeyProvider` is an injected, cloud-neutral boundary. The
repository includes a bounded environment implementation and network-free
static test provider. Production KMS/HSM provisioning, least-privilege runtime
identity, audited unwrap access, retention, recovery, and the concrete managed
provider adapter remain an operational launch gate; raw environment keys do
not constitute KMS protection.

Migration `20260812101000_payout_encryption_v2_keyring` preserves valid legacy
rows for read/rotation but hard-blocks legacy inserts and rewrites, envelope
relabeling/downgrade, and changes to AAD identity. Ciphertext rotation requires
an exact aggregate version increment. New payout methods and non-empty provider
configs must be valid p2 envelopes; `{}` remains the only unencrypted provider
sentinel at format 0.

`scripts/rotate-payout-encryption.ts` scans every active/inactive payout method
and every non-empty provider config in bounded ID batches. It authenticates the
old row context, refuses rows referenced by nonterminal payout executions,
locks and compare-and-swaps each re-encryption, and safely resumes by cursor or
full rerun. `scripts/verify-encryption-versions.ts` fully authenticates every
encrypted row and reports only safe IDs and format/key distributions;
`--require-active` also fails if any legacy or decrypt-only envelope remains.

The cutover is mixed-image incompatible: finance must be locked, payout sends
disabled, all payout-capable writers drained, the full verifier and dry run
clean, then the migration applied before only the v2 image starts. The exact
rotation, verification, key-removal, incident, and forward-fix-only rollback
procedure is `docs/PAYOUT_ENCRYPTION_RUNBOOK.md`.
