---
note_type: domain-memory
domain: infrastructure
project: guestpost-platform
updated: 2026-07-17
---

# Infrastructure

## Hosting model (2026-06-14)

Currently **laptop-only** for development. A 2GB VPS attempt at `103.42.5.163` (Ubuntu 24.04, BDIX-class provider) was provisioned + bootstrapped + populated with the full stack on 2026-06-14, then deleted same day — Next dev mode + nest --watch + tsx --watch + Docker (postgres/redis/mailpit) exceeded RAM and the first compiled request hung. The repo was scrubbed of VPS artifacts (`infrastructure/vps/`, `infrastructure/caddy/`, `infrastructure/docker/docker-compose.staging.yml`, per-app Dockerfiles, `scripts/vps-sync.sh`, `.env.vps.example`, README VPS section, plan-file Part 2 — all gone).

Shared dev/testing host is an **open question** (see `bedrock/Work/open-questions.md`): bigger VPS, cloud sandbox (Railway/Fly/Render), or production-build (`next build` once + `next start`) instead of dev mode to cut RAM. The image-based staging path was NOT tried — would be significantly cheaper at runtime.

## Render Blueprint (configuration only)

`render.yml` defines the active Render staging topology for `guestpost.pro.bd`: one NestJS API and four Next.js web services in the Singapore region, all built from the monorepo root. The worker is intentionally not deployed on Render while the workspace is on free-tier testing; run it locally for queue processing.

External infrastructure is bring-your-own for staging: Neon Postgres, Upstash Redis, Resend SMTP, Cloudflare R2, Sentry, and ReadyBD DNS. Render uses `sync: false` or `generateValue` for secrets so active credentials are not committed. Web services are configured on Render's free instance type for internal testing.

The API build is compile-only (`pnpm turbo build --filter=@guestpost/api...`) because Render free web services cannot use `preDeployCommand`, and running Prisma migrations in the build phase was unreliable with Neon. Prisma config supports `DIRECT_DATABASE_URL` for direct Neon migrations; run migrations manually/one-off before deploys that require schema changes, or move this to Render predeploy once the workspace upgrades.

Auth is served from `api.guestpost.pro.bd` while dashboards run on sibling subdomains. Staging sets `AUTH_COOKIE_DOMAIN=guestpost.pro.bd` so Better Auth issues a shared secure session cookie that Next middleware on `app`, `publisher`, and `admin` can see. Middleware must accept both `guestpost.session_token` (dev) and `__Secure-guestpost.session_token` (production).

The historical Blueprint contained an inline Neon database credential. The active Blueprint has removed inline database values, and the Neon role password was rotated during staging setup, but the old credential still exists in git history.



## Docker Compose

`infrastructure/docker/docker-compose.yml`:
- **Traefik v3.3** — reverse proxy (:80, :8080 dashboard)
- **PostgreSQL 17 Alpine** — primary database (:5432)
- **Redis 7 Alpine** — cache + BullMQ queue (:6379)
- **MinIO** — S3-compatible object storage (:9000 API, :9001 console)
- **Mailpit** — dev SMTP server (:1025 SMTP, :8025 UI)

## Environment

- `.env.development` — dev env vars (loaded when `NODE_ENV=development`)
- `.env.example` — template with all required vars
- Runtime env validation at startup (required: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`)
- `NODE_ENV` guards production behaviors

## CI/CD

GitHub Actions:
- **main.yml** — on push to `main`: build, typecheck, test
- **pr.yml** — on PR to `main`: same checks

Steps: checkout → pnpm install → build deps → migrate DB → typecheck → Jest tests → build all

## Build System

- **pnpm 11** workspace monorepo
- **Turbo 2** for task orchestration (all apps + packages)
- 11 build targets across all apps/packages

## Dev Commands

- `pnpm dev:all` — compose + all apps (stable local stack); after the production build it removes only `apps/*/.next/dev` before starting Next dev servers so stale development route manifests cannot hide valid app-router pages.
- `pnpm -F @guestpost/api test` — unit jest project only (fast feedback; ~5s for 47 suites / 652 tests)
- `pnpm -F @guestpost/api test:integration` — integration jest project only (real-DB; ~3s/spec)
- `pnpm -F @guestpost/api test:all` — both projects (48 suites / 653 tests as of 2026-06-22)
- `pnpm test:concurrency` — parallel attack scenarios
- `pnpm test:load [users=1000] [concurrency=50]` — load test
- `pnpm seed` — DB seed script

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

## Payout Encryption Key Rotation

### Architecture
- **Algorithm**: AES-256-GCM, random 12-byte IV, 16-byte auth tag.
- **Key derivation**: `scryptSync(masterKey, "payout-key-v{N}", 32)` per version number.
- **Master key source**: `PAYOUT_ENCRYPTION_KEY` env var (64+ hex chars).
- **Encrypted tables**: `PayoutMethod.details`, `PayoutProvider.config`.
- **Version columns**: `PayoutMethod.encryptionKeyVersion`, `PayoutProvider.configEncryptionKeyVersion`.
- **Current version**: `CURRENT_PAYOUT_KEY_VERSION` at `apps/api/src/modules/publisher-payouts/payout-encryption.constants.ts` — single source of truth shared by the encryption service and the version verifier script.
- **Dev fallback**: Version 0 (hardcoded dev key, blocked in production).

### Rotation procedures

#### Soft rotation (version bump, same master key) — RECOMMENDED

New encryptions use a fresh derived key; old rows remain decryptable.

1. In `payout-encryption.constants.ts`, bump `CURRENT_PAYOUT_KEY_VERSION` from `1` to `2`.
2. Deploy — new rows encrypt with `deriveKey(2)`, old rows (version 1) still decrypt.
3. Verify via `pnpm test` — the rotation-safety test at `payout-decrypt-security.spec.ts:156` validates multi-version round-trips.
4. (Optional) Re-encrypt old rows to the latest version (see Backfill below).

No data migration. Zero downtime.

#### Hard rotation (change master key)

Use when the master key is potentially compromised.

1. Generate new master key: `openssl rand -hex 32`.
2. BEFORE deploying the new key, re-encrypt all existing rows:
   - For each `PayoutMethod`: decrypt with old key → encrypt with new key → update row.
   - Same for each `PayoutProvider.config` row.
3. Update `PAYOUT_ENCRYPTION_KEY` in the deployment environment.
4. Deploy.
5. Run `pnpm tsx scripts/verify-encryption-versions.ts --decrypt` to assert all samples decrypt.
6. Securely erase the old master key after confirming no rollback.

### Verifier
- `scripts/verify-encryption-versions.ts` — standalone runtime tool.
- `pnpm tsx scripts/verify-encryption-versions.ts` — version-only audit.
- `pnpm tsx scripts/verify-encryption-versions.ts --decrypt` — decrypts one sample per (table, version).
- `pnpm tsx scripts/verify-encryption-versions.ts --json --quiet` — CI-friendly output.
- Shared constant: `CURRENT_PAYOUT_KEY_VERSION` is imported from `payout-encryption.constants.ts` — no version drift between the service and the verifier.

### Post-rotation checklist
1. [ ] Run `pnpm tsx scripts/verify-encryption-versions.ts` — all versions in supported set.
2. [ ] Run `pnpm tsx scripts/verify-encryption-versions.ts --decrypt` — all samples decrypt.
3. [ ] `pnpm test` passes (55+ suites).
4. [ ] Manual spot-check: decrypt one old-row and one new-row `PayoutMethod` via the admin API.
5. [ ] Update `payout-encryption.constants.ts` with the new version.
6. [ ] Update this runbook with the rotation date and new version.
