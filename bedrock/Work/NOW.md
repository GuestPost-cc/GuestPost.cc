# Current Focus

**Status (2026-07-05): 31/41 audit findings confirmed closed. Sprint 1A + Sprint 2A + Sprint 2B + Sprint 2C + Sprint 2D + Sprint 2E completed.**
Next: Sprint 3 (worker tests + documentation) or Sprint 4 (DB CHECK constraints).

## Evidence-Driven Engineering Assessment (2026-07-02)

Completed a comprehensive code-first due diligence with automated counts and file:line evidence for every material claim.

### Automated Repository Counts
| Metric | Count |
|--------|-------|
| Prisma models | 61 |
| API routes | 206 |
| Auth guards | 5 |
| Worker processors | 10 |
| Frontend pages | 61/62 |
| API test files | 32 |
| Worker test files | **0** |
| Integration specs | **7** |
| $transaction call sites | ~35 |

### Key Corrections Applied
The June-22 audit §12 remediation log had 6 stale entries:
- **#8 (Redis)** — §12: OPEN. CODE: CLOSED (Phase A2 split client + timeouts at `redis-client.ts:7-30`)
- **#9 (DNS rebinding)** — §12: OPEN. CODE: CLOSED (Sprint 1A `pipelining: 0` at `safe-fetch.ts:115`)
- **#10 (Revenue SQL)** — §12: OPEN. CODE: CLOSED (Phase A1 `clauses[]`/`params[]` at `revenue.service.ts`)
- **#16 (DATABASE_URL flag)** — §12: OPEN. CODE: CLOSED (Phase 3 `# REQUIRED` comment at `.env.example:11`)
- **#17 (CI postgres)** — §12: OPEN. CODE: CLOSED (Sprint 1B `postgres:17-alpine` in pr.yml + main.yml)
- **#19 (JWT_SECRET)** — §12: OPEN. CODE: CLOSED (Phase 3 human-readable default at `.env.example`)

### Scoring Methodology
Each dimension scored 0-100 as weighted composite: Correctness 25%, Completeness 20%, Resilience 15%, Observability 15%, Testing 15%, Documentation 10%.

| Dimension | Score | Status |
|-----------|-------|--------|
| Financial Integrity | 95 | ✅ Ready |
| Security | 85 | ✅ Ready |
| Backend API | 85 | ✅ Ready |
| Database | 75 | ⚠️ Mostly Ready |
| Workers | 80 | ⚠️ Mostly Ready |
| Frontend | 88 | ✅ Ready |
| Testing | 60 | ⚠️ Mostly Ready |
| Infrastructure | 55 | ❌ Needs Work |
| CI/CD | 85 | ✅ Ready |
| **Overall** | **74** | **Beta Ready** |

### Top 5 Critical Risks (all with file:line evidence)
1. **CRIT-001**: Pool hardcoded at 25 (`prisma.service.ts:19`) — no `PRISMA_POOL_MAX` env var
2. **CRIT-003**: No CHECK constraints (`schema.prisma:530-700`) — zero DB-level financial invariants
3. **CRIT-004**: No key rotation (missing from `bedrock/Memory/infrastructure.md`)
4. **CRIT-006**: No worker test files (0 worker tests across 10 processors)
5. **CRIT-007**: Linting checks don't enforce TypeScript `strict` mode

## Completed this session (2026-07-05)

| Track | Changes |
|---|---|
| **Sprint 1A — Worker shutdown hardening** | Added 30s timeout guard + Redis `connection.quit()` + shutdown-complete log to `apps/worker/src/index.ts:312-359` |
| **Sprint 1A — DNS rebinding guard** | Added `pipelining: 0` to `SAFE_LOOKUP_AGENT` at `packages/shared/src/safe-fetch.ts:115` — closes audit #9 |
| **Sprint 1B — CI Postgres consolidation** | Changed `postgres:16` → `postgres:17-alpine` in `pr.yml:21` + `main.yml:20` — closes audit #17 |
| **Sprint 2A — Financial integration tests** | 6 new integration specs + FinancialFixture builder (6 files, 452 lines). Factories extended with `makePublisher`, `makeWallet`, `makeTransaction`, `makeSettlement`, `makeOrderItem`, `makeOrderDeliveryVersion`. |
| **Sprint 2B — Worker + mailpit healthchecks** | Added `HEALTHCHECK` to `apps/worker/Dockerfile` (`wget` to configurable `/health` endpoint, matching API pattern). Added `healthcheck` to mailpit in `docker-compose.yml` (`/readyz` endpoint). `wget` confirmed present in `axllent/mailpit:latest`. Dockerfile syntax validated (`docker build --check`). Compose config validated. Unit tests: 55 suites / 699 tests all green. Lint: clean. Closes audit #15. |
| **Sprint 2C — Payout encryption key rotation runbook** | Created `payout-encryption.constants.ts` with `CURRENT_PAYOUT_KEY_VERSION = 1` (single source of truth for service + verifier). Created `scripts/verify-encryption-versions.ts` — runtime verifier that groups encrypted rows by version, asserts supported set `[0, 1]`, sample-decrypts via real `PayoutEncryptionService`. Added key rotation runbook to `bedrock/Memory/infrastructure.md` (soft/hard rotation, backfill, post-rotation checklist). Added `PAYOUT_ENCRYPTION_KEY` to `.env.example`. Updated `payout-encryption.service.ts` to import constant from module. Verifier validated against local DB. Closes audit #13. |
| **Sprint 2D — Prisma pool env var + validation** | Added `PRISMA_POOL_MAX` env var controlled via `parsePoolMax()` in `createPrismaClient.ts` — validates non-integer/zero/negative at call time, `console.warn` on > 25. `prisma.service.ts` no longer hardcodes `max: 25`. Pool sizing section + formula in `bedrock/Memory/infrastructure.md`. `PRISMA_POOL_MAX` in `.env.example` with formula comment. 7 new tests in `phase-13-pool-config-validation.spec.ts`. Closes audit #7 (Critical) + #30 (Medium). |
| **Sprint 2E — Structured logger context sanitization** | Added `makeReplacer()` with ancestor-stack `WeakMap` — detects true cycles without false positives on shared refs. Error instances serialize as `{ name, message, stack, code?, cause? }` with stack ≤ 2048 chars. Long strings (>4KB) truncated. `truncateContext()` enforces 8KB budget via per-field accounting; drops excess fields + reports `__logTruncated: { droppedFields, maxBytes }`. Both JSON + pretty mode protected. 13-test regression suite. Closes audit #31 (Medium). |

## What's next

**Candidate sprints (unordered):**
- **Sprint 2B**: Remaining 6 integration tests (deposit→pay→settle→release edge cases, Marketplace order settlement) + pool env-var (`PRISMA_POOL_MAX`)
- **Sprint 3**: Worker test infrastructure + 10 processor unit tests + OpenAPI doc generation
- **Sprint 4**: DB CHECK constraints on money columns, key rotation runbook, testing dimension (aim for 70+)
