---
note_type: domain-memory
domain: infrastructure
project: guestpost-platform
updated: 2026-06-22
---

# Infrastructure

## Hosting model (2026-06-14)

Currently **laptop-only** for development. A 2GB VPS attempt at `103.42.5.163` (Ubuntu 24.04, BDIX-class provider) was provisioned + bootstrapped + populated with the full stack on 2026-06-14, then deleted same day — Next dev mode + nest --watch + tsx --watch + Docker (postgres/redis/mailpit) exceeded RAM and the first compiled request hung. The repo was scrubbed of VPS artifacts (`infrastructure/vps/`, `infrastructure/caddy/`, `infrastructure/docker/docker-compose.staging.yml`, per-app Dockerfiles, `scripts/vps-sync.sh`, `.env.vps.example`, README VPS section, plan-file Part 2 — all gone).

Shared dev/testing host is an **open question** (see `bedrock/Work/open-questions.md`): bigger VPS, cloud sandbox (Railway/Fly/Render), or production-build (`next build` once + `next start`) instead of dev mode to cut RAM. The image-based staging path was NOT tried — would be significantly cheaper at runtime.



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

- `pnpm dev:all` — compose + all apps (stable local stack)
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
