# Current Focus

**Status (2026-06-30): 21/41 audit findings closed. Phase A (Correctness) complete.**  
Phase A exit review pending before authorizing Phase B.

Pre-beta audit closed 10 dimensions. Phase 1 fixed the settlement TOCTOU gap. Phase 2 added CSRF middleware + ticket cap. Phase 3 added DB indexes + env cleanup. Phase 8.8 closed Finding #40.

**⚠️ Correction**: The platform-audit-2026-06-22.md header claimed "All 41 findings now closed." Systematic codebase verification on 2026-06-29 found only 18 of 41 numbered findings confirmed closed. The §12 remediation log was incomplete. See §12 in the audit file for per-finding breakdown.

**Current Focus Status:** 21 closed out of 41 total ($\frac{21}{41} = 51.2\%$). Phase A closed #8 (Redis), #10 (Revenue SQL), and added observability infrastructure. Core money flow Criticals #1 and #2 remain resolved.

**Next:** Phase A exit review → Phase B (Reliability).

## Completed this session (2026-06-30)

| Phase | Changes |
|---|---|
| **Phase A1 — Revenue SQL refactor** (#10) | `groupByMonth` in `revenue.service.ts` refactored from ternary-based `$1`/`$2` arithmetic to `clauses[] + params[]` accumulation. Behavioral identical. |
| **Phase A2 — Redis client separation** (#8) | Split `redis-client.ts` into `getRedisClient()` (HTTP: `maxRetriesPerRequest: 5`, `connectTimeout: 10s`, exponential-backoff `retryStrategy`) and `getQueueConnection()` (BullMQ: `maxRetriesPerRequest: null`). Worker `redis.ts` gained `connectTimeout` + `retryStrategy`. |
| **Phase A3 — Backend observability** | Enhanced `GET /api/v1/health/ready` with Redis PING + Prisma `SELECT 1`. Added `GET /api/v1/metrics/queues`. Added structured logging to RevenueService. |

## What's next

**High-priority open findings — mapped to roadmap phases:**

| Finding | Phase | Gate |
|---------|-------|------|
| **#7** — Prisma pool env-var | B1 | Telemetry evidence |
| **#9** — DNS rebinding pipelining | B2 | Exploit test |
| **#5** — QueueService init race | B3 | None |
| **#11** — Enum-drift static specs | C2 | — |
| **#12** — CASCADE→SetNull | C2 | — |
| **#13** — Key-rotation runbook | C2 | — |
| **#14** — Body-cap structured log | C1 | — |
| **#15** — Healthchecks | C3 | — |
| **#17** — Postgres:17 workflow | C3 | — |
| **#18** — Recon dedup per-sweep | C1 | — |

**Medium findings:** Phase C4–C6 bundles. See `backlog.md` and `docs/ENGINEERING_ROADMAP.md`.

**Backlog:**

- Phase B1 — Prisma pool env-var (telemetry-gated)
- Phase B2 — DNS rebinding pipelining (exploit-test-gated)
- Phase B3 — QueueService init race
- Phase C1–C6 — Operational tuning bundles
- Phase D — Post-beta scaling
