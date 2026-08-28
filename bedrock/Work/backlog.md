---
note_type: backlog
project: guestpost-platform
updated: 2026-08-24
---

# Backlog

## Fraud-case SLA + stall sweep (2026-08-24)

Built on top of the existing deadline machinery so confirmed-fraud refunds can
no longer stall invisibly:

- `ensureFraudCancellationHandoff` now stamps a configured review deadline
  (`FRAUD_REVIEW_WINDOW_HOURS`, default 48h) instead of `null`, making every
  workbench CRITICAL flag and overdue sort apply from creation.
- The existing `cancellation-response-timeout-sweep` also nudges stalled
  `ESCALATED`/`PENDING_FINANCE` cases via the shared cadence helpers (first at
  day 3, then weekly): one `CANCELLATION_STALL_REMINDER` order-event per day
  bucket plus a required-channel `STAFF_RECONCILIATION_ALERT` to the
  accountable roles (Operations+Super Admin for ESCALATED, Finance+Super Admin
  for PENDING_FINANCE). No state or money transitions are automated.
- Shared pure policy (`computeFraudHandoffDeadline`, `caseStalledDays`,
  `isCaseStallReminderDue`) is the single source of the cadence.

Still open from the 2026-08-24 reconciliation plan:

- [ ] Persist scheduled reconciliation runs (`ReconciliationRun` table +
  findings history) instead of AuditLog-only history; alert on nonzero
  findings.
- [ ] Settlement aging surface for MANUAL-policy settlements past
  `reviewEndsAt` (staff notification), pairing with the documented
  `reviewEndsAt` enforcement gap below.
- [ ] Quarantine/flag pre-evidence legacy deposit ledger rows; dev reset script.
- [ ] Finance workbench surfaces for wallet-drift / publisher-balance /
  revenue-split families computed by `reconciliation-core.ts`.

## Undocumented bug-hunt batch (2026-08-23)

A read-only bug hunt across API money paths, auth/security, schema/shared,
frontend apps, and worker queues found 22 defects not tracked anywhere. The two
High findings are fixed on the `fix/force-approve-cancelled-and-link-property`
branch; the rest are recorded here as open work. None of these overlap the
historical audit registers.

Fixed in this batch:

- [x] **HIGH — Publisher integrations "Link property" always failed 400.**
  `apps/publisher/src/app/dashboard/integrations/[id]/page.tsx` hardcoded
  `websiteId: ""`, which `linkPropertyRequestSchema` (`z.string().cuid()`)
  always rejects. Fixed by a link dialog that resolves a real publisher
  website id; guarded by a static-source regression spec.
- [x] **HIGH — `forceApprove` could resurrect a CANCELLED settlement and pay
  it out.** Pre-check rejected only `RELEASED` and the CAS lacked a status
  predicate, so `CANCELLED -> CUSTOMER_APPROVED -> ADMIN_APPROVED` released
  funds on a deliberately cancelled record (and `ADMIN_APPROVED` was silently
  downgraded). Fixed to live statuses only plus a status-pinned CAS matching
  the six sibling transition sites; regression spec added.

Open findings (deferred):

- [ ] **Medium — Tier review window (`reviewEndsAt`) is never enforced on
  release paths.** `customerApprove` accepts day-0 and the auto-release sweep
  has no `reviewEndsAt` filter (`settlements.service.ts`,
  `packages/shared/src/settlement-auto-release-core.ts`), so the 7/14/30-day
  fraud hold is bypassable. Enforce the window on every release path.
- [ ] **Medium — `/identity/me` leaks suspension metadata.** AuthGuard spreads
  the full Prisma User row into `request.user`
  (`apps/api/src/modules/auth/auth.guard.ts`), so the response carries
  `banReason`, `banReasonCode`, `banExpires`, `suspendedByUserId`,
  contradicting the documented invariant that suspension notes are never
  exposed. Project the user shape explicitly.
- [ ] **Medium — Better Auth `trustedOrigins` trusts the request Origin in
  every non-production NODE_ENV** (`packages/auth/src/index.ts`), disabling
  CSRF/redirect validation on staging/preview deployments. Require an explicit
  allowlist outside production too.
- [ ] **Medium — safe-fetch SSRF allowlist misses CGNAT `100.64.0.0/10`,
  multicast/reserved IPv4, and `ff00::/8` / `fec0::/10` IPv6**
  (`packages/shared/src/safe-fetch.ts`). Add ranges + tests.
- [ ] **Medium — `SETTLEMENT_AUTO_APPROVE_DISABLED=true` cannot deregister an
  already-registered repeatable job**, and env-interval changes leave stale
  duplicate schedules across several sweep registrars
  (`apps/worker/src/index.ts`). Remove repeatables by name like
  `registerWebsiteReverifySweep`.
- [ ] **Medium — Legacy auth emails (verification/password reset) lack the
  exactly-once lease/quarantine** of the SEND_DELIVERY pipeline; ambiguous
  SMTP failures retry up to 5 times sending duplicates
  (`apps/worker/src/processors/email.processor.ts`).
- [ ] **Medium — Sync-history pagination controls render but do nothing**
  (`handlePageChange` empty) and `useSyncHistory` omits filters from its query
  key — wiring filters later would serve one cached page for every combination
  (`apps/publisher/src/app/dashboard/integrations/[id]/page.tsx`).
- [ ] **Medium — `scripts/load-test.ts` is dead-broken against the current
  schema** (queries dropped `MarketplaceListing.type`/`price`; posts a legacy
  order payload) and provisions users/orgs/wallets before any environment
  guard runs. Rewrite against ListingService ordering or delete.
- [ ] **Low-Medium — Portal deposit polling leaves an orphaned 60s timeout**
  that pops a false "still processing" toast after the wallet already credited
  (`apps/portal/src/app/dashboard/billing/page.tsx`). Track and clear the
  timer on success/unmount.
- [ ] **Low — Unauthenticated `/api/v1/metrics/queues` exposes queue depths;
  `/health/ready` reflects raw dependency error strings** (internal topology
  disclosure). Gate behind service identity or restrict fields
  (`apps/api/src/main.ts`).
- [ ] **Low — Any junk `Authorization: Bearer` header buys the authenticated
  rate-limit tier** (~5x budget unauthenticated) via
  `has-auth-credentials.ts`. Validate token presence before tier selection.
- [ ] **Low — Job-signing payload `v` field is HMAC'd but never validated**,
  so a future version bump gates nothing
  (`packages/shared/src/job-signing.ts`).
- [ ] **Low — API vs worker `SEND_DELIVERY` wake jobId schemes drift**;
  completed wakes persist up to days under unsuffixed ids and silently swallow
  later wakes (bounded ~5 min by the outbox sweep)
  (`communications.service.ts` vs `communication-outbox-dispatch-core.ts`).
- [ ] **Low — Withdrawals "This Month" KPI ignores year** (same-month
  prior-year payouts counted) on the publisher withdrawals page.
- [ ] **Low — Earnings "Withdrawable" tab equals the "Approved" tab** because
  the transaction mapper drops `availableAt`
  (`apps/publisher/src/app/dashboard/earnings/page.tsx`).
- [ ] **Low — `verify-link` processor records failed verifications as
  `VERIFIED_AUTO` order events and writes status without a version guard**
  (currently dormant: no producer enqueues VERIFY_LINK)
  (`apps/worker/src/processors/verification.processor.ts`).
- [ ] **Low — `generate-report` has no retry dedup** — a crash after
  `report.create` but before ack inserts a duplicate Report row
  (`apps/worker/src/processors/report.processor.ts`).
- [ ] **Low — OAuth state consumption is GET-then-DEL, not atomic single-use**
  (`packages/integrations/src/services/oauth-state.service.ts`). Use `getdel`.
- [ ] **Informational — `inviteMember` error differentiation enumerates
  registered/banned emails** (`apps/api/src/modules/identity/identity.service.ts`).
- [ ] **Informational — `OrderDeliveryVersion.adminVerifiedById` relation has
  no backing index** (last unindexed User relation)
  (`packages/database/prisma/schema.prisma`).

## Explicitly deferred: staff security and finance governance (2026-08-12)

The owner explicitly deferred this whole workstream. It remains a paid-launch
gate and must not be represented as fixed by the current correctness work:

- [ ] Phishing-resistant staff MFA and recent step-up authorization for
  financial-data decryption, payout execution/checking, role changes, platform
  fee changes, and emergency controls.
- [ ] Maker-checker approval for every human-initiated money or fee mutation,
  with actor independence enforced in both application and database policy.
- [ ] Append-only staff security/finance audit evidence and a rehearsed,
  independently approved break-glass procedure.

## Confirmed delivery-fraud workflow rollout (2026-08-15)

- [x] Implement the role-separated operational handoff: immutable confirmed
  finding, permanent settlement-deny hold, same-order structured cancellation,
  exact replay/version semantics, Operations/Super Admin full-refund review,
  Finance/Super Admin canonical refund approval, database backstops, and
  audience-safe timeline/outbox projections.
- [ ] Complete final repository CI and the real PostgreSQL migration suite,
  including direct UPDATE/DELETE/TRUNCATE denial, incomplete reused-case
  rejection, force-cancel/dispute-refund bypass denial, deferred terminal-
  outcome enforcement, full-refund state progression, exact Finance replay,
  and customer/publisher/Operations/Finance projection privacy.
- [ ] Rotate every database credential exposed outside approved secret storage
  and rehearse migration `20260815120000_delivery_fraud_findings` on a populated
  Neon branch/clone through a direct deploy-role DSN. Prove the exact
  identifier-safe runtime grant and denial matrix through the pooled
  API/worker role; never place either DSN in a client build, logs, Bedrock, or
  repository files.
- [ ] Execute the hard-drain production cutover: PITR marker, zero Render API
  and Northflank realtime/on-demand/scheduled/ad-hoc writers, migration status,
  unchanged deploy, matching image in `recovery_only`, anomaly/reconciliation
  postflight, and response-loss/audience/outbox canaries.
- [ ] Return server-only `FINANCE_RUNTIME_MODE` to `normal` only through an
  intentional, recorded decision after every canary passes. Keep
  `PAYOUT_EXECUTION_ENABLED=false` until its separate provider and governance
  gate is approved.

## Deferred launch-readiness findings (2026-08-11)

The 2026-08-11 launch-blocker hardening change set is limited to the nine
approved communication, settlement-risk, financial-document, concurrency, and
marketplace-provenance fixes. The following audit findings remain open and must
not be represented as solved by that change set:

- [ ] Design and certify a return-to-original-payment refund state machine.
  Internal wallet restoration is not an external cash refund; the future flow
  needs durable Stripe request/evidence states, immutable idempotency binding,
  ambiguous-outcome recovery, reconciliation, and customer-visible status.
- [ ] Replace staging-grade deployment assumptions with schema-before-code
  release orchestration, dependency readiness checks, external paging, and a
  tested Neon/object-storage backup and restore runbook. The worker is operated
  on Northflank outside this repository by owner decision; its deployment and
  secrets still require separately retained evidence. A successful application
  build is not deployment-safety evidence.
- [ ] Finalize the operating entity, address, governing law, forum, privacy and
  tax review, and approve one exact payout country/currency corridor before any
  paid public launch. Provider availability must be verified for that precise
  business, account, recipient, and corridor combination.
- [ ] Obtain written payment-provider underwriting and enforce a documented SEO
  link-qualification/content policy. Marketing and product behavior must not
  imply provider approval or allow paid placements to pass ranking credit in
  conflict with applicable search-engine policies.

Until those controls are implemented and evidenced, the public paid-production
and broad multicountry launch decisions remain **NO-GO** even if the nine code
fixes in the current hardening set pass CI.

## Support messaging follow-ups (2026-08-14)

- [ ] Add an isolated Playwright fixture with customer, authorized publisher,
  assigned Operations, and Super Admin sessions, then execute the browser gate
  recorded in `docs/SUPPORT_MESSAGING.md` and `Work/risks.md`.
- [ ] Replace the staff Support inbox's bounded offset pagination with the same
  stable keyset-cursor contract used by external inboxes before queue volume
  makes deep offsets or concurrent page drift material.
- [ ] Measure the production Support message access path and, if warranted by
  query plans or volume, add a reviewed migration for a composite
  `(ticketId, visibility, createdAt, id)` index; do not add speculative indexes
  without populated-data rehearsal and write-amplification evidence.

Forward roadmap. `bedrock/Views/audits/platform-audit-2026-06-22.md` is a
historical snapshot, not current status. Open work in this file is canonical.

**Phase 8.X closure progress (completed so far):** #1 (Phase 8.1), #2 (Phase 8.2), #3 (Phase 8.3), #6 (Phase 7.10.2.1), #38 (Phase 8.7), #39 (Phase 8.x), #40 (Phase 8.8), #41 (Phase 8.9).

**Current phase:** Phase A complete (A1 Revenue SQL, A2 Redis client separation, A3 Backend observability).

**Closure contrast:** The audit dashboard was over-reported as 41/41 closed; the backlog still reflected this inaccurate earlier state for visibility. The canonical source is now the updated audit §12 reflecting 18 closed of 41.

## Current finance follow-ups (2026-07-29)

- [ ] Rehearse and execute the evidence-migration maintenance window: hard
  drain old API/workers, apply ordered payout/dispute migrations, start only
  the matching image, use a sanitized populated clone, require zero
  `pg_constraint.convalidated = false` financial constraints, run incident
  queries, and use forward-fix rollback. The local PostgreSQL rehearsal passes
  both fail-fast lock barriers, seven isolated aggregate-corruption cases, the
  PENDING-invite non-attribution case, successful backfills, and final
  assertions; sanitized staging/production evidence is still required.
- [ ] Complete the signed Stripe staging matrix for full-balance withdrawal,
  exact create-response/status-poll/webhook payout amount/currency/account
  evidence, pre-provider abort versus typed cancellation, checkout redelivery
  after a claimed-event crash, every wallet-credit-backed derivative deposit
  status, persisted `livemode`, normalized-claim mutation/lease/maker-checker
  denial, and late-failure quarantine.
- [ ] Exercise and alert the production finance mode matrix. Prove
  `recovery_only` permits only reads, inbound evidence, exact recovery, and
  reconciliation; prove `locked` permits only reads/inbound evidence; document
  the evidence and approver required to return to `normal`.
- [x] Add an independent authenticated Stripe deposit catch-up aggregate.
  Completed in the 2026-08-12 correctness batch: restricted-key Checkout →
  PaymentIntent → Charge retrieval, append-only evidence, fenced retries, and
  the same serializable finalizer used by signed webhooks. Staging provider
  rehearsal remains an operational release gate.
- [ ] Add bounded provider revalidation and an incident-reviewed compensation
  design for contradictory late payout failure; never auto-reopen a completed
  withdrawal or rewrite `lifetimePaid`.
- [ ] Design a reviewed chargeback recovery/netting aggregate for `LOST`
  uncovered exposure before attempting to consume future wallet credits.
  Define multi-case allocation order, immutable ledger/audit evidence,
  refund/deposit source policy, idempotency, reconciliation, and terminal-case
  lifecycle changes. Until then, keep reservation fail-closed and never edit
  `currentExposureAmount` or balances ad hoc.
- [ ] Keep Wise automated send/completion/replay disabled until provider
  amount/currency evidence, terminal mapping, idempotency retention,
  cancellation, reconciliation, sandbox, and Finance/Security certification
  gates pass.
- [x] Implement hard payout-key rotation in code: versioned key identities,
  legacy decrypt-only support, a bounded resumable compare-and-swap rotation
  command covering active and inactive methods/providers, verification, and a
  rollback window are present as of 2026-08-12.
- [ ] Provision a managed KMS/HSM-backed key-provider adapter, migrate the
  production keyring out of raw environment secrets, and rehearse rotation on
  a sanitized production-shaped clone. The static environment adapter is for
  controlled transition/development use and is not KMS protection.

## Phased Engineering Roadmap (v1.0) — 2026-06-30

Replaces Phase 8.X bundles. Organized into Phase A (correctness), Phase B (reliability), Phases C–D (operational tuning + scaling).

### Phase A — Correctness (DONE 2026-06-30)

- [x] **Phase A1 — Revenue SQL refactor** (#10). Refactored `groupByMonth` in `revenue.service.ts` from brittle ternary-based `$1`/`$2` arithmetic to safe `clauses[] + params[]` accumulation. Eliminates human-reasoning risk when adding future range clauses. Tests unchanged (behavioral identical).
- [x] **Phase A2 — Redis client separation** (#8). Split `redis-client.ts` into `getRedisClient()` (HTTP context: `maxRetriesPerRequest: 5`, `connectTimeout: 10s`, exponential-backoff `retryStrategy` capped at 30s, give up after 15 attempts) and `getQueueConnection()` (BullMQ context: same timeouts but `maxRetriesPerRequest: null` per BullMQ requirement). Worker `redis.ts` gained same `connectTimeout` + `retryStrategy`. QueueService switched to `getQueueConnection()`.
- [x] **Phase A3 — Backend observability**. Enhanced API `/api/v1/health/ready` with Redis PING + Prisma `SELECT 1` dependency checks. Added `/api/v1/metrics/queues` endpoint mirroring worker queue depths. Added structured logging to RevenueService (query params + results + currency mismatch warnings).

### Phase B — Reliability (pending Phase A exit review)

- [ ] **Phase B1 — Prisma pool env-var parameterization** (#7). Document per-replica formula; expose `PRISMA_POOL_MAX` env var (default 25); add 80% utilization telemetry. Requires telemetry evidence before implementation per roadmap constraint.
- [ ] **Phase B2 — DNS rebinding pipelining guard** (#9). Add `pipelining: 0` to the shared safe-fetch Agent. Requires reproducible exploit test before implementation per roadmap constraint.
- [ ] **Phase B3 — QueueService initialization race** (#5). Move `queueServiceRef = app.get(QueueService)` guard to eager initialization or switch to `OnModuleInit`.

### Phase C — Operational Tuning

- [ ] **Phase C1 — Worker observability gaps** (#14 body-cap structured log `reason: 'body_size_exceeded'`, #18 reconciliation dedup logged as per-sweep not cumulative).
- [ ] **Phase C2 — Database hardening** (#11 enum-drift static specs for partial-unique WHERE clauses, #12 CASCADE→SetNull on TicketMessage/Notification userId, #13 payout key-rotation runbook).
- [ ] **Phase C3 — Infra/CI cleanup** (#15 mailpit healthcheck + worker HEALTHCHECK, #17 PR/workflow postgres:17-alpine consolidation, #19 JWT_SECRET hard check).
- [ ] **Phase C4 — Frontend polish** (#20 raw `<img>` → `Image`, #21 duplicate `statusVariant()`, #22 `publisherAmount` zero-value docs, #31 structured-logger context-size cap).
- [ ] **Phase C5 — Index + schema maintenance** (#23 `@@index([customerId])` on Order, #24 `@db.Timestamptz` on createdAt columns, #32 turbo.json inline rationale).
- [ ] **Phase C6 — Logging + runbook hygiene** (#27 `console.warn` → logger in dev job-signing, #36 runbook worker-fleet automation, #37 repeatable-job-registry drift boot-time assertion).

### Phase D — Post-Beta Scaling

- [ ] Double-entry ledger (escrow / revenue accounts)
- [ ] Item-level settlements
- [ ] Provider-side payout reconciliation
- [ ] WebsiteVerification (DNS TXT) gate
- [ ] Order accept/delivery deadline auto-cancel

**Medium (18):** see `bedrock/Views/audits/platform-audit-2026-06-22.md` §2 findings #20 through #37. Cluster opportunistically; many are 1-commit fixes (status-presentation adoption, env-var docs, console→logger).

## Older items (carried over)

**2026-06-16 roadmap pivot** (post-Phase-7.7): future work is bundled into Phase 7.8 (Security Hardening) and Phase 7.9 (Frontend Quality & Accessibility) per the project-direction prompt. Phase 7.6.1 is approved but deferred into 7.9.

## Next (named follow-ups from the batch)

- [x] **Phase 7.7.x — complete structured-logger sweep.** ✅ DONE 2026-06-16 (commit `5af902c` on PR #1). All 8 worker files swept (85 callsites → logger.*); 4 stale `.js`/`.map` build artifacts removed; allowlist trimmed to forever-allowed entries only (`apps/api/src/main.ts` boot fallback + 3 browser `auth.tsx`).
- [x] **Phase 7.7.y — fix 3 pre-existing failing test specs** ✅ DONE 2026-06-16 (PR #4 merged, 3 commits `aa8cd55` + `74c8d51` + `b670493`). All 3 specs' mocks updated to match Phase 6.x production behavior; `testPathIgnorePatterns` back at jest default; apps/api jest now 33 suites / 478 tests with zero skips. No production code changed.
- [x] **Phase 7.13.1 — `Settlement(status, reviewEndsAt)` composite index** via `CREATE INDEX CONCURRENTLY`. ✅ DONE 2026-06-20 (commit `24192b4`, PR #12 merged). First production exercise of Prisma 7's non-transactional migration model (Gate 0: ARCHITECTURE.md + maintainer confirmation in prisma#14456; Gate 0.5: empirical probe on prisma@7.8.0 with `indisvalid = t`). schema.prisma NOTE comment extended to document both raw-SQL-only indexes (existing partial unique + new composite). EXPLAIN ANALYZE on dev DB (60 rows) correctly shows Seq Scan; composite engages at prod scale.
- [x] **Phase 7.13.2A — `MarketplaceFavorite` NULLS NOT DISTINCT companion unique** ✅ DONE 2026-06-20 (commits `2823b6a` + `e3bf908` + `f84b46c`, PR #13 merged). Closes Phase 7.12.1 TOCTOU race at the DB level. Single `CREATE UNIQUE INDEX CONCURRENTLY ... NULLS NOT DISTINCT` migration alongside the existing NULLS DISTINCT unique; app-layer rewrite at `marketplace.service.ts:1066-1071` from `findFirst + create` to `try { create } catch (P2002) { findFirst }` (Plan B; Gate 0.5 ruled out Plan A `upsert` because Prisma 7's WhereUniqueInput rejects `null` for nullable composite-key parts). schema.prisma NOTE on MarketplaceFavorite documents both indexes between 7.13.2A and 7.13.2B. apps/api jest favorites spec: 15 → 19 cases (4 new static-source assertions for the try/catch shape + migration + NOTE).
- [x] **Phase 7.13.2B — drop original `MarketplaceFavorite_userId_listingId_serviceType_key` + rename new index to canonical** ✅ DONE 2026-06-20 (commit `4e93b6d` + `4e534f6`, PR pending — merge gated on Phase 7.13.2A staging soak clean). **Plan deviation: split into TWO single-statement migrations** instead of the single combined migration the plan called for — Gate 0.5B surfaced that prisma@7.8.0's migrate runner wraps multi-statement files in a transaction, which causes DROP INDEX CONCURRENTLY to error. Plan's "STOP and split" fallback rule pre-anticipated this; executed accordingly. part-1: `DROP INDEX CONCURRENTLY IF EXISTS "MarketplaceFavorite_userId_listingId_serviceType_key"`. part-2: `ALTER INDEX "MarketplaceFavorite_uniq_nullsnotdistinct" RENAME TO "MarketplaceFavorite_userId_listingId_serviceType_key"`. Gate 0 (dev) confirmed original is stand-alone INDEX (no pg_constraint row); operator MUST re-verify on staging + prod before deploy. schema.prisma NOTE reduced to single-canonical-index post-7.13.2B wording. apps/api jest favorites spec: 19 → 20 cases. **Pattern-broadening for future Phase 7.x**: any migration combining `* CONCURRENTLY` with another statement MUST be split into separate single-statement files.
- [x] **Phase 7.13.2 (umbrella) — ✅ DONE** 2026-06-20 (7.13.2A merged PR #13; 7.13.2B in flight). Closes the Phase 7.12.1 TOCTOU race at the DB level. One unique index over `(userId, listingId, serviceType)` with NULLS NOT DISTINCT semantics, named canonically. Race is structurally fixed.
- [x] **Phase 7.14 — #23 fulfillment claim race fix** ✅ DONE 2026-06-21 (commits `590d956` + `837c9ff` + `24cdaa5`, PR pending — merge gated on Phase 7.13.2B's 24h staging soak clean + operator Gate 0 dupe sweep returning 0 rows on all envs). Single-statement `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "FulfillmentAssignment_orderId_active_unique" ON "FulfillmentAssignment"("orderId") WHERE status IN ('ASSIGNED', 'IN_PROGRESS')` (single-statement requirement enforced per 7.13.2B finding). Gate 0.25 enumeration found 3 `upsertAssignment` callers (claim/assign/reassign), NOT 1 — plan's decision matrix selected per-caller try/catch with caller-specific messages (claim: "Order is already assigned"; assign+reassign: "Order assignment changed concurrently — refresh and try again"). Gate 0.5 verified the CONCURRENTLY + WHERE-clause combination on prisma@7.8.0 with full predicate coverage on probe (ASSIGNED+ASSIGNED, IN_PROGRESS cross-state, IN_PROGRESS+IN_PROGRESS, terminal release, DELIVERED excluded). apps/api jest: +6 new spec cases. **Closes the 2026-06-15 audit batch at 31/31 (100%).**

## Phase 7.13 — Prisma 6.19.3 → 7.8.0 + driver-adapter migration ✅ DONE

- [x] **Bump prisma + @prisma/client 6.19.3 → 7.8.0; add @prisma/adapter-pg + pg + @types/pg** ✅ DONE 2026-06-20 (commit `2ca6f70`). Touched both PrismaClient instantiation sites: `packages/database/src/index.ts` singleton + `apps/api/src/common/prisma.service.ts` NestJS service. Pool tuning (`max: 25`, `idleTimeoutMillis: 20_000`) moves from `?connection_limit=25&pool_timeout=20` URL params into the `PrismaPg(PoolConfig)` form. `buildDatasourceUrl` helper deleted. Removed `url = env("DATABASE_URL")` from `schema.prisma` + `engine: "classic"` from `prisma.config.ts` + `cp src/prisma/*.node` from `db:build` (no native binary under WASM Query Compiler). 74 files / +1152 −383.
- [x] **Rename Decimal import path: runtime/library → runtime/client** ✅ DONE 2026-06-20 (commit `5d6f49b`). Mechanical sweep across 15 apps/api files (4 production services + 11 specs). Single-pattern sed, 15/+15/-15.
- [x] **Worker `$disconnect` on graceful shutdown** ✅ DONE 2026-06-20 (commit `73b88cd`). Pre-existing gap surfaced + made load-bearing by the adapter migration — `apps/worker/src/index.ts:263-279` shutdown never released PrismaClient connections (fine under classic Rust engine, leaks under node-pg Pool). Slotted between health-server close and Sentry.flush. 1 file / +5 lines.
- [x] **Phase 7.13.x follow-up — `createPrismaClient()` unification helper** ✅ DONE 2026-06-21 (commit `99cf1ec`, PR pending). Dual-helper design: `createPrismaClient()` for direct-instantiation sites + `createPrismaAdapter()` for the NestJS `super(...)` callsite (PrismaService extends PrismaClient, can't substitute the full helper). Both helpers exported from `@guestpost/database`. Both production sites adopted; worker unchanged (still uses global singleton). Added `if (!DATABASE_URL) throw "DATABASE_URL is required"` runtime guard converting confusing first-query failures into clear startup errors. apps/api jest +7 cases (4 runtime contract + 3 static-source adoption assertions).
- [x] **Schema-drift cleanup follow-up — orphaned `EscrowStatus` enum** ✅ DONE 2026-06-21 (commit `cc0d713`, PR pending). **Scope expanded** during recon — the original "drop the orphan enum" framing missed that the enum has a live column dependent (`Escrow.status`) AND that the `Escrow` table is also orphan (0 rows on dev; no schema.prisma model; no current-migration or code references). Single-statement DROP TABLE + DROP TYPE migration; both `IF EXISTS` for cross-env safety. The retired pre-baseline migration history contained ZERO matches case-insensitive — the original creating migration was deleted or made via a one-off `prisma migrate dev` run never committed. Two-path migration replay verified: PATH A (fresh DB) no-ops; PATH B (drift-repro via `CREATE DATABASE ... TEMPLATE guestpost`) actually fires.

Mission: Foundational dep upgrade / unlocks the audit's named "most valuable uncompleted roadmap item" / enables 7.13.1 + 7.13.2 + 7.14 fast-follows via `CREATE INDEX CONCURRENTLY` (prisma#14456).

## Phase 7.8 — Security Hardening Batch (per 2026-06-16 roadmap) ✅ DONE

- [x] **#26 — Email-keyed rate limiter** on auth endpoints. ✅ DONE 2026-06-17 (PR pending; commits `7a12a1e` + `f3fe975`). Better Auth plugin layers per-`SHA-256(email)` Redis counter on 4 verified endpoints (`/sign-in/email`, `/sign-up/email`, `/sign-in/magic-link`, `/request-password-reset`) on top of the existing per-IP Express limiter. Generic 429 byte-identical between layers (no enumeration oracle).
- [x] **#27 — Job-signing `iat` validation / replay protection** ✅ DONE 2026-06-17 (**Deploy A**; commits `058fa7e` + `f489e2e`). `signJobPayload` injects `iat`+`v: 1`; `verifyJobPayload` enforces 24h default freshness (per-queue overrides: delivery-verification 96h, payout 72h). Centralized `apps/worker/src/repeatable-job-registry.ts` with drift guard handles cron-payload reuse via `maxAgeMs: 0` bypass.
- [x] **§5.8 sub-finding — `hasAuthCredentials()` cookie sniff** ✅ DONE 2026-06-17 (commit `81174ee`). Regex written against captured Better Auth signed-cookie shape; 14-case unit test.
- [x] **#25 — Email-verification gate** ✅ DONE 2026-06-17 (commit `4dbfd67`). AuthGuard rejects state-changing methods on non-exempt customer routes when `emailVerified=false`. Bundled into Phase 7.8 per "related auth/session follow-ups".
- [x] **Deploy B — flip `allowMissingIat` default to `false`** ✅ DONE 2026-06-18 (commit `0e9eca1`). One-line flip in `ROLLOUT_DEFAULTS` plus docblock + 2 spec assertions rebadged. Pre-flight greps confirmed (a) no production callsite passes `allowMissingIat` explicitly and (b) all 10 worker processors emit the standard `"job signature invalid — rejecting"` log on a verify-failure (set-equality with `verifyJobPayload` callsites). The opt-in survives as an explicit emergency-rollback arg on `verifyJobPayload`. PR scheduled to merge ≥48h after Phase 7.8 (i.e. ≥ 2026-06-19 17:38 UTC).

Mission: Authentication / Authorization / Replay protection / Anti-abuse in one cohesive phase. **Status: complete (Deploy A + Deploy B both shipped).**

## Phase 7.12 — Marketplace Correctness Bundle (#16 + #17 + #18 + #20 + #24) ✅ DONE

- [x] **#16 — `removeFavorite` blasts service-scoped waitlist favorites** ✅ DONE 2026-06-18 (commit `04969b6`). Scoped to `serviceType: null`; new `removeFavoriteService` for service-scoped removal.
- [x] **#17 — No endpoint to create service-scoped (WAITLIST notify-me) favorite** ✅ DONE 2026-06-18 (commit `04969b6`). `addFavorite(userId, listingId, serviceType?)` + `CreateFavoriteDto.serviceType` + new `DELETE /favorites/:listingId/services/:serviceType` route with `ParseEnumPipe`. Service-existence pre-check rejects favorites scoped to PAUSED services. Phase 6 WAITLIST fan-out logic (existed for years at `marketplace.service.ts:728-749`) finally has an entry point.
- [x] **#18 — Auto-assignment writes customer's userId instead of the staffer** ✅ DONE 2026-06-18 (commit `1913b6e`). `assignedByUserId: snapshot.managedByUserId` (self-assignment by the system). The `auto: true` metadata flag still disambiguates.
- [x] **#20 — Favorites page shows $0 (response missing `services`)** ✅ DONE 2026-06-18 (commit `04969b6`). `getFavorites` includes services filtered to non-PAUSED, ordered by price asc.
- [x] **#24 — Platform website + auto-listing defaults wrong** ✅ DONE 2026-06-18 (commit `74857fc`). `verificationStatus: WebsiteVerificationStatus.VERIFIED` on platform website (matches schema comment); auto-listing `status: ListingStatus.DRAFT` (no more zero-service APPROVED listings going live).
- [x] **Phase 7.12.1 follow-up — harden `MarketplaceFavorite` against duplicate-create race** ✅ CLOSED 2026-06-20 by Phase 7.13.2A (commits `2823b6a` + `e3bf908` + `f84b46c`). DB-level race-proofing via the new `MarketplaceFavorite_uniq_nullsnotdistinct` index with NULLS NOT DISTINCT semantics + Plan B app-layer (try/create/catch/findFirst). The umbrella Phase 7.13.2 stays open until 7.13.2B drops the original NULLS DISTINCT index.

Mission: Marketplace correctness / closing the audit's remaining High findings except #23 / closing audit dashboard from 25/31 → 30/31 (97%).

## Phase 7.11 — Worker SSRF + DoS Hardening (#13 + #14) ✅ DONE

- [x] **#13 — Delivery-verification no response-body size cap** ✅ DONE 2026-06-18 (commits `0d954c5` + `5c5090d`). New `readBodyWithCap(res, maxBytes)` in `@guestpost/shared` streams the body, cancels the reader on overrun, throws `SafeFetchError("BODY_TOO_LARGE")`. Cap = 5MB in both worker fetch processors.
- [x] **#14 — DNS rebinding in SSRF guard** ✅ DONE 2026-06-18 (commits `0d954c5` + `5c5090d`). New `safeFetch()` in `@guestpost/shared` uses an undici Agent whose `connect.lookup` callback resolves DNS AND validates the resolved IP against `PRIVATE_IP_PATTERNS` inside the same callback. Connection binds to the validated IP — no TOCTOU window for AWS metadata bypass. Pure `validateResolvedAddress(hostname, address)` function lifted out for direct testability.
- [x] **Bonus — IPv4-mapped IPv6 patterns** ✅ DONE 2026-06-18. `PRIVATE_IP_PATTERNS` gains 6 new patterns covering `::ffff:127.0.0.1` style addresses that the legacy local duplicates missed.
- [x] **Adoption regression guard** ✅ DONE 2026-06-18 (commit `5c5090d`). `apps/api/src/__tests__/phase-7-11-safe-fetch-adoption.spec.ts` greps `apps/worker/src/processors/*.ts` for the deleted forbidden patterns + bare `await res.text()`. Failure message includes the rule's `why` so a future copy-paster sees the explanation.

Mission: Worker security hardening / shared safe-fetch primitive / defense-in-depth against SSRF + DoS.

## Phase 7.10 — Email Verification Flow (closes the Phase 7.8 #25 loop) ✅ DONE

- [x] **Wire Better Auth `emailVerification` block end-to-end** ✅ DONE 2026-06-18 (commits `77aeb99` + `882fc99` + `b0bd628`). Phase 7.8 #25 shipped the AuthGuard gate as a one-way trapdoor — no verification email was ever sent, so email/password signups were locked out indefinitely with no recovery path. Phase 7.10 wires `sendEmail` + `onEmailVerified` factory options on `createAuth` → Better Auth's `emailVerification.sendVerificationEmail` enqueues via the worker email queue; `sendOnSignUp: true` triggers automatically; `autoSignInAfterVerification: true` lands users back in `/dashboard`; `afterEmailVerification` invalidates the AuthGuard auth-context-cache immediately (no 30s stale-cache window). Customer-facing banner with 60s client cooldown + Resend button mounted in portal dashboard layout. Presentational shell at `packages/ui/src/components/email-verification-banner.tsx` so future publisher/admin verification gates (KYC, 2FA) can reuse without copy-paste.
- [x] **Phase 0 spike — verify Better Auth 1.6.14 contracts** ✅ DONE 2026-06-18. Found `emailVerification.afterEmailVerification(user, request?)` purpose-built callback at `@better-auth/core/dist/types/init-options.d.mts:528` — simpler than `databaseHooks.user.update.after` (no previous-row inspection, fires only on the verification transition). Confirmed `/api/v1/auth/send-verification-email` accepts `{ email, callbackURL? }` per its Zod body schema. `sendOnSignUp` lives in `emailVerification`, not `emailAndPassword`.
- [ ] **Phase 7.10.1 follow-up — admin "manually mark customer verified" action.** Speculative; defer until real support burden surfaces. If a customer can't receive emails (deliverability issue, typo in signup) they're stuck unless admin can override. One-line admin endpoint + RBAC gate + audit log entry.
- [x] **Phase 7.10.2 — Nest + supertest integration test infrastructure** ✅ DONE 2026-06-21 (commits `25e0d4f` + helpers + factories + spec + bedrock, PR pending). Greenfield harness — first real-DB integration tests in the codebase. Jest projects feature splits unit (existing 47/652 baseline preserved) + integration (new); `pnpm test` stays as the fast feedback loop, `pnpm test:integration` runs the new project, `pnpm test:all` runs both. TEMPLATE-clone DB isolation from dedicated `guestpost_test_template` (~150ms per test; supports parallel workers per Gate 0.5). 3 pre-flight gates all passed empirically: Gate 0.25 (AppModule boots under TestingModule in 1999ms), Gate 0.5 (8 parallel template clones in 1139ms), Gate 0.75 (DATABASE_URL env mutation reaches PrismaService cleanly). Spec 1 ships: Phase 7.14 #23 claim race as a 5-caller `Promise.allSettled` integration spec — the manual-smoke from PR #15 is now an automated test (1 fulfilled + 4 ConflictException + activeCount=1, end-to-end against a real DB). apps/api jest: 47/652 → 48/653.
- [ ] **Phase 7.10.2.1 — Spec 2 (queue GET happy-path) + TestAuthGuard + supertest api-client.** Deferred from the 7.10.2 PR for shipping velocity. Builds the HTTP-layer integration capability: `TestAuthGuard` reads `X-Test-User-Id` header + looks up the User in DB + attaches `request.user` with the shape the real AuthGuard produces; `apiClient(app, userId)` wraps supertest pre-setting the header; Spec 2 hits GET `/api/v1/orders/operations/fulfillment-queue` and asserts PLATFORM orders are returned + PUBLISHER orders are excluded.
- [ ] **Phase 7.10.2.2 — split AppModule into per-feature TestModules at 20+ specs.** AppModule boot is currently ~2s per spec — fine at 1-2 specs, becomes the dominant runtime cost as the integration suite grows. When the suite hits 20+ specs, refactor to `OrdersTestModule`, `BillingTestModule`, `PublisherTestModule`, etc. that import only their feature module + needed providers. Defer until the suite actually justifies the rework.
- [ ] **Phase 7.10.2.x — convert Phase 7.12 favorites manual-smoke race to integration spec.** Named gap from `apps/api/src/__tests__/phase-7-12-favorites-correctness.spec.ts:21,247-263` ("Promise.all of 5 concurrent INSERTs, assert exactly 1 row + 4 P2002"). Same 5-caller shape as Spec 1; should be a fast-follow now that the harness exists.

Mission: Auth UX completeness / closing the Phase 7.8 #25 lockout / shared verification UI primitive.

## Phase 7.9 — Frontend Quality & Accessibility (per 2026-06-16 roadmap) ✅ DONE

- [x] **#28 — Status-color centralization** ✅ DONE 2026-06-18 (commits `0a48f23` + `ea29e26`). Typed `STATUS_PRESENTATION` tables backed by Prisma enums + 5 per-family accessors in `@guestpost/ui`. Cross-family confusion fails `tsc`. 9 status pages migrated.
- [x] **#29 — Unused shared component adoption** ✅ DONE 2026-06-18 (commit `36fc4ee`). `<SupportPanel>`, `<FulfillmentChannelBadge>`, `<BriefRenderer>` all have real consumers; `OrderSupportPanel` hand-roll + 2 local `ChannelBadge` definitions deleted. Adoption regression guard at `packages/ui/src/components/__tests__/shared-component-adoption.test.ts`.
- [x] **#30 — Hooks-rule violation in publisher listings page** ✅ DONE 2026-06-18 (commit `510993b`). 4 inline `useMutation` calls + `lifecycleOpts(label)` helper. Bonus: ESLint rider surfaced + fixed 9 additional latent rules-of-hooks violations in `apps/admin/marketplace/page.tsx`.
- [x] **Phase 7.6.1 — Drawer a11y polish** ✅ DONE 2026-06-18 (commits `8c9d868` + `e90ea34`). New `<Drawer>` on Radix Dialog provides focus trap + Escape + scroll-lock + `aria-modal` + focus restore. 3 dashboards ported; portal layout also gained the pathname-auto-close it was missing since Phase 7.6.
- [x] **ESLint rider** ✅ DONE 2026-06-18 (commit `510993b`). Root `eslint.config.mjs` (tight rule set) + `lint` scripts on portal/admin/publisher + CI steps in both workflows. Catches future rules-of-hooks regressions at PR time.

Mission: Frontend consistency / Accessibility / Maintainability / Shared patterns.
- [ ] **Phase 7.0.1 observability follow-ups.** Three small items, can batch into one migration / one PR:
  - Promote `requestId` from `AuditLog.metadata` JSON to a dedicated indexed column + backfill
  - Structured logger to replace `console.log` across api+worker (then `requestId` is grep-able in plain logs, not just Sentry context + audit DB)
  - Source-map upload via `SENTRY_AUTH_TOKEN` in CI (one-line `withSentryConfig` flip + `@sentry/cli` `pnpm-workspace.yaml` true-flip)
- ~~**#26** Email-keyed rate limiter~~ — **CLOSED** by Phase 7.8.
- ~~**#27** Job-signing `iat`~~ — **CLOSED** by Phase 7.8 (Deploy A + Deploy B).
- ~~**#28** Status-color centralization~~ — **CLOSED** by Phase 7.9.
- ~~**#29** Unused shared component adoption~~ — **CLOSED** by Phase 7.9.
- ~~**#30** Hooks-rule violation~~ — **CLOSED** by Phase 7.9.

## Later (Phase 7.x.x candidates — only if asked)

- [ ] **Revenue dashboard ergonomics** (if Finance asks): Recharts trend visualizations (`next/dynamic` to avoid bundle inflation), `groupBy=publisherId`, scheduled email reports, user-timezone toggle, multi-currency split.
- [ ] **Metrics layer** if Phase 7.0 structured logs become insufficient: prom-client OR OpenTelemetry-compatible collector reading from the `[SETTLEMENT_AUTO_APPROVE] runs_total=…` and `[NOTIFICATION] deduped key=…` structured lines. Deliberately deferred until existing log discipline proves insufficient.
- [ ] **Cache-key sweep**: settlements/withdrawals/reconciliation/payouts admin pages use bare `["X"]` keys instead of the consistent `["admin", "X", filters]` pattern set by Phase 7.1's Revenue tab. Drift-prone; ergonomic cleanup.
- [ ] **Reconcile portal `TicketDetail` shape** with api-client. Phase 7.1 sibling fix used `as unknown as` to bridge; the two shapes should be unified rather than cast.

## Strategic / re-architecture (long-horizon)

- [ ] **Double-entry ledger** (escrow / revenue accounts) replacing the current single-entry + reconciliation-detector pattern. Provable money conservation, dual-side audit trail, scales better for accounting.
- [ ] **Item-level settlements** if the platform ever supports multi-website orders. Today's one-website-per-order invariant keeps order-level settlements correct.
- [ ] **Provider-side payout reconciliation** (compare Wise / Stripe transfer list vs `PayoutExecution` rows). Catches orphan provider transfers that the local DB doesn't know about.
- [ ] **WebsiteVerification (DNS TXT)** required before listing approval. Phase 7-ish work touched verification triggers but the gate to require it before approval isn't enforced yet.
- [ ] **Order accept/delivery deadlines + timeout sweep** — SUBMITTED orders currently wait forever (reconciliation detector flags them but no auto-cancel).

## Constraints (cross-phase policies)

1. Every change must include regression tests.
2. No infrastructure tuning without measurable justification.
3. Phase A must complete before Phase B begins.
4. Phase A exit review required before authorizing Phase B.

## Acceptance / ops gaps (carried from prior batches, still open)

- [ ] **VPS-or-cloud shared-dev hosting decision.** Batch 24 confirmed dev stack is too heavy for 2GB RAM. Options: bigger VPS (4GB+), cloud sandbox (Railway / Fly / Render), or production-build-only deployment (`next start` not `next dev`). Today: laptop-only.
- [ ] **Docker image build OOM on 8GB local Docker VM.** Container builds validated through install but final `nest build` OOMs. Open: build on ≥4GB CI runner, then push GHCR.
