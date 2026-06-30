# Engineering Roadmap v1.0 — GuestPost Platform

**Status (2026-06-30): Audit 18/41 closed → Phase A (Correctness) complete.**  
Phase B begins after Phase A exit review.

---

## Phase A — Correctness ✅ DONE

| Phase | Finding | Description | Verification |
|-------|---------|-------------|-------------|
| **A1** | #10 | Revenue SQL: `clauses[] + params[]` refactor — removed brittle ternary-based `$1`/`$2` parameter arithmetic in `groupByMonth` | 693 tests pass |
| **A2** | #8 | Redis: separate HTTP (`maxRetriesPerRequest: 5`) and BullMQ (`maxRetriesPerRequest: null`) clients with `connectTimeout`, `retryStrategy` | 693 tests pass |
| **A3** | — | Observability: API `/health/ready` with dependency checks, `/metrics/queues` endpoint, RevenueService structured logging | 693 tests pass |

## Phase B — Reliability (next)

| Phase | Finding | Description | Dependencies |
|-------|---------|-------------|--------------|
| **B1** | #7 | Prisma pool env-var + telemetry-based sizing | Telemetry evidence |
| **B2** | #9 | DNS rebinding `pipelining: 0` guard | Reproducible exploit test |
| **B3** | #5 | QueueService init race fix | None |

## Phase C — Operational Tuning

| Phase | Findings | Description |
|-------|----------|-------------|
| **C1** | #14, #18 | Worker observability gaps |
| **C2** | #11, #12, #13 | Database hardening + runbook |
| **C3** | #15, #17, #19 | Infra/CI cleanup |
| **C4** | #20, #21, #22, #31 | Frontend polish |
| **C5** | #23, #24, #32 | Index + schema maintenance |
| **C6** | #27, #36, #37 | Logging + runbook hygiene |

## Phase D — Post-Beta Scaling

- Double-entry ledger
- Item-level settlements
- Provider-side payout reconciliation
- WebsiteVerification gate
- Order deadline auto-cancel

---

## Constraints

1. Every change must include regression tests.
2. No infrastructure tuning without measurable justification.
3. Phase A must complete before Phase B begins.
4. Phase A exit review required before authorizing Phase B.
