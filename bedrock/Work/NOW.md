# Current Focus

**Status (2026-06-29): 18/41 audit findings closed (#1-#41). 19 open, 0 partial, 4 unchecked.**

Pre-beta audit closed 10 dimensions. Phase 1 fixed the settlement TOCTOU gap. Phase 2 added CSRF middleware + ticket cap. Phase 3 added DB indexes + env cleanup. Phase 8.8 closed Finding #40 — `cancelExecution` two-phase commit.

**⚠️ Correction**: The platform-audit-2026-06-22.md header claimed "All 41 findings now closed." Systematic codebase verification on 2026-06-29 found only 18 of 41 numbered findings confirmed closed. The §12 remediation log was incomplete. STATUS.md, NOW.md, and the audit file have been updated to reflect the true state. The claim appears to have overreached — several findings have no code changes at all (e.g. #8 Redis client, #9 DNS rebinding, #17 CI postgres drift). See §12 in the audit file for per-finding breakdown.

## Completed this session (2026-06-29)

| Area | Changes |
|---|---|
| **Phase 3 Operational Safety (1,3,4)** | Added `@@index([userType, banned])` and `@@index([walletId, type])` composite indexes. Removed orphaned `next: ^16.2.7` from root package.json. Marked `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` with `# REQUIRED` in `.env.example`. |
| **Fix: root next removal** | Added `next: ^15.0.0` to `packages/ui` (imported `next/navigation` implicitly via hoisting). Regenerated `pnpm-lock.yaml`. Amended commit to fix CI. |
| **Phase 7.10.2.1 — CI integration tests** | `test-db.ts`: capability-based Docker detection (no `docker exec` in CI). `ci.yml` + `pr.yml`: idempotent template-DB creation + migrate + verify + `test:integration` step. Closes audit Critical #6. |
| **Phase 8.8 — `cancelExecution` two-phase commit** | Restructured to Tx1(claim)→provider→Tx2(finalize) with version chain. Added version guard to `completeExecution`/`failExecution` in worker. Closes audit Finding #40. |

## What's next

**High-priority open findings (Critical + High):**

- **#7** (Critical) — Prisma pool hardcoded `max: 25`, no env-var override. Production-blocker at scale-up.
- **#8** (High) — Redis client no `connectTimeout`, no `retryStrategy`, `maxRetriesPerRequest: null`. Cascading hang on Redis outage.
- **#9** (High) — safe-fetch shared Agent with `pipelining: 0` absent. DNS rebinding bypass on pool-reused connections.
- **#10** (High) — Revenue raw-SQL `$1`/`$2` param-index ternary brittle to range-resolution refactor.
- **#11** (High) — Partial-unique WHERE clauses on Settlement + FulfillmentAssignment have no enum-drift guard.
- **#12** (High) — Notification/TicketMessage userId still non-nullable with `NoAction` — User deletion fails with FK violation.
- **#13** (High) — No key-rotation runbook in infrastructure.md. No backfill spec for encrypted rows.
- **#14** (High) — Delivery body-cap catch block uses `logger.warn` without `reason: 'body_size_exceeded'`.
- **#15** (High) — mailpit in docker-compose has no healthcheck; worker Dockerfile has no HEALTHCHECK.
- **#17** (High) — pr.yml and main.yml still use postgres:16 while production and ci.yml use postgres:17-alpine.
- **#18** (High) — Reconciliation dedup hitcount logged as cumulative, not per-sweep.

**Medium findings (18 total, most still open):**
- **#20** raw `<img>` in 4 portal marketplace files
- **#21** Duplicate `statusVariant()` in admin dashboard + orders
- **#22** `publisherAmount` zero-value semantics undocumented
- **#23** No bare `@@index([customerId])` on Order
- **#24** No `@db.Timestamptz` on createdAt columns
- **#27** Job-signing dev fallback uses `console.warn`
- **#31** Structured-logger has no context-size cap
- **#32** turbo.json `SENTRY_AUTH_TOKEN` has no inline rationale
- **#36** PRODUCTION_RUNBOOK worker-fleet check is manual
- **#37** Repeatable-job-registry drift guard is spec-only (no boot-time assertion)
- **#25**, **#26**, **#30**, **#33** — not yet verified

**Backlog:**

- **Phase 7.10.2.x** — Convert Phase 7.12 favorites manual-smoke race to integration spec.
- **Phase 8.12** — Operational resilience bundle (#8 Redis timeouts, #9 DNS-rebinding pool-reuse guard).
