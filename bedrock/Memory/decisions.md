---
note_type: decisions-log
project: guestpost-platform
updated: 2026-06-22
---

# Decisions

Use this file for important project decisions.

## Decision format

### YYYY-MM-DD, Decision title

**Decision:** What was decided.

**Why:** Why this decision was made.

**Impact:** What this changes.

**Related files:** Links to relevant Memory or Work items.

---

### 2026-06-21, Prisma 6 → 7.8.0 + driver-adapter migration

**Decision:** Upgrade `prisma` + `@prisma/client` from `6.19.3` to `7.8.0`. Adopt `@prisma/adapter-pg` + `pg`. Remove classic Rust query engine; move to WASM Query Compiler.

**Why:** Prisma 6 wrapped every migration in an implicit transaction (prisma#14456), making `CREATE INDEX CONCURRENTLY` impossible. This blocked three queued audit fixes (Phase 7.13.1 Settlement composite index, Phase 7.13.2 favorites partial unique, Phase 7.14 #23 fulfillment race). Prisma 7.4+ inverted the default — single-statement migrations no longer transaction-wrapped. The audit's named "most valuable uncompleted roadmap item" was unblocked by this upgrade.

**Impact:** Both PrismaClient instantiation sites touched (`packages/database/src/index.ts` singleton + `apps/api/src/common/prisma.service.ts` NestJS service). Pool tuning moved from URL params (`?connection_limit=25&pool_timeout=20`) into the `PrismaPg(PoolConfig)` form. `buildDatasourceUrl` helper deleted. Worker `prisma.$disconnect` on graceful shutdown made load-bearing (the old Rust engine tolerated dropped pools; node-pg leaks). `Decimal` import path renamed `runtime/library` → `runtime/client` across 15 apps/api files. Unblocks Phase 7.13.1, 7.13.2A/B, 7.14, 7.13.1.1 (all shipped same day).

**Related files:** [[infrastructure]] "Prisma 7 + adapter-pg" section; `packages/database/src/create-prisma-client.ts`; `bedrock/Views/audits/platform-audit-2026-06-15.md` §11 (Phase 7.13 entry).

---

### 2026-06-21, Single-statement migration rule when combining `* CONCURRENTLY`

**Decision:** Any migration that combines a `* CONCURRENTLY` operation (CREATE / DROP INDEX CONCURRENTLY) with another DDL statement MUST be split into separate single-statement migration files.

**Why:** Empirical Gate 0.5B probe in Phase 7.13.2B showed that prisma@7.8.0's migrate runner wraps **multi-statement** migration files in an implicit transaction (even though it doesn't wrap single-statement ones). This breaks `* CONCURRENTLY` ops with `ERROR: ... CONCURRENTLY cannot run inside a transaction block`. The original Phase 7.13.2B plan was a single migration with `DROP INDEX CONCURRENTLY` + `ALTER INDEX RENAME` — it failed at apply time. Split into two single-statement migrations works.

**Impact:** Future Phase 7.x migrations must check this rule before bundling DDL. Phase 7.13.2B split-fallback was already pre-anticipated in its plan; Phase 7.14 + 7.13.1.1 + 7.13.x all shipped as single-statement migrations.

**Related files:** [[infrastructure]] "Migration rule: single-statement when combining `* CONCURRENTLY`" section; `packages/database/prisma/migrations/20260620213239_phase7132b_part1_drop_marketplace_favorite_original_unique/migration.sql`; `bedrock/Views/audits/platform-audit-2026-06-15.md` §11 (Phase 7.13.2B entry).

---

### 2026-06-21, TEMPLATE-clone DB isolation strategy for integration tests

**Decision:** Integration tests get a fresh ephemeral DB per spec via `CREATE DATABASE test_<pid>_<ts> TEMPLATE guestpost_test_template`. The template DB is dedicated (NOT dev's `guestpost`) and only receives `prisma migrate deploy` writes.

**Why:** Three options surveyed in Phase 7.10.2 recon:
- (A) Per-test transaction rollback — IMPOSSIBLE: 51 `$transaction` callbacks across 28 services + Prisma 7 forbids nested `$transaction`. Wrapping a service call in an outer tx fails.
- (B) Per-test `prisma migrate deploy` against a fresh DB — TOO SLOW: 3-5s per test.
- (C) TEMPLATE-clone — FAST: ~150ms per test. Already proven in Phase 7.14 + 7.13.x verification scripts.

Plus a separate dedicated template DB (NOT `guestpost`) decouples integration tests from dev workflow: a dev can `prisma migrate dev` against their `guestpost` without affecting any test run.

**Impact:** Phase 7.10.2 ships the harness with TEMPLATE-clone. Gate 0.5 verified 8 parallel clones succeed in 1139ms wall time, so the integration jest project can use default `--maxWorkers`. Operator action: one-time `guestpost_test_template` setup on CI runner (deferred to Phase 7.10.2.1 fast-follow). All future integration specs use `createTestDatabase()` helper.

**Related files:** [[infrastructure]] "Test DB management" section; `apps/api/src/__tests__/integration/helpers/test-db.ts`; `bedrock/Views/audits/platform-audit-2026-06-15.md` §11 (Phase 7.10.2 entry).
