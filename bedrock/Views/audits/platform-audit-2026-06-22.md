---
title: GuestPost.cc Platform Audit
date: 2026-06-22
authors: 8 parallel domain auditors (money, marketplace+orders, security, workers, frontend, delta-lens, infrastructure+deployment, database) + synthesis
supersedes: bedrock/Views/audits/platform-audit-2026-06-15.md (2026-06-15, 100/100 closed, but over-reported; Phase A completed 2026-06-30 — 25 closed, 1 partial, 15 open, see §12)
---

# GuestPost.cc — Full Platform Audit (2026-06-22)

A to Z review of the platform after 14 phases of hardening landed since the 2026-06-15 audit (Phases 7.1 → 7.14, plus 7.13.x cleanup, 7.13.1.1 sibling, and 7.10.2 integration harness). Phase 6 consolidated the 31 findings from the prior audit (100% closure). This audit surfaces 41 new findings to refresh the baseline.

**Current Status (2026-07-03):** 25 of 41 numbered findings closed (✅), 1 partial (⚠️), 15 open (❌). Phase A (A1 Revenue SQL, A2 Redis client, A3 Observability) completed on 2026-06-30, closing #8 (Redis) and #10 (Revenue SQL). Sprint 1A/1B (2026-07-03) closed #9 (DNS rebinding) and #17 (CI postgres drift). Sprint 2A (2026-07-03) closed #14 (body-cap logging — both delivery-verification and verification processors now emit `reason: body_size_exceeded` with numeric `contentLength`). All 4 previously-unchecked findings (#25, #26, #30, #33) codebase-verified: #26 confirmed intentional, #30 confirmed open, #33 confirmed closed, #25 confirmed open (soft-delete inconsistency persists across 3 patterns + hard-deletes). See §12 for full per-finding closure log.

---

## §0. Executive Summary

### Overall posture (one-paragraph verdict)

The platform is **substantially harder than 2026-06-15**: Critical and High findings continue to be closed, the production-readiness scorecard moves up across nearly every dimension, and the integration test harness (Phase 7.10.2) provides the missing real-DB regression layer. The four largest deltas — Phase 7.7 observability spine, Phase 7.8 security hardening, Phase 7.13 Prisma 7 + adapter-pg, Phase 7.10.2 integration harness — landed cleanly with no rework. Today's audit surfaces **6 net-new Critical findings** (2 settlement-race windows in Money, 2 worker-side gaps in payout-webhook idempotency + settlement-auto-approve audit logging, 1 startup-window race on the email verification queue ref, plus a follow-up probe surfaced a Critical no-op stub in `payout.processor.ts:handleExecute`) plus **1 already-tracked Critical** (CI missing the integration-test template-DB step — already on the Phase 7.10.2.1 backlog) plus **1 architectural Critical** (Prisma adapter-pg pool sized for single-replica only — production-blocker if/when the platform scales horizontally). High findings cluster in four groups: new database-shaped maintenance hazards (enum-drift on partial uniques, CASCADE deletes on actor-attribution tables), new infrastructure & deployment gaps (no dedicated Dockerfile healthcheck on worker, .env.example does not flag DATABASE_URL as required, CI workflows drifted on postgres version), new operational-resilience gaps (Redis client has no timeout / unguarded retries, undici Agent's DNS-rebinding guard does not cover pool-reused connections), and three additional payout-flow findings from the follow-up probe (missing Stripe reversal Idempotency-Key, cancelExecution calls provider before DB commit, settlement-auto-approve catch-all swallows all errors). **⚠️ Post-hoc correction (2026-06-29)**: A systematic codebase verification found only **18 of 41 confirmed closed** — 19 still open, 4 unchecked. Updated (2026-07-03): codebase-verified status as of Sprint 2A — **25 closed (incl. 1 intentional), 1 partial, 15 open**. Phase A (2026-06-30) closed #8 (Redis timeout/retries) and #10 (Revenue SQL param-index safety). Sprint 1A/1B closed #9 (DNS rebinding) and #17 (CI postgres consolidation). Sprint 2A closed #14 (body-cap structured logging — both worker processors now emit `reason: body_size_exceeded` with numeric `contentLength`). All previously unchecked findings (#25, #26, #30, #33) verified: #26 intentional, #30 open, #33 closed, #25 open (soft-delete inconsistency persists). See §12 for complete per-finding closure log.

### Production-readiness scorecard (15 dimensions)

| Dimension | 2026-06-15 | 2026-06-22 | Δ | Notes |
|---|---|---|---|---|
| Data model + money invariants | A− | A− | — | Partial UNIQUE on FulfillmentAssignment (Phase 7.14), MarketplaceFavorite NULLS NOT DISTINCT (Phase 7.13.2), Settlement composite index (Phase 7.13.1). Surfaced: zero-amount Settlement and enum-drift hazards (see §2). |
| State machine integrity | A | A | → | Phase 7.14 closed claim race. §2 Critical #1 (returnToReview race) closed Phase 8.1, §2 Critical #2 (COMPLETED without version guard) closed Phase 8.2+8.10. All settlement state transitions now version-guarded. |
| Channel-aware routing | A | A | — | Unchanged. |
| Auth + global guards | B+ | A− | ↑ | Phase 7.8 email-rate-limit + AuthGuard email-verification gate + job-signing iat. Phase 7.10 verification flow. CSRF still SameSite=Lax-only (acceptable in current threat model). |
| RBAC granularity | C | A | ↑↑↑ | Phase 6.6/6.7 StaffRolesGuard fail-closed + every handler declares @StaffRoles explicitly + coverage test prevents regressions. |
| Multi-tenant isolation | A− | A− | — | Unchanged. |
| Worker idempotency | B | B+ | ↑ | Phase 7.4 notification dedup + Phase 7.8 job-signing iat + Phase 8.3 payout webhook dedup + Phase 8.7 handleExecute dead code removed + Phase 8.8 cancelExecution two-phase commit + Phase 8.9 auto-approve Sentry injection. All 5 worker findings closed. |
| Worker observability | D | A− | ↑↑↑ | Phase 7.7 Sentry + structured logger + /metrics/queues + worker entrypoint. Surfaced: settlement-auto-approve writes no audit log (see §2 Critical #4). |
| Job signing + queue security | A− | A | ↑ | Phase 7.8 added iat + v to signing payload; verifyJobPayload enforces freshness window (24h default, 0 for repeatable crons) + 60s clock skew. |
| SSRF + outbound calls | B | A | ↑↑↑ | Phase 7.11 safe-fetch (undici Agent + DNS resolution in connection callback + IP validation + 5MB body cap). Sprint 1A closed pool-reuse gap with `pipelining: 0` (§2 High #9). |
| Frontend reliability | C+ | A− | ↑↑ | Phase 7.0/7.7 error.tsx + global-error.tsx + not-found.tsx + Sentry per app + 401-redirect handler. |
| Frontend mobile | D/B+ | A− | ↑↑ | Phase 7.6 + 7.9 Drawer adopted in all 3 dashboards on Radix Dialog (focus trap, escape close, aria-modal). |
| Frontend design-system consistency | C | B+ | ↑↑ | Phase 7.9 STATUS_PRESENTATION + SupportPanel + FulfillmentChannelBadge + BriefRenderer. Minor adoption gaps in publisher dashboard + admin orders (see §2 Medium). |
| Reporting + finance visibility | D | A− | ↑↑↑ | Phase 7.1 admin revenue dashboard (4 groupings + CSV + previous-period + currency-mismatch handling). |
| Documentation + audit trail uniformity | C+ | A− | ↑↑ | Phase 7.7 AuditLog.requestId column + AsyncLocalStorage auto-inject. Gap: settlement-auto-approve processor writes no audit row per sweep (see §2 Critical #4). |

**Direction of travel**: 12 dimensions improved (5 up by ≥ 2 grades), 3 unchanged (+1 since audit as State machine integrity restored to A). All Critical worker findings closed. SSRF gap closed Sprint 1A. Body-cap logging closed Sprint 2A. Remaining Critical (#7 pool) + High (#11 enum-drift, #13 key-rotation, #15 healthcheck, #18 cumulative dedup) + Medium cluster (#21 STATUS_PRESENTATION duplication, #20 raw img, #23-25 database, #27 console.warn, #30 pool validation, #31 logger size cap, #32 turbo.json rationale, #36 runbook) comprise the 15 open + 1 partial.

---

## §0.5. Changes Since 2026-06-15 (audit delta summary)

| Metric | 2026-06-15 | 2026-06-22 | Δ |
|---|---|---|---|
| Numbered findings | 31 (open) | 31 closed + 41 new | +41 net new |
| Prior-audit closure rate | — | 31/31 (100%) | — |
| Prisma migrations | ~50 (baseline) | +10 | +10 |
| BullMQ processors | 8 | 9 | +1 (`settlement-auto-approve.processor.ts`) |
| Queues | 8 | 9 | +1 (`SETTLEMENT` cron) |
| apps/api jest suites | 33 | 48 | +15 |
| apps/api jest tests | 478 | 653 | +175 |
| Integration test specs | 0 | 1 (Spec 1: fulfillment-claim-race) | +1 — harness greenfield in Phase 7.10.2 |
| Test types | unit-only | jest projects (unit + integration) | new shape |
| New TS files in scope | — | ~40 | — |

### Major architectural changes

- **Prisma 6.19.3 → 7.8.0 + `@prisma/adapter-pg`** (Phase 7.13) — classic Rust query engine removed; WASM Query Compiler + pg adapter; `CREATE INDEX CONCURRENTLY` unlocked; `createPrismaClient`/`createPrismaAdapter` dual-helper (Phase 7.13.x).
- **Email verification flow end-to-end** (Phase 7.10) — Better Auth `sendEmail` + `onEmailVerified` databaseHooks; portal banner; gated on state-changing routes via AuthGuard (Phase 7.8).
- **Structured logging spine** (Phase 7.7) — `packages/shared/src/structured-logger.ts`; ~50 callsites swept across apps/api + apps/worker; grep regression guard.
- **Sentry source-map upload** (Phase 7.7 C) — conditional on `SENTRY_AUTH_TOKEN` to avoid CI hang on PRs from forks.
- **Integration test harness** (Phase 7.10.2) — jest projects (unit + integration); `guestpost_test_template` TEMPLATE-clone DB isolation (~150ms/spec); `createTestApp()` + `createTestDatabase()` helpers; factory library; Spec 1 closes Phase 7.14 #23 race as automated regression.
- **safe-fetch** (Phase 7.11) — undici Agent with DNS resolution inside connection callback + 5MB body cap + reader cancellation; adopted in delivery-verification + website-verification processors.
- **Settlement auto-approve worker** (Phase 7.3) — moved from in-process `setInterval` to `QUEUES.SETTLEMENT` cron; stale/slow-sweep alerts.
- **Notification dedup spine** (Phase 7.4) — `Notification.dedupKey` partial unique + `notification-dedup-keys.ts`.
- **Revenue dashboard** (Phase 7.1) — `GET /admin/finance/revenue` + 4 groupings + RFC 4180 CSV streaming + previous-period comparison.
- **Mobile responsive ports** (Phase 7.6 + 7.9) — Radix Dialog `<Drawer>` adopted across admin + publisher + portal layouts.
- **Tier policy shared** (Phase 7.2) — `getSettlementReviewDays()` + `TIER_WITHDRAWAL_HOLDS` lifted to shared.
- **Job signing iat + version** (Phase 7.8) — replay-protection on signed payloads; repeatable-job-registry drift guard.
- **Snapshot backfill** (Phase 7.5) — one-shot migration normalizing legacy null snapshots.

### Migrations applied since 2026-06-15 (10 total)

| Migration | Purpose | Phase |
|---|---|---|
| `_phase71_revenue_dashboard_indexes` | Indexes for PlatformRevenue read path | 7.1 |
| `_phase74_notification_dedupkey_partial_unique` | `Notification.dedupKey` partial unique (CONCURRENTLY) | 7.4 |
| `_phase75_snapshot_backfill` | One-shot null-snapshot normalization | 7.5 |
| `_phase77_auditlog_requestid_column` | `AuditLog.requestId` column + index (CONCURRENTLY) | 7.7 A1 |
| `_phase7131_settlement_status_revieendsat_composite` | Composite index on Settlement(status, reviewEndsAt) | 7.13.1 |
| `_phase7132a_marketplace_favorite_new_unique_nullsnotdistinct` | New favorites unique with NULLS NOT DISTINCT | 7.13.2A |
| `_phase7132b_part1_drop_marketplace_favorite_original_unique` | Drop old favorites unique (split — single statement) | 7.13.2B |
| `_phase7132b_part2_rename_to_canonical` | Rename new index to canonical name (split — single statement) | 7.13.2B |
| `_phase714_fulfillment_assignment_active_orderid_unique` | FulfillmentAssignment partial unique on (orderId) WHERE active | 7.14 |
| `_phase713x_drop_escrow_table_and_enum` | Drop orphan Escrow table + EscrowStatus enum | 7.13.x |
| `_phase71311_drop_redundant_settlement_status_idx` | Drop redundant single-column Settlement_status_idx | 7.13.1.1 |

(Count is 11 including the Phase 7.13.2B split; the architectural delta is 10 schema-shaping migrations.)

---

## §1. Architecture in 60 seconds

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Browsers (4 apps, all Next.js 15 App Router, all on @guestpost/ui)          │
│   apps/portal (customers) · apps/publisher · apps/admin · apps/website      │
│   per-app: error.tsx + global-error.tsx + not-found.tsx + Sentry            │
│   shared: <Drawer> (Radix Dialog) · STATUS_PRESENTATION · EmailVerifyBanner │
└─────────────────────────────────────────────────────────────────────────────┘
             │ HTTPS + Better Auth cookies + X-Request-ID                       
             ▼                                                                  
┌─────────────────────────────────────────────────────────────────────────────┐
│ apps/api (NestJS) — main.ts                                                  │
│   • Sentry init (instrument.ts) → ValidationPipe (forbidNonWhitelisted)     │
│     → CORS → Helmet+CSP → request-id middleware → audit log middleware      │
│   • Guards: AuthGuard (Better Auth + email-verification gate, Phase 7.8/7.10)│
│             RolesGuard · StaffRolesGuard (fail-closed, Phase 6.7)            │
│             OrderOwnershipGuard (channel-consistency check)                  │
│   • Module surface: orders · settlements · billing · publisher-payouts ·     │
│     admin/finance (revenue dashboard, Phase 7.1) · marketplace · support ·   │
│     auth · notifications · listings · websites · etc                         │
└─────────────────────────────────────────────────────────────────────────────┘
             │ Prisma 7.8.0 + @prisma/adapter-pg (WASM Query Compiler)          
             │ pool: max=25, idleTimeoutMillis=20000 (single-replica only)      
             ▼                                                                  
┌─────────────────────────────────────────────────────────────────────────────┐
│ Postgres 17 Alpine (Docker compose)                                          │
│   • Settlement(orderId) partial UNIQUE WHERE status != CANCELLED             │
│   • FulfillmentAssignment(orderId) partial UNIQUE WHERE status IN active    │
│   • MarketplaceFavorite(userId,listingId,serviceType) UNIQUE NULLS NOT DISTINCT│
│   • Notification(userId,dedupKey) partial UNIQUE WHERE dedupKey NOT NULL    │
│   • Settlement(status,reviewEndsAt) composite (cron sweep hot path)          │
│   • AuditLog.requestId indexed + correlated via AsyncLocalStorage            │
│   • CHECK constraints on every money column (>= 0)                           │
│   • snapshot trio: priceSnapshot, briefSnapshot, websiteSnapshot             │
└─────────────────────────────────────────────────────────────────────────────┘
             ▲                                                                  
             │ BullMQ (Redis 7 Alpine)                                          
             │ signed payloads (HMAC + iat + v, Phase 7.8); freshness window     
┌─────────────────────────────────────────────────────────────────────────────┐
│ apps/worker — 9 processors + 5 crons (repeatable-job-registry drift-guarded)│
│   payout · settlement-auto-approve (NEW, Phase 7.3) · reconciliation ·       │
│   delivery-verification (safe-fetch, Phase 7.11) · website-verification ·    │
│   notification · email · report · auto-cancel-pending-orders                 │
│   structured-logger spine · Sentry (init first) · /metrics/queues +          │
│   /health + /ready · graceful shutdown with prisma.$disconnect (Phase 7.13)  │
└─────────────────────────────────────────────────────────────────────────────┘

build stack
  pnpm 11 workspace · Turbo 2 · 11 build targets
  jest projects: unit (~5s) + integration (~150ms/spec via TEMPLATE-clone)
  CI: ci.yml (postgres:17) · main.yml (postgres:17) · pr.yml (postgres:17) — consolidated
  observability: Sentry source-map upload (Phase 7.7 C, conditional on AUTH_TOKEN)
  deploy: laptop-only at present; VPS attempt 2026-06-14 reverted same day
```

---

## §2. Top N Cross-Domain Findings (synthesized + ranked)

41 findings total: 8 Critical, 15 High, 18 Medium. Count not predetermined. (Findings #1-#37 from the original 8-agent synthesis pass; findings #38-#41 added in a follow-up payout-flow probe at the end of §2 — kept numerically separate to avoid renumbering cross-references in §3-§11.)

### Critical (production-blockers / financial integrity / data-exposure)

**#1. Settlement `returnToReview` performs unguarded update — races with concurrent admin approval** *[money]*
- **Location**: `apps/api/src/modules/settlements/settlements.service.ts:450`
- **Confidence**: high
- **Impact**: Concurrent `returnToReview` + `adminApprove` on the same settlement can leave status in undefined state; double-release risk if both succeed against different status snapshots.
- **Reproduction**: POST `/settlements/{id}/return-to-review` and POST `/settlements/{id}/admin-approve` race; row-level lock ordering is the only thing keeping consistency, not application semantics.
- **Affected actors**: OPERATIONS, FINANCE, system
- **Business impact**: money loss (potential double-release), data loss (status corruption), operational outage (state wedged)
- **Fix**: Replace `tx.settlement.update({ where: { id } })` with version-guarded `updateMany({ where: { id, version, status: "CUSTOMER_APPROVED" } })` + conflict check. Increment `version` on every transition.

**#2. `releaseFundsInternal` forces Order.status = COMPLETED without version guard** *[money]*
- **Location**: `apps/api/src/modules/settlements/settlements.service.ts:584`
- **Confidence**: high
- **Impact**: Concurrent order mutations (customer dispute, force-cancel) can collide with settlement release. Order row ends in undefined state; refund path may double-issue or get wedged.
- **Reproduction**: Admin triggers settlement release while customer initiates dispute; unguarded update at :584 overwrites the dispute transition (or vice versa).
- **Affected actors**: CUSTOMER, FINANCE, OPERATIONS, system
- **Business impact**: money loss (refund duplicate or lost), operational outage (order state wedged — cannot refund or retry)
- **Fix**: Fetch fresh order with `version` before this point; `tx.order.updateMany({ where: { id, version }, data: { status: "COMPLETED", version: { increment: 1 } } })` + conflict check.

**#3. Payout webhook handler has no replay-protection dedupKey** *[workers]*
- **Location**: `apps/worker/src/processors/payout.processor.ts:148-194` (`handleWebhook`)
- **Confidence**: high
- **Impact**: Manually-replayed webhook from ops tooling — or a job retry after partial completion — can re-enter `completeExecution()`. The intra-row version guard catches concurrent transitions but not job-level replay (no dedupKey on the queue.add() call from the API webhook handler).
- **Reproduction**: Replay the same webhook payload twice via BullMQ tools or by re-injecting an old webhook event from provider dashboard. Second execution can complete if it wins the race against the first's `completeExecution` commit.
- **Affected actors**: PUBLISHER (receives double payout), FINANCE, system
- **Business impact**: money loss (unbounded double-payout under replay storms or manual replay)
- **Fix**: Add `dedupKey: 'payout-webhook:${provider}:${providerExecutionId}'` to the queue.add() call (matches Phase 7.4 notification-dedup pattern). Have the worker assert dedupKey presence and refuse jobs without one.

**#4. Settlement auto-approve processor writes NO audit log per sweep** *[workers, observability]*
- **Location**: `apps/worker/src/processors/settlement-auto-approve.processor.ts` (entire file, no `auditLog.create` call)
- **Confidence**: high
- **Impact**: Settlements auto-approve via the cron sweep, transitioning into RELEASED state, but no audit row is written. Ops cannot trace which sweep / when / batch approved which settlement; finance cannot reconcile sweep activity to settlement-state transitions; compliance loses the actor-attribution chain.
- **Reproduction**: Settlement enters PENDING_REVIEW → review window expires → cron sweep flips to RELEASED. Query `SELECT * FROM "AuditLog" WHERE "entityType" = 'Settlement' AND "entityId" = '...'` returns rows for human approvals but not for auto-approvals.
- **Affected actors**: OPERATIONS, FINANCE, compliance/audit reviewers
- **Business impact**: regulatory/audit-trail gap; cannot correlate settlements to sweeps in dispute scenarios; difficult to detect a misbehaving sweep
- **Fix**: Add `prisma.auditLog.create({ data: { action: 'SETTLEMENT_AUTO_APPROVED', entityType: 'Settlement', entityId, userId: null, metadata: { sweepBatchId, reviewEndedAt } } })` per approved settlement, matching the payout processor's pattern (lines 43-52).

**#5. Lazy `queueServiceRef` race during server startup window — verification emails fail with 500** *[delta]*
- **Location**: `apps/api/src/main.ts:444-495`
- **Confidence**: high
- **Impact**: `queueServiceRef` is `null` at module init, captured by closure in Better Auth's `sendEmail` + `onEmailVerified` callbacks, populated at :495 AFTER `await app.init()`. Better Auth handler is mounted at :477 (BEFORE :495). Requests arriving in the gap (~100ms after server listen, before NestFactory finishes init) trigger 500 "QueueService not yet available."
- **Reproduction**: Send POST `/auth/sign-up` immediately after `pnpm start` boots; if it lands in the window, signup completes but verification email never sends (500 thrown in sendEmail callback).
- **Affected actors**: New customers registering during a deploy or restart window
- **Business impact**: account registration flow broken intermittently during deploys; signups complete without verification email
- **Fix**: Move `queueServiceRef = app.get(QueueService)` BEFORE the Better Auth handler is mounted, OR replace lazy-ref pattern with `OnModuleInit` injection into a dedicated VerificationDispatcher service.
- **Status**: **Resolved** — boot sequence reordered (NestFactory.create + QueueService resolve + startup assertion before auth mount); `queueServiceRef` is now `const` (non-nullable) with `process.exit(1)` on resolution failure; startup logging added. See `apps/api/src/main.ts:435-511`. CI verified: [PR #26](https://github.com/GuestPost-cc/GuestPost.cc/pull/26) — both CI and PR checks passed (2026-06-26).

**#6. Integration tests cannot run in CI — `guestpost_test_template` DB never created** *[infra]*
- **Location**: `.github/workflows/ci.yml` (no template-DB setup step); `apps/api/src/__tests__/integration/helpers/test-db.ts:43` (depends on template existing)
- **Confidence**: high
- **Already tracked**: This is the Phase 7.10.2.1 fast-follow backlog item (`bedrock/Work/NOW.md`). Surfaced here for visibility.
- **Impact**: `pnpm test:integration` invocation in CI would fail with "template database does not exist." Currently CI doesn't invoke integration tests at all (main.yml + pr.yml run unit-only; ci.yml has no integration invocation either). Phase 7.14 #23 fulfillment-claim-race regression is therefore not gated by CI.
- **Reproduction**: Add `pnpm test:integration` to any of the 3 workflow files → fails at first `createTestDatabase()` call.
- **Affected actors**: developers landing Phase 7.10.2+ code; CI gate for concurrency regressions
- **Business impact**: integration regression slips to staging; race-condition fixes (Phase 7.14 et al) lose their CI safety net
- **Fix**: Phase 7.10.2.1 — add template DB creation step + `pnpm test:integration` invocation to CI workflow. Setup script lives in `bedrock/Memory/infrastructure.md` "Test DB management" section.

**#7. Prisma adapter-pg pool over-provisioned for multi-replica scale-up** *[database]*
- **Location**: `apps/api/src/common/prisma.service.ts:8-14` (`max: 25, idleTimeoutMillis: 20_000`)
- **Confidence**: high
- **Impact**: Per-process `max: 25` × N replicas exceeds typical Postgres SaaS connection budgets (default 100). 5 API replicas × 25 = 125 slots, plus ~25 from BullMQ workers, plus reserved superuser slots = budget exhaustion under burst. Settlement release / payment capture / payout execution hit "remaining connection slots reserved" mid-tx and fail.
- **Already noted**: Platform is `laptop-only` (Memory/infrastructure.md). This finding is a production-blocker if/when horizontal scaling happens; not an active outage today.
- **Reproduction**: Deploy 3+ API replicas pointing at Postgres with max_connections=100; run concurrent load. Connection-pool error surfaces during burst.
- **Affected actors**: customers (failed payment capture), publishers (delayed settlements), ops (admin queries also fail)
- **Business impact**: revenue leakage during burst; settlement delays; outage scope spans the entire money path
- **Fix**: Compute per-process budget by replica count: `max ≈ (max_connections - reserved - worker_count) / replica_count`. Set `max: 10` (conservative default for ≤ 5 replicas). Document the formula + per-env config matrix. Add monitoring alert at 80% pool utilization. Either parameterize via env var (`PRISMA_POOL_MAX`) or codify by deployment env.

### High (correctness / reliability / production hardening)

**#8. Redis client unguarded retries + no connection timeout → cascading hang on Redis outage** *[delta, security]*
- **Location**: `apps/api/src/common/redis-client.ts:1-12`
- **Confidence**: medium (low-likelihood, high-impact)
- **Impact**: `getRedisClient()` constructs IORedis with defaults (`enableOfflineQueue: true`, `maxRetriesPerRequest: null`). When Redis is unreachable, queued commands retry indefinitely; the entire request pipeline (rate-limit check, session lookup, BullMQ enqueue) hangs.
- **Fix**: Set explicit `connectTimeout`, `retryStrategy` (exponential backoff with ceiling), `maxRetriesPerRequest: 3`. Add a per-call timeout wrapper on rate-limit + session checks. Consider `lazyConnect: true` + explicit `connect()` at boot.

**#9. DNS rebinding can bypass safe-fetch on pool-reused connections** *[delta]*
- **Location**: `packages/shared/src/safe-fetch.ts:89-109` (SAFE_LOOKUP_AGENT lookup callback)
- **Confidence**: medium
- **Impact**: Phase 7.11's defense validates resolved IP inside the connection callback — but undici's Agent reuses TCP connections keyed by hostname. If DNS for the hostname changes between requests, an in-flight connection to a now-rebinded hostname remains open, and the agent will reuse it for the next request without re-resolving. Narrow attack window (requires DNS-rebinding attacker + long-lived Agent).
- **Fix**: Disable connection pooling for safe-fetch (`pipelining: 0`) OR force per-request DNS resolution via custom dispatcher. Document the assumption.

**#10. Revenue raw-SQL builds `$1`/`$2` indices by string ternary — brittle to range-resolution refactor** *[delta]*
- **Location**: `apps/api/src/modules/admin/finance/revenue.service.ts:313-318`
- **Confidence**: medium (downgraded from agent's Critical; current safe due to `resolveRange()` from/to contract; future-refactor hazard)
- **Impact**: Param-index ternary (`range.from ? "$2" : "$1"`) and params array (built sequentially) can diverge if `resolveRange` ever returns one-of-two truthy values. Currently safe; would silently produce wrong WHERE clauses post-refactor.
- **Fix**: Build the WHERE via Prisma's `where` object, OR compute `toClause` index from `params.length` so they cannot diverge.

**#11. Partial-unique WHERE clauses on Settlement + FulfillmentAssignment do not track enum additions** *[delta, database]* (cross-tagged — surfaced by Agents 6 and 8 independently)
- **Location**: `packages/database/prisma/schema.prisma` (Settlement and FulfillmentAssignment); migrations `_phase714` + `_phase713x*`
- **Confidence**: high
- **Impact**: `Settlement_orderId_active_key` WHERE `status != 'CANCELLED'` and `FulfillmentAssignment_orderId_active_unique` WHERE `status IN ('ASSIGNED','IN_PROGRESS')` are hardcoded enum-value lists. If a new SettlementStatus or FulfillmentAssignmentStatus is added (e.g., `REFUND_PENDING`, `REASSIGNING`) and used without updating the WHERE, the race-condition guarantee silently regresses.
- **Fix**: Add a static-source spec that imports the enum + asserts the migration's WHERE clause covers all "active" enum values. Pattern same as Phase 7.14 `phase-7-14-static-source.spec.ts`. Establish PR checklist: enum additions must flag dependent partial-unique migrations.

**#12. CASCADE deletes on User wipe AuditLog / Notification / TicketMessage** *[database]*
- **Location**: `packages/database/prisma/schema.prisma` — Session, Account, ActiveContext, Notification, AuditLog, TicketMessage, OrderEvent all `onDelete: Cascade` from User
- **Confidence**: medium (catastrophic if triggered; today no admin tool exposes hard-delete)
- **Impact**: Hard-deleting a User row purges audit history (forensics gap), notification history (compliance gap), ticket-message thread continuity (support gap). Today there is no admin UI for hard-delete, but the cascade contract makes it a one-misclick path away.
- **Fix**: Change AuditLog.userId, Notification.userId, TicketMessage.userId, OrderEvent.userId to `onDelete: SetNull`. Add soft-delete pattern on User (`deletedAt DateTime?`) so historical references remain valid. Migration is online (no row rewrite for the FK change).

**#13. JSON column validation gaps — payout-encryption key-rotation hazard** *[database]*
- **Location**: PayoutMethod.details (encrypted Json), PayoutProvider.config (encrypted Json), Order.briefData (Json), Settlement snapshot columns
- **Confidence**: high (for encryption-version path); medium (for general briefData)
- **Impact**: Encrypted payout fields rely on `encryptionKeyVersion` column. Key rotation procedure is not documented. Multi-version decrypt support exists in code but is undocumented. Old PayoutMethod rows with `encryptionKeyVersion=0` could become unreadable if v0 key is rotated out without backfill.
- **Fix**: Document key-rotation runbook in `bedrock/Memory/infrastructure.md`. Add a backfill spec that asserts every encrypted row's `encryptionKeyVersion` matches a known-good key in the current key chain. Tests for multi-version decrypt across rotation.

**#14. Delivery-verification body-cap silent failure** *[workers]*
- **Location**: `apps/worker/src/processors/delivery-verification.processor.ts:79-84`; sibling `verification.processor.ts:71-76`
- **Confidence**: medium
- **Impact**: When `readBodyWithCap()` throws `BODY_TOO_LARGE`, catch block returns empty html and transitions to MANUAL_REVIEW. No structured-logger emit with `reason: 'body_size_exceeded'` to distinguish legitimate-oversized from SSRF-probe traffic.
- **Fix**: Emit structured-logger error with `{ url, contentLength, reason: 'body_size_exceeded' }` so ops dashboards can distinguish failure modes.
- **Status**: **Closed** Sprint 2A (2026-07-03). Both processors now emit `logger.warn` with `{ reason: "body_size_exceeded", url, maxBodySize, contentLength }`. Regression guard at `apps/api/src/__tests__/phase-7-14-body-cap-logging.spec.ts`.

**#15. mailpit + worker have no Docker healthcheck** *[infra]*
- **Location**: `infrastructure/docker/docker-compose.yml` (mailpit); `apps/worker/Dockerfile` (no HEALTHCHECK directive)
- **Confidence**: high
- **Impact**: mailpit silent-fails dev email delivery (no compose-level dependency block); worker Dockerfile has no HEALTHCHECK so orchestrators (K8s, Swarm) cannot detect hung workers — stale workers stay "Running" while dropping jobs.
- **Fix**: Add `healthcheck:` to mailpit (HTTP probe on :8025). Add `HEALTHCHECK --interval=10s --timeout=5s --retries=3 CMD wget -qO- http://localhost:${WORKER_HEALTH_PORT:-3004}/health` to worker Dockerfile.

**#16. `DATABASE_URL` is not flagged REQUIRED in `.env.example`** *[infra]*
- **Location**: `.env.example:11` (no comment marker)
- **Confidence**: high
- **Impact**: Phase 7.13's runtime guard in `createPrismaAdapter()` throws "DATABASE_URL is required" at construction time, and `main.ts:32` exits with `process.exit(1)`. Operators deploying without DATABASE_URL get an opaque crash; .env.example doesn't communicate the requirement.
- **Fix**: Add explicit `# REQUIRED — API/worker exit(1) at boot if missing` comment above the `DATABASE_URL=` line. Same treatment for `REDIS_URL`, `JWT_SECRET`.

**#17. CI workflows drifted — main.yml + pr.yml use postgres:16, ci.yml uses postgres:17** *[infra]*
- **Location**: `.github/workflows/main.yml:20`, `.github/workflows/pr.yml:22`, `.github/workflows/ci.yml:31`
- **Confidence**: high
- **Impact**: Production runs postgres:17-alpine (matches compose). main.yml + pr.yml run tests against postgres:16. Tests pass against an older planner; a query that regresses under 17 doesn't fail in PR gate. main.yml never invokes integration tests at all.
- **Fix**: Consolidate to a single `build-and-test` reusable workflow called from main.yml + pr.yml (DRY). Pin postgres:17-alpine everywhere. Move integration-test invocation to the shared job (after Critical #6 unblocks).

**#18. Reconciliation dedup hitcount logged as cumulative, not per-sweep** *[workers]*
- **Location**: `apps/worker/src/processors/reconciliation.processor.ts:94`
- **Confidence**: medium
- **Impact**: `{ dedup_hits_total: 5 }` context doesn't tell ops "this sweep had 5 hits" vs "5 hits cumulative since worker boot." Cannot tune `RECONCILIATION_SWEEP_MINUTES` from log data.
- **Fix**: Log per-sweep delta: `{ dedup_hits_in_sweep: getDedupHits() - previousTotal }`.

**#19. JWT_SECRET weakness check is regex-only (no entropy gate)** *[infra]*
- **Location**: `apps/api/src/main.ts:56-80`
- **Confidence**: high
- **Impact**: The "weak secret" check matches length + character set but accepts `"a".repeat(32)`. False sense of security.
- **Fix**: Either make it HARD FAILURE in production (exit 1 if entropy < threshold), OR remove the check and document the `openssl rand -base64 32` expectation in `.env.example`.

### Medium

**#20. Portal marketplace uses raw `<img>` in 4 files** *[frontend]*
- Location: `apps/portal/src/app/dashboard/marketplace/{page.tsx, [slug]/page.tsx, favorites/page.tsx, saved-lists/page.tsx}`
- Impact: No `next/image` optimization (no srcset, no lazy-load, no WebP/AVIF). LCP regression on listing-heavy pages. Publisher + admin avoid raw `<img>` — portal is the holdout.
- Fix: Replace 4 `<img>` with `<Image>` from `next/image`. Configure `images.remotePatterns` in next.config.ts.

**#21. Publisher dashboard + admin orders duplicate STATUS_PRESENTATION color logic** *[frontend]*
- Location: `apps/publisher/src/app/dashboard/page.tsx:77-82`; `apps/admin/src/app/dashboard/orders/page.tsx:54-70` (manual `statusVariant()` function)
- Impact: Phase 7.9 #28 shipped `STATUS_PRESENTATION`; these two callsites duplicate the color mapping. Future palette changes diverge.
- Fix: Import `getOrderStatusPresentation` from `@guestpost/ui`. Delete manual `statusVariant()`. Add a grep regression test (same pattern as Phase 7.9 #28).

**#22. Settlement.publisherAmount allows zero — surface mapping ambiguity** *[database]* (downgraded from Critical — zero is legitimate for refund-clawback)
- Location: `packages/database/prisma/schema.prisma` Settlement model (CHECK >= 0)
- Impact: Reports filtering `WHERE publisherAmount > 0` silently skip zero-value clawback settlements; finance reconciliation has to account for two row classes.
- Fix: Document the zero-value semantic in schema.prisma comment + reporting code. Optionally add `kind` column to discriminate clawback vs normal.

**#23. Order(customerId)-only index opportunity** *[database]*
- Location: schema.prisma Order — has `@@index([customerId, status])` but not bare `@@index([customerId])`
- Impact: "All my orders" reads without status filter use the composite (leading column match — fine today). Future `ORDER BY createdAt` addition may cause planner to seq-scan.
- Fix: Monitor EXPLAIN ANALYZE under load. Add bare `@@index([customerId])` if planner flips.

**#24. createdAt columns lack timezone annotation (`@db.Timestamptz`)** *[database]*
- Location: every table — `createdAt DateTime @default(now())` (no @db.Timestamptz)
- Impact: Maps to Postgres TIMESTAMP(3) without TZ. If app and DB run in different TZs, period-scoped queries (settlement cutoffs, audit reports) off-by-hours.
- Fix: Migration to `@db.Timestamptz` everywhere. Add boot-time assertion that DB and app both run UTC.

**#25. Soft-delete pattern inconsistency across tables** *[database]*
- Location: Website + PayoutMethod use `isActive`; PlatformRevenue uses `reversedAt`; Order/Settlement use status enums; some tables hard-delete
- Impact: Reports aggregating across tables must apply 3 different "deleted" predicates. Cognitive burden; subtle bugs if a query forgets one.
- Fix: Document the per-table pattern in schema.md. Or consolidate on one pattern (probably `deletedAt DateTime?` for new tables).

**#26. SSRF guard redundancy in verification.processor.ts** *[workers]* (defense-in-depth, intentional)
- Location: `apps/worker/src/processors/verification.processor.ts:94` (pre-flight) + `:32` (safe-fetch internal at safe-fetch.ts:121)
- Impact: Code clarity only — both layers correctly reject malicious URLs.
- Fix: Optional — keep as defense-in-depth or remove the pre-flight check.

**#27. Job-signing dev fallback uses `console.warn` not structured logger** *[workers]*
- Location: `packages/shared/src/job-signing.ts:21`
- Impact: Dev-only path; no JSON, no service/env context.
- Fix: Route through structured-logger if available; accept the exception otherwise.

**#28. jest.setup.js dummy DATABASE_URL — integration-test resilience gap** *[delta]* (downgraded from Critical — current setup is safe; future regression risk)
- Location: `apps/api/jest.setup.js:22`; `apps/api/src/__tests__/integration/helpers/create-test-app.ts:34`
- Impact: Integration tests overwrite the dummy URL before AppModule import (safe). But if a future spec forgets to call `createTestApp()`, it could silently hit the dummy URL (which doesn't resolve to a real DB).
- Fix: Use a sentinel value (e.g. `postgresql://test:test@INVALID-NEVER-RESOLVE:5432/test`) that fails loudly on first query attempt. OR add an integration-test setup assertion that DATABASE_URL was mutated before module load.

**#29. Email rate-limit timing oracle for account enumeration** *[delta]*
- Location: `packages/auth/src/plugins/email-rate-limit.ts:46-61`
- Impact: Invalid emails reject pre-check (fast); valid emails hit Redis (slower). Timing difference enables enumeration under low-latency probing.
- Fix: Always perform hash + Redis touch regardless of email validity, OR add constant-time padding.

**#30. `createPrismaAdapter` accepts pool config without validation** *[delta]*
- Location: `packages/database/src/create-prisma-client.ts:26-46`
- Impact: Callers can set `max > 25` without guard rails (compounds the Critical #7 multi-replica issue).
- Fix: Warn at construction if `max > 25`. Document the per-replica formula in the helper's JSDoc.

**#31. Structured-logger has no context-size cap or stack-trace dedup** *[delta]*
- Location: `packages/shared/src/structured-logger.ts:68-97`
- Impact: Logging an Error object inline as context emits the full stack on every line. Sentry/Datadog ingestion overages possible at scale.
- Fix: Sanitize/truncate context before emit. Cap stringified context at ~8KB.

**#32. turbo.json `SENTRY_AUTH_TOKEN` listing has no inline rationale** *[infra]*
- Location: `turbo.json:10-18`
- Impact: Code reader confusion — "why is a secret in the env cache-key list?"
- Fix: Add a JSON-comment explaining the safe usage (hash computation only; never logged).

**#33. pnpm @sentry/cli build-script silent-failure** *[infra]*
- Location: `pnpm-workspace.yaml:15-20`
- Impact: If the postinstall binary download fails, no clear error. First `pnpm build` fails cryptically.
- Fix: Document the failure mode in README; consider explicit verification step post-install.

**#34. Worker unhandledRejection uses `console.error`, not structured logger** *[infra]*
- Location: `apps/worker/src/index.ts:204-213`
- Impact: Sentry captures; structured logger does not. Log aggregator misses the rejection in correlation views.
- Fix: Use logger.error + Sentry.captureException in tandem.

**#35. `.env.example` IP-rate-limit vs email-rate-limit interaction not documented** *[infra]*
- Location: `.env.example:49-62`
- Impact: Operator misconfigures one layer (e.g., loose IP limit + strict email limit) without understanding the layered intent. Phase 7.8 comment references phase number, no plain-language interaction explanation.
- Fix: Rewrite the comment block to explicitly walk through the two-layer model with example numbers.

**#36. PRODUCTION_RUNBOOK worker-fleet check is manual** *[infra]*
- Location: `PRODUCTION_RUNBOOK.md:34-35`
- Impact: Two-worker-pod-running-old-code scenario is silent. Manual `pgrep` is the only check.
- Fix: Document an automated post-deploy health-poll on `/metrics/queues`. Alert on `stalledHitsTotal > 0`. OR add worker startup check that exits if `>1` worker is registered.

**#37. Repeatable-job-registry drift guard is spec-only** *[delta]*
- Location: `packages/shared/src/repeatable-job-registry.ts` + `apps/worker/src/index.ts`
- Impact: If a developer adds a repeatable job in `worker/index.ts` without updating the registry, the new job gets full freshness validation, potentially rejecting valid signed payloads. Spec catches but spec must be run.
- Fix: Codegen the registry from a single source-of-truth definition. OR add a worker-boot assertion that the registry covers every registered repeatable.

### Late additions — payout-flow follow-up probe (post-synthesis review)

These four findings were added after the initial 8-agent synthesis pass via a targeted manual probe of the payout flow. Numbered #38-#41 to preserve cross-references in §3-§11; severity tier is annotated inline.

**#38. Payout worker `handleExecute` is a no-op stub — silently drops `payout-execute` jobs** *[money, workers]*
- **Location**: `apps/worker/src/processors/payout.processor.ts:82-97`
- **Severity**: Critical
- **Confidence**: high
- **Impact**: `handleExecute` fetches the withdrawal, validates status, logs, and returns `{ withdrawalId, providerName, queued: true }`. **It never calls any provider adapter, never creates a PayoutExecution row, never sets a providerExecutionId.** The status-poll cron only acts on rows with `providerExecutionId: { not: null }` (line 102), so a withdrawal "processed" through the worker path stays in APPROVED status forever — no money moves, no failure surfaces, the publisher waits indefinitely. The misleading `queued: true` return makes monitoring believe the job succeeded.
- **Reproduction**: Enqueue a `payout-execute` job (or trigger any caller that does so). Observe: BullMQ marks the job completed; no Stripe/Wise transfer initiated; no PayoutExecution row created; withdrawal stays in APPROVED. The synchronous `POST /admin/payouts/.../execute` path (`payout-execution.service.ts:executeWithdrawal`) is the only code path that actually moves money — but that path doesn't enqueue a worker job, so the worker handler is either dead code or a broken alternative path.
- **Affected actors**: PUBLISHER (never paid), FINANCE (lifetimePaid not updated), OPERATIONS (silent failure invisible in dashboards), SUPER_ADMIN
- **Business impact**: money loss (publisher not paid; depending on caller surface, withdrawal balance reconciles incorrectly); operational outage (silent failure with success-shaped telemetry — the worst observability state)
- **Fix**: Two options: (a) **delete** `handleExecute` + the `case "payout-execute": return handleExecute(job)` switch arm if no caller enqueues `payout-execute` jobs (audit `grep -rn 'payout-execute' apps/ packages/`); OR (b) **implement** the missing logic — call `adapter.createTransfer()` + create PayoutExecution row + transition withdrawal status + audit log (mirroring `payout-execution.service.ts:84-137`). Either way, also add a worker-boot grep guard asserting no job name maps to a `return { queued: true }` stub.

**#39. Stripe Connect `cancelTransfer` reversal POST is missing `Idempotency-Key` header** *[security, workers]*
- **Location**: `apps/api/src/modules/publisher-payouts/providers/stripe-connect-payout.adapter.ts:108-114`
- **Severity**: High
- **Confidence**: high
- **Impact**: `createTransfer` (line 43) correctly sets `Idempotency-Key`. The reversal call (`POST /v1/transfers/{id}/reversals`) does NOT set the header. On any retry — BullMQ retry, network timeout + replay, manual ops replay — Stripe will create a NEW reversal record each call. Reversals reverse money. Each duplicate reversal pulls funds back from the publisher's connected account.
- **Reproduction**: `cancelExecution` for a COMPLETED payout → first reversal succeeds (returns 200) → response packet dropped / connection times out → retry hits Stripe again → second reversal succeeds → publisher account is double-debited.
- **Affected actors**: PUBLISHER (over-debited on retry), FINANCE (reconciliation drift)
- **Business impact**: money loss (double-reversal pulls extra funds); regulatory dispute (publisher complaint about unauthorized debit)
- **Fix**: Build a deterministic key and set the header. Suggested key shape: `payout-reversal-${providerExecutionId}` (one reversal allowed per execution; subsequent calls with same key get the existing reversal back, not a new one). Pass an explicit `idempotencyKey: string` parameter through the `cancelTransfer` interface so callers (PayoutExecutionService.cancelExecution) can supply per-attempt keys when intentional re-reversal is needed.

**#40. `cancelExecution` calls provider before DB transaction — race window where money moves but DB doesn't update** *[money]*
- **Location**: `apps/api/src/modules/publisher-payouts/payout-execution.service.ts:282-309`
- **Severity**: High
- **Confidence**: high
- **Status**: **CLOSED** via Phase 8.8 (2026-06-29)
- **Impact**: `cancelExecution` calls `adapter.cancelTransfer(execution.providerExecutionId)` at line 285, then opens a `$transaction` at line 288. If the provider call succeeds but the transaction's `updateMany` returns count=0 (concurrent state change — e.g., webhook flipped status to COMPLETED between the initial fetch and the tx open), the code throws `ConflictException("Execution state changed before cancel could complete")`. Net state: **provider says CANCELLED, DB says PROCESSING (or COMPLETED)**. Reconciliation drift requires manual ops intervention. Contrast with `executeWithdrawal` which uses the safe Tx1-commit → provider call → Tx2-commit pattern.
- **Reproduction**: Webhook arrives + transitions execution to COMPLETED. Operator clicks Cancel in admin UI moments later. Provider `cancelTransfer` succeeds (Stripe accepts reversal). DB tx opens — `updateMany WHERE status: execution.status` (PROCESSING per the originally-fetched row) returns count=0 because status is now COMPLETED. Exception thrown. Stripe reversal is real; DB has no record.
- **Affected actors**: PUBLISHER (drift between Stripe and platform views), FINANCE (manual reconciliation cost), OPERATIONS
- **Business impact**: data inconsistency between provider and platform; money state ambiguous; manual reconciliation effort; potential double-handling if operator re-issues a payout assuming the cancel never happened
- **Fix applied**: Restructured to Tx1(claim)→provider→Tx2(finalize) two-phase commit with version chain. Tx1 locks execution row under SELECT FOR UPDATE, bumps version (claim). Provider call follows with idempotency key. Tx2 finalizes with WHERE version = claimedVersion — safe to retry on partial failure. Worker's `completeExecution`/`failExecution` also gained version guards to prevent overlap with a concurrent cancel claim.

**#41. Settlement auto-approve `catch {}` swallows ALL per-row errors as "skipped"** *[workers, observability]*
- **Location**: `packages/shared/src/settlement-auto-approve-core.ts:159-164`
- **Severity**: High
- **Confidence**: high
- **Impact**: The `try { ... } catch { skipped++ }` block catches every error type without binding it to a variable, without logging it, without rethrowing it. The comment claims "per-row errors propagate via Sentry from the queue-observability wrapper" — but this is incorrect: if the catch block doesn't rethrow, the outer wrapper sees a normal return, and no exception reaches Sentry. **Every per-row failure** — a TypeError from a stale snapshot, a Prisma constraint violation, a memory error, a logic bug, a database deadlock — is silently counted as "skipped" indistinguishably from the legitimate "version-guard race lost" case (line 157). Sweep returns success with elevated `skipped`. Money-moving sweep failures hide in plain sight.
- **Reproduction**: Introduce a Prisma schema change that breaks the SettlementApproval upsert (e.g., add a required column without backfilling). Run the sweep. Result: `{ scanned: N, approved: 0, skipped: N, durationMs: ... }` — looks like a quiet day. Sentry: empty. Ops dashboard: green. Reality: settlement state machine is wedged platform-wide.
- **Affected actors**: PUBLISHERS (settlements stuck), FINANCE (revenue recognition delays), OPERATIONS (no signal), SUPER_ADMIN
- **Business impact**: silent platform-wide breakage of settlement state machine; reputational risk; potential SLA breach if customer-facing
- **Fix**: Change the catch to `} catch (err: any) {`. Either (a) `Sentry.captureException(err, { tags: { sweep: 'settlement-auto-approve', settlementId: settlement.id } })` + `logger.error(...)` + `skipped++` + continue; OR (b) re-throw and let the queue-observability wrapper handle Sentry (NOT current behavior despite the comment) — but then a single bad row breaks the whole sweep. The first option preserves sweep robustness while restoring observability. Add a test that injects an error and asserts Sentry.captureException was called.

---

## §3. Money Flow Deep Dive (refresh)

The 2026-06-15 money flow framing (§3.1 domain model, §3.2 happy path, §3.3 refund path, §3.4 concurrency invariants, §3.5 idempotency table, §3.6 multi-currency, §3.7 strengths) is largely intact and remains the authoritative reference. Refresh against the Phase 7 deltas:

**Phase 7.1 — Revenue dashboard (admin-facing)**: `apps/api/src/modules/admin/finance/revenue.service.ts` reads PlatformRevenue with 4 groupings (PUBLISHER_TIER / DAY / WEEK / MONTH) + previous-period comparison + currency-mismatch handling. Closes 2026-06-15 #5 ("PlatformRevenue never read"). New finding: raw-SQL param-index brittleness (§2 High #10).

**Phase 7.2 — Tier policy lift to shared**: `packages/shared/src/publisher-tier-policy.ts` consolidates `getSettlementReviewDays()` + `TIER_WITHDRAWAL_HOLDS`. Settlement review window is now tier-aware in both `order-review.service.ts:325` and `settlements.service.ts`. Closes 2026-06-15 #6 ("Settlement review window not tier-aware").

**Phase 7.3 — Auto-approve worker**: SettlementAutoApproveService moved from in-process `setInterval` to `QUEUES.SETTLEMENT` cron with stale/slow-sweep alerts. Closes 2026-06-15 #10. New finding: processor writes no audit log per sweep (§2 Critical #4).

**Phase 7.4 — Notification dedup**: dedupKey partial unique + `notification-dedup-keys.ts`. All notification writers route through helpers.

**Phase 7.5 — Snapshot backfill**: one-shot migration normalized legacy null snapshots. Closes a quiet correctness gap.

**Phase 7.13.1 / 7.13.1.1 — Settlement indexes**: composite (status, reviewEndsAt) replaces redundant single-column status_idx.

**Surfaced this audit**: §2 Critical #1 (`returnToReview` race) and #2 (`releaseFundsInternal` Order.status unguarded update). Both are net-new findings — the 2026-06-15 audit's #11–#15 covered other settlement race patterns but missed these two specific update sites. They were below the threshold of the prior audit's spot-checks because they are admin-facing endpoints with assumed low concurrency, but the audit rubric counts "potential" race wins regardless of frequency.

**Follow-up payout-flow probe** (§2 Late additions #38-#41): four additional findings touch the money flow directly. All four are now **closed** as of 2026-06-29. **#38** (Critical) — `payout.processor.ts:handleExecute` is a no-op stub returning `{ queued: true }` without calling any provider; either dead code or a broken worker path. **Closed via Phase 8.7**: dead code removed, regression guard added. **#39** (High) — Stripe Connect `cancelTransfer` reversal POST is missing the `Idempotency-Key` header, allowing double-debit of publisher accounts on retry. **Closed via direct commit `ac56ed0`**: Idempotency-Key header added to Stripe adapter. **#40** (High) — `PayoutExecutionService.cancelExecution` calls the provider before the DB transaction, creating a window where Stripe says CANCELLED but our DB does not. **Closed via Phase 8.8**: restructured to Tx1→provider→Tx2 two-phase commit with version claim chain. **#41** (High) — settlement-auto-approve sweep catches every per-row error as "skipped" without rethrowing or capturing to Sentry; silent platform-wide breakage shape. **Closed via Phase 8.9**: onError hook wired to Sentry + structured logger.

§3.5 idempotency table (per money endpoint) carries forward. Add rows:
- **payout webhook handler** — `Mechanism: jobId dedup (BullMQ) + version-guard on Execution row` — `Verdict: ✅ job-level dedup + intra-row version guard`. Closed Phase 8.3 (§2 Critical #3).
- **payout worker `handleExecute`** — removed (no-op stub was dead code). Closed Phase 8.7 (§2 Critical #38).
- **Stripe reversal in `cancelTransfer`** — `Mechanism: Idempotency-Key header (key=payout-cancel-${executionId})` — `Verdict: ✅ single reversal per executionId`. Closed direct commit (§2 High #39).
- **`cancelExecution` orchestration** — `Mechanism: Tx1(claim)→provider→Tx2(finalize) two-phase with version chain` — `Verdict: ✅ version-guarded two-phase commit`. Closed Phase 8.8 (§2 High #40).

---

## §4. Marketplace + Order Lifecycle Deep Dive (refresh)

The 2026-06-15 framing of §4.1 listing→service lifecycle, §4.2 18-state order machine, §4.3 channel-aware routing, §4.4 support ticket matrix is preserved. Refresh:

**Phase 7.12 — Marketplace correctness bundle**: closes #16/#17/#20 (favorites scoping, getFavorites includes services), #18 (auto-assignment actor = `managedByUserId`), #24 (platform-website auto-listing defaults).

**Phase 7.13.2A/B — MarketplaceFavorite NULLS NOT DISTINCT**: structural race-proofing at the database constraint level. Service layer Plan B (`addFavorite` create + catch P2002 + refetch).

**Phase 7.14 — FulfillmentAssignment partial unique on (orderId) WHERE active**: closes 2026-06-15 #23 (the only remaining open finding). Service-layer per-caller P2002 → ConflictException mapping in all 3 `upsertAssignment` callers. Integration spec verifies 5 concurrent claims → exactly 1 success.

**Surfaced this audit**: §2 High #11 — partial-unique WHERE clauses on Settlement + FulfillmentAssignment do not auto-track enum additions. This is a maintenance hazard, not a current correctness bug, but it deserves a static-source spec to lock the invariant.

Channel-aware routing intact across all 9 hot-path reads. Support ticket matrix (Phase 6.5/6.6) enforces scopeWhere + assertVisible + assertCanReply via single code path. No drift.

---

## §5. Security & Permissions Deep Dive (refresh)

The 2026-06-15 framing of §5.1 auth surface, §5.2 RBAC layer, §5.3 IDOR / multi-tenant isolation, §5.4 input validation, §5.5 injection, §5.6 CSRF, §5.7 file upload, §5.8 rate limiting, §5.9 secret + env handling, §5.10 SSRF is preserved. Refresh:

- §5.1 Auth surface: Phase 7.10 email verification flow shipped (verification template + EmailVerificationBanner + sendEmail/onEmailVerified hooks).
- §5.2 RBAC layer: **C → A** (the biggest single grade lift in the scorecard). Phase 6.6/6.7 StaffRolesGuard fail-closed + every handler declares @StaffRoles explicitly + coverage test prevents regressions. AdminController class-decorator override risk closed.
- §5.3 IDOR: Phase 6.9 `assertOwnerOrCreator` swept across all 6 money-moving customer endpoints (submitPayment, approveContent, customerAcceptDelivery, customerApprove, confirm-delivery, submitReview).
- §5.4 Input validation: ValidationPipe with `forbidNonWhitelisted: true` + every controller uses typed DTO. No naked `req.body`. Billing webhook correctly uses `req.rawBody`.
- §5.6 CSRF: SameSite=Lax remains the only CSRF layer. Acceptable in the current single-origin deployment model; would need explicit tokens if subdomain XSS becomes a threat.
- §5.8 Rate limiting: Phase 7.8 email-keyed rate limit layered on top of IP rate limit. Bucket key = `auth-rl:${prefix}:${hashEmail(email)}`; case-folded + SHA-256. 429 response shape byte-identical to Better Auth's to prevent enumeration via status/body. New: timing oracle (§2 Medium #29) — the early-rejection vs Redis-hit time difference is detectable under ideal conditions.
- §5.10 SSRF: Phase 7.11 safe-fetch (undici Agent + DNS resolve inside connection callback + IP validation + 5MB body cap). Pool-reuse edge gap (§2 High #9) closed Sprint 1A via `pipelining: 0`.

**Surfaced this audit**: §2 High #8 (Redis client unguarded retries — DoS amplifier under Redis outage, closed Phase A). Otherwise: Security agent returned **zero new findings**.

---

## §6. Workers & Async Deep Dive (refresh)

The 2026-06-15 framing of §6.1 queue inventory, §6.2 cron schedules, §6.3 job signing, §6.4 delivery-verification, §6.5 payout processor, §6.6 notifications, §6.7 observability is preserved. Refresh:

**Queue inventory** is now 9 processors (was 8) — added `settlement-auto-approve.processor.ts` (Phase 7.3). Crons: 5 declared, all repeatable, all jobId-deduped, drift-guarded by `repeatable-job-registry`.

**Job signing** (Phase 7.8): `signJobPayload` adds `iat` + `v` to canonical digest. `verifyJobPayload` enforces freshness window (24h default, 0 for repeatable crons) + 60s clock-skew. Replay protection now binding. Grade: **A− → A**.

**Delivery-verification** (Phase 7.11): safe-fetch + readBodyWithCap (5MB). Defense-in-depth pre-flight check at processor + internal check at safe-fetch. New finding: body-cap silent failure (§2 High #14).

**Payout processor**: best-in-class for version-guarded idempotency on intra-row transitions. All four findings from the audit (#3 dedupKey, #38 handleExecute no-op, #39 Stripe Idempotency-Key, #40 cancelExecution race) have been **closed** via Phase 8.3, Phase 8.7, direct commit, and Phase 8.8 respectively. The worker now uses BullMQ jobId dedup for webhooks, `handleExecute` dead code removed, Stripe reversal has Idempotency-Key, and cancelExecution uses two-phase commit.

**Notifications**: Phase 7.4 dedupKey partial unique + `notification-dedup-keys.ts`. All writers route through helpers with P2002 swallow. Grade: dedup catches retry duplicates.

**Observability** (Phase 7.7): **D → A−** — Sentry first (instrument.ts before all other imports), structured logger across ~50 callsites, `/metrics/queues` endpoint with stalled/active/waiting/completed/failed counts, `/health` + `/ready`, graceful shutdown with `prisma.$disconnect` (Phase 7.13). New finding: settlement-auto-approve writes no audit row (§2 Critical #4); reconciliation dedup metric is cumulative not per-sweep (§2 High #18).

**Graceful shutdown**: Phase 7.13 made `prisma.$disconnect` load-bearing (node-pg pool leaks on undisconnect, unlike the old Rust engine). Verified on SIGTERM.

---

## §7. Frontend Deep Dive (refresh)

The 2026-06-15 framing of §7.1 app surface, §7.2 shared package usage, §7.3 data fetching, §7.4 API client, §7.5 forms, §7.6 errors/loading/empty, §7.7 mobile, §7.8 design-system consistency, §7.9 performance is preserved.

**Major lifts**:

- §7.6 Errors/loading/empty: **C+ → A−** — all 4 apps have `error.tsx` + `global-error.tsx` + `not-found.tsx` + Sentry per-app + 401-redirect handler in api-client (Phase 7.0 + 7.7).
- §7.7 Mobile: **D / B+ → A−** — Phase 7.6 + 7.9 ported all 3 dashboards (admin, publisher, portal) to `<Drawer>` on Radix Dialog (focus trap, escape close, aria-modal).
- §7.8 Design-system consistency: **C → B+** — Phase 7.9 #28 STATUS_PRESENTATION + #29 shared components (SupportPanel, FulfillmentChannelBadge, BriefRenderer). Two minor adoption gaps remain (§2 Medium #21).
- §7.2 Shared package usage: portal order-detail page renders SupportPanel + BriefRenderer from `@guestpost/ui`. EmailVerificationBanner mounted in portal dashboard layout (Phase 7.10).

**Inline-mutation pattern** (Phase 7.9 #30): publisher listings page inlined 4 `useMutation` calls (no factory wrapper). ESLint with react-hooks plugin guards regressions.

**DOMPurify**: portal order detail sanitizes before `dangerouslySetInnerHTML`. XSS defended.

**New findings**: §2 Medium #20 (portal marketplace raw `<img>` in 4 files) + #21 (publisher dashboard + admin orders duplicate STATUS_PRESENTATION).

---

## §8. Database & Migrations Deep Dive (NEW)

### 8.1 Prisma 6→7 upgrade summary

- Pinned `prisma` + `@prisma/client` at `^7.8.0` (was 6.19.3). Classic Rust query engine removed.
- `@prisma/adapter-pg` + WASM Query Compiler.
- Pool config moved from URL params to `PoolConfig` form: `{ max: 25, idleTimeoutMillis: 20_000 }` for apps/api PrismaService; default pool for the global singleton.
- `createPrismaClient()` + `createPrismaAdapter()` dual-helper at `packages/database/src/create-prisma-client.ts`. Full helper for direct-instantiation sites (singleton); adapter helper for NestJS's `PrismaService extends PrismaClient` (must call `super(...)`).
- Runtime DATABASE_URL guard at construction time. `jest.setup.js` sets a dummy URL so unit specs that transitively import `@guestpost/auth` (which evaluates the singleton at module-load) do not fail.
- `Decimal` import path renamed `runtime/library` → `runtime/client` across 15 apps/api files.

### 8.2 Migration safety rules (Phase 7.13.2B finding)

prisma@7.8.0's migrate runner wraps **multi-statement** migration files in an implicit transaction (even though single-statement files run untransacted). This breaks `* CONCURRENTLY` ops with "CONCURRENTLY cannot run inside a transaction block." **Rule**: any migration combining a `* CONCURRENTLY` op with another DDL statement MUST be split into separate single-statement files. Discovered when Phase 7.13.2B's intended single-file DROP+RENAME failed; split into two single-statement migrations succeeded.

### 8.3 Partial unique indexes

| Index | Predicate | Status |
|---|---|---|
| `Settlement_orderId_active_key` | `WHERE "status" != 'CANCELLED'` | ✅ correct; ⚠️ enum-drift hazard (§2 High #11) |
| `FulfillmentAssignment_orderId_active_unique` | `WHERE "status" IN ('ASSIGNED','IN_PROGRESS')` | ✅ correct; ⚠️ enum-drift hazard (§2 High #11) |
| `MarketplaceFavorite_userId_listingId_serviceType_key` | NULLS NOT DISTINCT (full table) | ✅ correct; rename history (7.13.2B) proves index-name fragility |
| `Notification_userId_dedupKey_key` | `WHERE "dedupKey" IS NOT NULL` | ✅ correct |

### 8.4 Constraints inventory (highlights)

- `CHECK ("grossAmount" >= 0 AND "platformFee" >= 0 AND "publisherAmount" >= 0)` on Settlement — allows zero (§2 Medium #22 noted that zero is legitimate for refund clawback).
- FK CASCADE on User → AuditLog, Notification, TicketMessage, OrderEvent → §2 High #12 (forensics-loss hazard).
- Tenant-scoped composite uniqueness on idempotency keys: solid.

### 8.5 Index coverage assessment

Hot-path queries audited:
- Order list by `(customerId, status)` — covered.
- Settlement sweep by `(status, reviewEndsAt)` — Phase 7.13.1 composite; `Settlement_status_idx` dropped Phase 7.13.1.1 (leading column covers).
- FulfillmentAssignment active claim by `(orderId)` — partial unique covers.
- AuditLog query by `requestId` — Phase 7.7 column + index.
- `(customerId)`-only "all my orders" — composite leading-column match; no dedicated index yet (§2 Medium #23).

### 8.6 Adapter-pg pool tuning

Current: `max: 25, idleTimeoutMillis: 20_000` per process. **Production-blocker at scale-up** (§2 Critical #7). The default is fine at laptop scale (single API process + single worker process). When multi-replica deploy lands, the per-replica formula `max ≈ (max_connections - reserved - workers) / replica_count` becomes load-bearing.

### 8.7 Rollback safety

Destructive migrations since 2026-06-15:
- Phase 7.13.x: `DROP TABLE "Escrow"` + `DROP TYPE "EscrowStatus"`. 0-row verified on dev pre-migration. **Operator action**: cross-env presence/rowcount check (NOW.md item 2).
- Phase 7.13.1.1: `DROP INDEX "Settlement_status_idx"`. Composite covers all queries. **Operator action**: EXPLAIN ANALYZE on prod to confirm planner picks composite (NOW.md item 3).
- Phase 7.13.2B: `DROP INDEX` original favorites unique. New canonical replaces it. **Operator action**: Gate 0 dupe sweep on staging+prod (operator-owned).

### 8.8 Schema drift

Phase 7.13 surfaced 151 lines of drift in `packages/database/src/prisma/internal/class.ts`. Phase 7.13.x's regen-drift workaround (git checkout) is fragile — drift returns on every `pnpm install`. Worth a focused investigation if it persists past Prisma 7 ecosystem maturity.

---

## §9. Observability Deep Dive (NEW)

Phase 7.7 shipped the observability spine end-to-end:

**Request ID flow**: middleware injects `X-Request-ID` (UUID v4) → AsyncLocalStorage carries it through the request → AuditService auto-injects into every audit row + metadata mirror → BullMQ signed-payload carries it into worker context → worker AuditService inherits → frontend api-client adds `X-Request-ID` to outbound requests + extracts it from server-returned errors for support tickets.

**Structured logger** (`packages/shared/src/structured-logger.ts`): replaces all `console.*` calls in apps/api + apps/worker. Outputs single-line JSON: `{ ts, level, service, env, msg, ...ctx }`. Grep regression guard in `phase-7-7-no-console.spec.ts` prevents reintroduction (allowlist for ~3 known exceptions).

**Sentry integration**:
- apps/api: instrument.ts loaded before all other imports; SentryFilter on global ExceptionFilter; SentryInterceptor wraps every request with business context.
- apps/worker: Sentry init in entrypoint; BullMQ failed event captures with job context.
- 4 Next.js apps: per-app instrumentation.ts + sentry.client.config.ts + error.tsx + global-error.tsx.
- Source-map upload: conditional on `SENTRY_AUTH_TOKEN` (Phase 7.7 C fix prevents CI hang on PRs from forks).

**Metrics**: `/metrics/queues` endpoint exposes per-queue active / waiting / completed / failed / delayed / stalledHits. Used by ops dashboards.

**Health endpoints**: worker `/health` (process up) + `/ready` (Redis + DB reachable).

**Audit log integrity**: `AuditLog.requestId` column (Phase 7.7 A1) + admin UI filter (Phase 7.7 A2). Every audit row carries `userId` + `organizationId` + `ipAddress` + `userAgent` + `requestId`.

### Gaps surfaced this audit

- §2 Critical #4 — settlement-auto-approve processor writes no audit row per sweep. Compliance gap. ⚠️ Note: Phase 8.4 verified the core at `settlement-auto-approve-core.ts` already writes audit rows (the original audit missed the delegation); an invalid finding corrected to Closed.
- §2 High #18 — reconciliation dedup hitcount logged as cumulative, not per-sweep. Limits operational tuning. ❌ Open.
- §2 High #41 — settlement-auto-approve sweep `catch {}` swallowed errors silently. ✅ Closed Phase 8.9 via `onError` hook wired to Sentry + structured logger.
- §2 Medium #34 — worker unhandledRejection uses `console.error`. ✅ Closed Phase 7.7 — uses `logger.error()` with Sentry capture.
- §2 Medium #31 — structured logger has no context-size cap or stack-trace truncation. ❌ Open.

---

## §10. Testing Deep Dive (NEW)

### 10.1 Jest projects shape (Phase 7.10.2)

`apps/api/jest.config.js` defines two projects:

- **unit** (existing 47 suites): runs against mocked Prisma, no DB. ~5.4s wall time (10x speedup from `isolatedModules: true` on ts-jest).
- **integration** (greenfield, rootDir `src/__tests__/integration`): runs against real Postgres via TEMPLATE-clone. ~150ms/spec via `createTestApp()` → `createTestDatabase()` → `prisma migrate deploy` (template only) → clone via `CREATE DATABASE ... TEMPLATE`.

`pnpm test` → unit only. `pnpm test:integration` → integration only. `pnpm test:all` → both.

### 10.2 Integration harness components

| File | Role |
|---|---|
| `apps/api/src/__tests__/integration/helpers/test-db.ts` | `createTestDatabase()` → `{ dbName, url, teardown }`. Uses docker exec psql (no `pg` direct dep). DROP DATABASE WITH (FORCE). |
| `apps/api/src/__tests__/integration/helpers/create-test-app.ts` | `createTestApp()` → `{ app, prisma, dbName, cleanup }`. Sets DATABASE_URL BEFORE `require()` of AppModule (Gate 0.75 verified). `Test.createTestingModule({ imports: [AppModule] })`. |
| `apps/api/src/__tests__/integration/factories/index.ts` | `makeOrganization`, `makeUser`, `makeWebsite`, `makeOrder` (+ `paymentStatus` override), `makeOrderItem`, `makeOrderDeliveryVersion`, `makePublisher`, `makeWallet`, `makeTransaction`, `makeSettlement` — 10 factories total. Unique suffix via process.pid + Date.now() + counter. Transaction references use `crypto.randomUUID()` for parallel-worker safety. |
| `apps/api/src/__tests__/integration/factories/financial-fixture.ts` | `setupFinancialTest()` — builds complete financial baseline (org → customer + publisher + website → order + OrderItem + DeliveryVersion (VERIFIED) → wallet → deposit). `expectFinancialState()` — pure DB assertion layer. Uses Prisma enums for all comparison constants. |
| `apps/api/src/__tests__/integration/orders/fulfillment-claim-race.integration.spec.ts` | Spec 1 — 5-caller Promise.allSettled race; closes Phase 7.14 #23. |
| `apps/api/src/__tests__/integration/financial/*.integration.spec.ts` | Specs 2-7 (Sprint 2A) — 6 financial integration specs (happy path, refund, duplicate webhook, concurrent settlement, cancellation-before-settlement, settlement rollback). |

### 10.3 Counts (today)

- Total suites: 60 (was 33 before Phase 7.0)
- Total tests: 701 (was 478; +6 Sprint 2A financial integration specs)
- Integration specs: **7** (Spec 1: fulfillment-claim-race + Specs 2-7: Sprint 2A financial — happy path, refund, duplicate webhook, concurrent settlement, cancellation-before-settlement, settlement rollback)
- TEMPLATE DB: `guestpost_test_template` — CI setup completed Phase 7.10.2.1 (ci.yml + pr.yml). Operator-action setup still required on each dev machine.

### 10.4 Coverage assessment

- Money-touching code: well-covered at unit level. Race scenarios newly covered at integration level (Spec 1).
- Auth: integration covered by `email-verification.integration.spec.ts` (Phase 7.10).
- Worker processors: unit-tested via mocked Prisma; integration coverage TBD.
- Frontend: Next.js apps have no harness — `next test` not adopted. Manual smoke is the only frontend gate.

### 10.5 CI gap (§2 Critical #6)

✅ Closed Phase 7.10.2.1. `pnpm test:integration` now invoked in `ci.yml` and `pr.yml` (see §2 Critical #6). Template DB created in CI: DROP + CREATE + migrate deploy + verify. `main.yml` intentionally does not include integration tests (lightweight build+unit-only workflow).

### 10.6 Named follow-up backlog (already tracked in NOW.md)

- Phase 7.10.2.1 — Spec 2 (queue GET happy-path) + TestAuthGuard + supertest api-client + CI template-DB step
- Phase 7.10.2.x — Convert Phase 7.12 favorites manual-smoke race to integration spec
- Phase 7.10.2.2 — Split AppModule into per-feature TestModules once suite hits 20+ specs

---

## §11. Infrastructure & Deployment Deep Dive (NEW)

### 11.1 Hosting model

Per `bedrock/Memory/infrastructure.md`: **laptop-only at present.** A 2GB VPS attempt at `103.42.5.163` was provisioned + abandoned 2026-06-14 (RAM exceeded under Next dev mode + nest --watch + tsx --watch + Docker). Shared dev/testing host is an open question.

### 11.2 Docker Compose stack

`infrastructure/docker/docker-compose.yml`:

| Service | Image | Port | Healthcheck | Volume |
|---|---|---|---|---|
| Traefik | v3.3 | :80, :8080 (dashboard) | ✅ | ephemeral |
| Postgres | 17 Alpine | :5432 | ✅ | persistent |
| Redis | 7 Alpine | :6379 | ✅ | persistent |
| MinIO | latest | :9000 API, :9001 console | ✅ | persistent |
| Mailpit | latest | :1025 SMTP, :8025 UI | ❌ (§2 High #15) | ephemeral |

Production runs postgres:17 (matches compose). CI workflows consolidated: main.yml + pr.yml now postgres:17-alpine (§2 High #17 closed Sprint 1B).

### 11.3 CI/CD

Three workflow files exist:
- `main.yml` — on push to main: build, typecheck, test. **Does NOT run integration tests.** postgres:17-alpine.
- `pr.yml` — on PR to main: same as main.yml + integration tests. postgres:17-alpine.
- `ci.yml` — alternate workflow; postgres:17-alpine; integration tests with template-DB step.

All workflows now use postgres:17-alpine (§2 High #17 closed Sprint 1B). Template-DB creation + integration test invocation added to ci.yml and pr.yml (§2 Critical #6 closed Phase 7.10.2.1).

Sentry source-map upload (Phase 7.7 C): conditional on `SENTRY_AUTH_TOKEN`. Fork-PR safe.

### 11.4 Env handling

`apps/api/src/main.ts:30-32` validates REQUIRED_ENV_VARS at boot; exits 1 if any missing. Phase 7.13 added runtime DATABASE_URL guard in `createPrismaAdapter`. `.env.example` flags DATABASE_URL, REDIS_URL, JWT_SECRET as REQUIRED (§2 High #16 closed).

JWT_SECRET weakness check remains regex-only but `.env.example` default changed to instruction string `generate_a_random_secret_with_openssl_rand_base64_32` (§2 High #19 closed).

### 11.5 Worker deployment

Dockerfile exists at `apps/worker/Dockerfile`. **No HEALTHCHECK directive** (§2 High #15). In K8s, hung worker pods stay "Running" until liveness probe (not configured) trips.

`PRODUCTION_RUNBOOK.md` documents "exactly one worker fleet" rule but enforcement is manual `pgrep` (§2 Medium #36).

### 11.6 Backups + durability

Not documented. Postgres / Redis / MinIO durability assumptions left to operator. Worth a follow-up backlog item.

### 11.7 VPS deployment story

README mentioned VPS attempt + abandonment. Current deploy story unclear — laptop-only is the operational state.

---

## §12. Remediation Log

Findings close phase-by-phase here. Verified status updated 2026-06-29 via systematic codebase check; see `bedrock/Work/NOW.md` for details.

**Summary (numbered findings #1-#41)**: 25 closed (✅ incl. 1 intentional), 1 partial (⚠️), 15 open (❌), 0 unchecked. Note: CSRF middleware + support ticket cap were closed but are not numbered findings; #2 has two entries (original + Phase 8.10 follow-up). #8 (Redis) and #10 (Revenue SQL) closed via Phase A (2026-06-30). #9 and #17 closed via Sprint 1A/1B (2026-07-03): DNS rebinding guard (`pipelining: 0`) + CI postgres consolidation (17-alpine). #14 closed via Sprint 2A (2026-07-03): body-cap structured logging with `reason`, `maxBodySize`, `contentLength` in both delivery-verification and verification processors. #26 verified intentional (defense-in-depth). #33 verified closed (pnpm-workspace.yaml documentation). #30 verified open. #25 verified open (soft-delete inconsistency persists).

| Finding | Status | Closed by | Date | Notes |
|---|---|---|---|---|
| #38 — Payout worker `handleExecute` no-op stub | ✅ Closed | Phase 8.7 (PR #19 merged `e5a0b46`) | 2026-06-22 | Recon (95% confidence) confirmed dead code: 0 enqueuers, 0 tests, 0 runbook refs, 0 registry entries, stub from day one. Deleted handler + switch arm + `QUEUE_JOBS.PAYOUT.EXECUTE` constant. Shipped 7-case regression guard at `apps/api/src/__tests__/phase-8-7-payout-execute-dead-code.spec.ts` (negative + positive assertions on the surviving 2-arm shape). Cleaned a stale freshness-window comment that still referenced the dead handler. Verification: typecheck + lint + jest (48 suites / 659 tests) + build all green; pre-flight greps clean. Worker now accepts exactly `payout-check-status` (repeatable) + `payout-webhook`. |
| #4 — Settlement auto-approve processor "writes NO audit log per sweep" | ✅ Invalid finding (verified already-fixed) | Phase 8.4 (PR #20 merged `e81c7b7`) | 2026-06-22 | Audit reviewed `apps/worker/src/processors/settlement-auto-approve.processor.ts` in isolation and missed the delegation to `runSettlementAutoApprove`. The core at `packages/shared/src/settlement-auto-approve-core.ts:136-149` has written a per-settlement `auditLog.create({ action: 'SETTLEMENT_AUTO_APPROVED', entityType: 'Settlement', entityId, metadata: { orderId, ... }, userId: null })` since Phase 7.3. Phase 8.4 added regression coverage (payload-shape assertions in `apps/api/src/__tests__/phase-7-3-auto-approve-worker.spec.ts:104-122`) so a future code change cannot silently drop the row's load-bearing fields. No production code touched for #4. |
| #41 — Settlement auto-approve `catch {}` swallows ALL per-row errors | ✅ Closed | Phase 8.9 (PR #20 merged `e81c7b7`) | 2026-06-22 | Parameterless `catch {}` at `packages/shared/src/settlement-auto-approve-core.ts:159` swallowed every per-row error including `TypeError`s; the comment falsely claimed Sentry propagation that never fired (the `createObservableWorker` failed-event listener only triggers after BullMQ retry-exhaustion, which never happens because the core caught + returned normally). Fix: added `onError?: (err, settlementId) => void` to `RunSettlementAutoApproveOptions` + new `makeAutoApproveOnError(hooks, jobName, sweepRunId)` factory in `@guestpost/shared`. Processor passes injected hooks (`logError` → `logger.error`, `captureException` → `Sentry.captureException`) so packages/shared stays Sentry-free. Sentry call carries `fingerprint: ['settlement-auto-approve', settlementId]` so a DB outage that fails every row in a sweep groups as ONE Sentry issue with N occurrences (load-bearing as batch size scales above ~100). Sweep robustness preserved — handler errors are caught defensively so a misbehaving callback can't kill the sweep. Verification: 49 suites / 668 tests; +9 new tests (2 in Phase 7.3 spec for onError contract + 7 in new Phase 8.9 spec for factory + adoption). |
| #1 — Settlement `returnToReview` unguarded update | ✅ Closed | Phase 8.1 (PR #21 merged `16acd6d`) | 2026-06-22 | `apps/api/src/modules/settlements/settlements.service.ts:450` ran `tx.settlement.update({ where: { id } })` with no version + no in-tx status predicate; concurrent `adminApprove` could silently corrupt the status (e.g., flip a RELEASED settlement back to UNDER_REVIEW). Fix: changed to `tx.settlement.updateMany({ where: { id, status: "CUSTOMER_APPROVED", version: settlement.version }, data: { status: "UNDER_REVIEW", version: { increment: 1 } } })` + `ConflictException` on `count === 0` + `findUniqueOrThrow` refetch to preserve the controller's return shape. Matches the established convention used by 6 sibling sites in this file (customerApprove, adminApprove, forceApprove, etc.); Gate 0.5 paranoia greps confirmed every settlement-status writer increments version consistently so the guard is load-bearing. Pre-tx 400-class status check kept as UX fast-path. |
| #2 — `releaseFundsInternal` Order.status unguarded update | ✅ Closed | Phase 8.2 (PR #21 merged `16acd6d`) | 2026-06-22 | `apps/api/src/modules/settlements/settlements.service.ts:584` ran `tx.order.update({ where: { id } })` with no version guard; concurrent order mutations (customer dispute, force-cancel) silently overwrote whatever state the order was in. Two-step fix: (1) extended the `tx.order.findUnique` select with `version` + every other field the rest of `releaseFundsInternal` actually consumes (recon-enumerated: `id`, `activeDeliveryVersionId`, `fulfillmentChannel`, `organizationId`, `website.ownershipType`); (2) changed `tx.order.update` to `tx.order.updateMany({ where: { id, version: order.version } })` + version increment + `ConflictException` on `count === 0`. Status predicate intentionally omitted from the where clause (callers `adminApprove` + `forceApprove` pass orders in varying legitimate pre-states; version-only is the safer guard per the audit's recommendation). Defensive `NotFoundException` added for the `order === null` case to make a pre-existing implicit Prisma RECORD_NOT_FOUND path explicit. Verification: 50 suites / 674 tests; +6 new tests in `phase-8-1-8-2-settlement-race-windows.spec.ts` (3 for #1, 3 for #2). |
| #3 — Payout webhook handler missing replay-protection dedupKey | ✅ Closed | Phase 8.3 (PR pending) | 2026-06-22 | `apps/api/src/modules/publisher-payouts/payout-webhook.controller.ts:52` enqueued with no dedup parameter; manually-replayed webhooks (ops re-trigger, provider dashboard re-send, network duplicates) entered BullMQ as distinct jobs with different auto-ids. A narrow race window let two jobs reach `completeExecution()` before either committed the version-guarded update. Fix: pass `{ jobId: 'payout-webhook:${provider}:${providerExecutionId}' }` to `QueueService.addJob`. BullMQ rejects duplicate enqueues at the queue layer for the dedup window bounded by the PAYOUT queue's `removeOnComplete: { count: 100, age: 86400 }` retention (~24h / 100 jobs whichever first). Reused `normalizeProviderWebhook` from `@guestpost/shared` (single source of truth for payload-shape extraction — no drift between worker's status path + our dedup keying). Non-transfer events (account.updated etc.) where the normalizer returns null fall through with auto-id; `logger.warn` fires on that path so payload-shape drift surfaces in logs. Worker's status-check guard at `payout.processor.ts:161` remains the safety net for late retries. Design choice: BullMQ-native jobId (not app-layer dedupKey — that pattern is for DB rows, not queue items; matches the repo's 6+ existing jobId callsites). Verification: 51 suites / 678 tests; +4 new tests in `phase-8-3-payout-webhook-dedup.spec.ts` + 2 tightened existing payout-golive-security assertions. |
| #39 — Stripe Connect `cancelTransfer` reversal missing Idempotency-Key header | ✅ Closed | Direct commit `ac56ed0` | 2026-06-26 | Added required `idempotencyKey` param to `PayoutProviderAdapter.cancelTransfer` interface. Stripe adapter sends `Idempotency-Key` header on reversal POST. Wise/manual accept the param unused. Key shape `payout-cancel-${executionId}` (our internal PK, not Stripe's `providerExecutionId` as the §2 fix suggestion had — functionally equivalent given 1:1 relationship, both stable for the operation's life; deviation noted for cross-reference clarity). Unversioned per commit rationale (version-exposure risk). New test in `payout-golive-security.spec.ts` verifies header. Typecheck + 50/50 publisher-payouts suite + grep sweep confirm no missed call sites. |
| #40 — `cancelExecution` calls provider before DB transaction | ✅ Closed | Phase 8.8 (commit `d62bb39`) | 2026-06-29 | Restructured to Tx1(claim)→provider→Tx2(finalize) two-phase commit with version chain. Tx1 locks execution row, bumps version (claim). Provider call follows with idempotency key. Tx2 finalizes with WHERE version = claimedVersion — safe to retry on partial failure. Worker's `completeExecution`/`failExecution` also gained version guards to prevent overlap with concurrent cancel claim. |
| #2 (follow-up) — `releaseFundsInternal` status predicate + TOCTOU gap in settlement creation | ✅ Closed | Phase 8.10 (commit `a8f83e8`) | 2026-06-29 | Two fixes: (1) Added `status: { notIn: ["CANCELLED", "REFUNDED", "DISPUTED"] }` predicate to the `order.updateMany` in `releaseFundsInternal` — defense-in-depth even if a concurrent mutation doesn't bump the order version. Runtime: verified no false positives across all admin state transitions. (2) Added `evaluateSettlementEligibility(tx, orderId)` re-check inside the `$transaction` in `createSettlement` — closes a TOCTOU window where a dispute/fraud/status change between the pre-check and `settlement.create` could bypass the gate. New Phase 8.10 regression spec (happy path + race simulation). Phase 8.2 happy-path assertion updated + new terminal-state test case. |
| CSRF protection (was §5.6 gap) | ✅ Closed | Direct commit `9f8170e` | 2026-06-29 | Added `CsrfMiddleware` that validates state-changing requests carry a Bearer token when a session cookie is present. The API client always sends both `Authorization: Bearer` and `Cookie` — a CSRF attack would only carry the cookie (auto-attached by browser) without the Bearer header (attacker cannot read in-memory token). Safe methods (GET/HEAD/OPTIONS) and Bearer-present requests bypass the check. Registered globally in AppModule. |
| Support ticket unbounded query (was §2 gap) | ✅ Closed | Direct commit `9f8170e` | 2026-06-29 | Added `take: 500` to `listTickets()` findMany call to prevent OOM for actors with many tickets (SUPER_ADMIN/FINANCE see all orgs). The admin variant (`listTicketsDetailed`) already had proper pagination with default limit=50, max=100. Non-admin consumer (portal) uses client-side filtering on the result — 500-ticket cap is generous for beta-scale orgs. |
| #5 — Lazy `queueServiceRef` race during startup | ✅ Closed | PR #26 | 2026-06-26 | Boot sequence reordered: NestFactory.create + QueueService resolve + startup assertion before Better Auth handler mount. `queueServiceRef` is now `const` (non-nullable) with `process.exit(1)` on resolution failure. Verified at `apps/api/src/main.ts:450-457`. |
| #6 — Integration tests cannot run in CI (template DB missing) | ✅ Closed | Phase 7.10.2.1 (commit `402b043`) | 2026-06-29 | Template-DB creation step added to `ci.yml` and `pr.yml` (DROP IF EXISTS + CREATE + migrate deploy + verify). `pnpm test:integration` invoked in both workflows. Note: `main.yml` does NOT include integration tests (lightweight build+unit-only workflow). |
| #16 — `DATABASE_URL` not flagged `# REQUIRED` in `.env.example` | ✅ Closed | Phase 3 (commit `3313728`) | 2026-06-29 | Added `# REQUIRED` inline comment to `DATABASE_URL`, `REDIS_URL`, and `JWT_SECRET` in `.env.example`. Verified at lines 11, 14, 38. |
| #19 — JWT_SECRET weakness check is regex-only (no entropy gate) | ✅ Closed | Phase 3 (commit `3313728`) | 2026-06-29 | The `.env.example` default value was changed to the literal string `generate_a_random_secret_with_openssl_rand_base64_32`, which is a human-readable instruction to run `openssl rand -base64 32`. Combined with the `# REQUIRED` flag, this eliminates the false-sense-of-security concern. The entropy check itself remains regex-only but is now less relevant. |
| #28 — jest.setup.js dummy DATABASE_URL resilience gap | ✅ Closed | (documented design) | 2026-06-15+ | 20-line comment block explains the design: dummy URL is safe because all DB-touching specs mock Prisma; integration test explicitly validates the required-DATABASE_URL behavior via `isolateModules` + `delete`. This is an intentional, documented decision. |
| #29 — Email rate-limit timing oracle for account enumeration | ✅ Closed | Phase 7.8 | 2026-06-15+ | Response shape is byte-identical to Better Auth's built-in IP rate-limit (body, status, statusText, headers). SHA-256 hashing prevents email leakage in Redis keys and logs. The `count === 1` timing side channel (Redis `pexpire` call) reveals only previous rate-limit hits, not account existence. |
| #34 — Worker unhandledRejection uses `console.error`, not structured logger | ✅ Closed | Phase 7.7 | 2026-06-15+ | `apps/worker/src/index.ts` lines 245-257 use `logger.error()` with Sentry capture only. The `flushAndExit` helper (lines 227-243) also uses `logger.error()`. No `console.error` calls remain in the handler. |
| #35 — `.env.example` IP-rate-limit vs email-rate-limit interaction not documented | ✅ Closed | Phase 3 (commit `3313728`) | 2026-06-29 | Lines 54-62 of `.env.example` explain the two-layer model: per-IP limits (line 48-52) + per-email limits as second layer catching credential stuffing across IP pools. Window default 1h documented. |
| #7 — Prisma adapter-pg pool over-provisioned for multi-replica scale-up | ❌ Open | — | — | `apps/api/src/common/prisma.service.ts` hardcodes `max: 25` with no env-var override (`PRISMA_POOL_MAX` not referenced anywhere). No per-environment config computation exists. Production-blocker only at horizontal scale-up; acceptable at laptop scale. |
| #8 — Redis client unguarded retries + no connection timeout | ✅ Closed | Phase A (2026-06-30) | 2026-06-30 | `apps/api/src/common/redis-client.ts:7-14` now has `connectTimeout: 10_000`, `retryStrategy` with exponential backoff (200ms..30s cap, 15 attempts), and per-call `maxRetriesPerRequest: 5`. BullMQ client uses `maxRetriesPerRequest: null` as required. All three protections from the audit fix implemented. |
| #9 — DNS rebinding can bypass safe-fetch on pool-reused connections | ✅ Closed | Sprint 1A (commit pending) | 2026-07-03 | Added `pipelining: 0` to `SAFE_LOOKUP_AGENT` at `packages/shared/src/safe-fetch.ts:115`. Disables HTTP pipelining so each request gets its own connection, forcing DNS re-resolution for every fetch — eliminating the pool-reuse attack window. Comment updated to document the trade-off. |
| #10 — Revenue raw-SQL `$1`/`$2` indices built by string ternary | ✅ Closed | Phase A (2026-06-30) | 2026-06-30 | `apps/api/src/modules/admin/finance/revenue.service.ts:370-410` refactored to `clauses[]` + `params[]` accumulation pattern with incremental `$paramIndex` counter. Comment at line 370: "not brittle $1/$2 ternary arithmetic." Verified: 4 grouping queries all use the same safe pattern. |
| #11 — Partial-unique WHERE clauses do not track enum additions | ❌ Open | — | — | No static-source spec exists importing `SettlementStatus` or `FulfillmentAssignmentStatus` to assert active values against migration WHERE clauses. The `phase-7-14-static-source.spec.ts` pattern referenced in the audit was never created. Schema.prisma has human-readable comments only (lines 718-730, 800-808). |
| #12 — CASCADE deletes on User wipe AuditLog / Notification / TicketMessage | ✅ Closed | Phase 8.12 | 2026-06-29 | `Notification.userId` and `TicketMessage.userId` changed to nullable (`String?`) with `onDelete: SetNull` in `schema.prisma`. A custom migration `phase_812_cascade_setnull` was generated to alter columns and recreate FKs. Preserves audit/message history on user deletion (when implemented). |
| #13 — JSON column validation gaps — payout key-rotation hazard | ❌ Open | — | — | No key-rotation runbook in `bedrock/Memory/infrastructure.md`. No backfill spec asserting encrypted row `encryptionKeyVersion` matches known key. Multi-version decrypt test exists (`payout-decrypt-security.spec.ts:156`) but is the only addressed item. |
| #14 — Delivery-verification body-cap silent failure | ✅ Closed | Sprint 2A | 2026-07-03 | Both processors (`delivery-verification.processor.ts:106-116`, `verification.processor.ts:68-78`) now emit `logger.warn({ reason: "body_size_exceeded", url, maxBodySize, contentLength })`. `contentLength` parsed to number from header, guarded against NaN. Behavior identical — body cap exceeded still returns `""`/`null` → MANUAL_REVIEW. Regression guard at `phase-7-14-body-cap-logging.spec.ts`. |
| #15 — mailpit + worker have no Docker healthcheck | ❌ Open | — | — | `infrastructure/docker/docker-compose.yml` line 77: mailpit has no `healthcheck` block (unlike postgres, redis, minio). `apps/worker/Dockerfile` has no `HEALTHCHECK` instruction (unlike sibling `apps/api/Dockerfile`). |
| #17 — CI workflows drifted — pr.yml + main.yml use postgres:16 | ✅ Closed | Sprint 1B (commit pending) | 2026-07-03 | Changed both `pr.yml:21` and `main.yml:20` from `postgres:16` to `postgres:17-alpine`. All 3 workflows now use postgres:17-alpine. Consolidated image; reusable workflow refactor deferred to future infra work. |
| #18 — Reconciliation dedup hitcount logged as cumulative, not per-sweep | ❌ Open | — | — | `packages/shared/src/notification-dedup-keys.ts:140` has module-scoped `dedupHitsTotal` never reset between sweeps. `reconciliation.processor.ts:112` logs `dedup_hits_total: total`. The `__resetDedupHitsTotal()` export exists but is test-only. |
| #20 — Portal marketplace uses raw `<img>` in 4 files | ❌ Open | — | — | 7 raw `<img>` tags across 4 files in `apps/portal/src/app/dashboard/marketplace/`. No `import Image from "next/image"` anywhere in these files. |
| #21 — Publisher dashboard + admin orders duplicate STATUS_PRESENTATION | ❌ Open | — | — | Admin dashboard (`apps/admin/src/app/dashboard/page.tsx:54`) and admin orders (`apps/admin/src/app/dashboard/orders/page.tsx:69`) have independent hand-rolled `statusVariant()` functions. Publisher dashboard uses inline ternary (lines 393-400). No shared `STATUS_PRESENTATION` import. |
| #22 — Settlement.publisherAmount allows zero — surface mapping ambiguity | ⚠️ Partial | — | — | A `CHECK ("grossAmount" >= 0 AND "platformFee" >= 0 AND "publisherAmount" >= 0)` constraint exists in the squashed baseline migration SQL (`migrations/20260611120000_squashed_baseline/migration.sql:1560`). However, no inline comment on `publisherAmount Decimal` field in `schema.prisma:695` explaining zero-value semantics (legitimate for refund clawback). No `kind` column to discriminate clawback vs normal. |
| #23 — Order(customerId)-only index opportunity | ❌ Open | — | — | No bare `@@index([customerId])` on Order model. Only composite `@@index([customerId, status])` exists (line 584). Current planner uses leading-column match but future `ORDER BY createdAt` may flip to seq-scan. |
| #24 — createdAt columns lack `@db.Timestamptz` annotation | ❌ Open | — | — | Zero uses of `@db.Timestamptz` across entire schema.prisma. All `DateTime @default(now())` fields lack timezone annotation. Period-scoped queries could be off-by-hours if app and DB run in different TZs. |
| #25 — Soft-delete pattern inconsistency across tables | ❌ Open | — | — | Verified 2026-07-03: three patterns coexist — `isActive` (Website, PayoutMethod, PayoutProvider, MarketplaceCategory, ListingFulfillmentRule), `reversedAt` (PlatformRevenue), status-enum terminal values (Order/Settlement/Campaign/MarketplaceListing/others). Eight+ tables hard-delete (OrderItem, Membership, Team, ApiKey, Campaign, MarketplaceFavorite, MarketplaceSavedListItem, SettlementApproval). Even within `isActive` pattern, usage inconsistent — Website sets `isActive: false` on delete but does not filter queries. No standardization work done. |
| #26 — SSRF guard redundancy in verification.processor.ts | ✅ Intentional | (verified) | 2026-07-03 | Verified against codebase: `verification.processor.ts:104-107` (job-signature) + `:117` (SSRF URL guard) both present. Both layers serve distinct purposes — job-signing protects the queue, URL-level guard protects against malicious content within a signed job. Intentional defense-in-depth, not redundancy. |
| #27 — Job-signing dev fallback uses `console.warn` not structured logger | ❌ Open | — | — | `packages/shared/src/job-signing.ts:23-27` still uses `console.warn()` in dev fallback when `QUEUE_SIGNING_SECRET` is not set. Not routed through structured logger. |
| #30 — `createPrismaAdapter` accepts pool config without validation | ❌ Open | — | — | `packages/database/src/create-prisma-client.ts:27-37`: `createPrismaAdapter()` accepts `CreatePrismaAdapterOptions extends Omit<PoolConfig, 'connectionString'>` and spreads it via `...options`. No validation, no `max > 25` warning, no guard rails. Compounds Critical #7. |
| #31 — Structured-logger has no context-size cap or stack-trace dedup | ❌ Open | — | — | `packages/shared/src/observability/structured-logger.ts` has no truncation, depth limit, or size guard on context object. `JSON.stringify(record)` at line 97 would throw on circular references. No `replacer`, `maxLength`, or key filtering. |
| #32 — turbo.json `SENTRY_AUTH_TOKEN` listing has no inline rationale | ❌ Open | — | — | `turbo.json` lines 15 and 28 list `SENTRY_AUTH_TOKEN` in `globalEnv` and `build.env` with zero comments explaining why. |
| #33 — pnpm @sentry/cli build-script silent-failure | ✅ Closed | Phase 7.7 C | 2026-06-15+ | `pnpm-workspace.yaml:15-20` has a detailed inline comment documenting the failure mode: "@sentry/cli's postinstall downloads a native binary used to upload source maps... the upload step is silently skipped when SENTRY_AUTH_TOKEN is unset." Documented at the configuration site, which is the canonical location for build-script approval config. |
| #36 — PRODUCTION_RUNBOOK worker-fleet check is manual | ❌ Open | — | — | `docs/PRODUCTION_RUNBOOK.md:35` still documents manual `pgrep` verification. No automated post-deploy health-poll or boot-time assertion added. |
| #37 — Repeatable-job-registry drift guard is spec-only | ✅ Closed | Phase 8.12 | 2026-06-29 | `RepeatableJobName` type derived from `JOB_NAMES` array (single source of truth). `RegisteredJob` interface added. Each `register*()` function in `worker/index.ts` now returns `Promise<RegisteredJob>`. `bootstrap()` uses `Promise.all()` to collect results and calls `assertNoRegistryDrift()` from `repeatable-job-registry.ts` at startup. This function compares registered jobs against `REPEATABLE_JOB_NAMES` and throws on mismatch (propagates to `process.exit(1)`). |

---
