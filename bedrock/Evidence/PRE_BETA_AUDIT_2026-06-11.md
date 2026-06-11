# GuestPost.cc Final Pre-Beta Platform Audit (A–Z)

Date: 2026-06-11
Auditor: Claude (CTO-level full-stack audit)
Method: evidence-only — live builds, live test suites, live DB probes, line-level code review. No findings reported without file:line evidence or executed proof.

---

## PART RESULTS

| # | Part | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Build & Deployment | **PASS (build) / FAIL (deployment)** | 11/11 turbo targets green. Zero broken imports. But: no Dockerfiles, no prod compose, no restart policies, `infrastructure/postgres|redis|traefik|monitoring` all empty |
| 2 | Database | **PASS** | 1 squashed migration, `prisma migrate status` clean. 7 CHECK constraints + partial unique `Settlement_orderId_active_key` live in DB. Invalid inserts (negative wallet, negative publisher balance, dup active settlement, zero withdrawal) all rejected by Postgres (executed, rolled back). Zero orphans: 0 dup COMPLETED executions, 0 paid orders without amount, 0 COMPLETED withdrawals without COMPLETED execution. One cosmetic drift: `Order_websiteId_fkey` differs from schema (migrate diff) |
| 3 | Backend Architecture | **PASS** | Module boundaries clean; money mutations all version-guarded `updateMany` inside `$transaction`; single refund path (RefundService) used by admin refund / dispute / force-cancel |
| 4 | Frontend | **PARTIAL FAIL** | Client-side-only route guards (no Next middleware — API is the real boundary, acceptable). Admin app rejects non-STAFF (`apps/admin/src/lib/auth.tsx:80`). But FINANCE role missing from admin FE type (`auth.tsx:23`) and finance nav is SUPER_ADMIN-only (`dashboard/layout.tsx:17`) — FINANCE staff locked out of their own UI. Contract drift: see Part 15 |
| 5 | E2E Business Workflows | **PASS (executed)** | Integration suite re-run live: 26/26 — deposit → order → fulfillment state machine → settlement dual-approval → withdrawal (tier hold enforced) → manual execute → mark-paid → reconciliation zero drift. Refund/dispute/clawback covered by unit tests (115 pass). Chargeback = alert-only (see findings) |
| 6 | Financial Integrity | **PASS w/ caveats** | Concurrency suite re-run live: 16/16 attacks defeated, reconciliation zero drift after all attacks. CHECK constraints enforce non-negative invariants at DB level. Caveats: webhook double-credit race (F-1), no global money-conservation identity check |
| 7 | Multi-Tenancy | **PASS w/ 1 finding** | Wallet ops assert ownership (`billing.service.ts:25-30`); orders/settlements org-scoped server-side; org switch verifies membership + invalidates cache (`active-context.service.ts:43-55`); identity service re-verifies membership per `:id` param. Finding F-3: cross-tenant order idempotency-key leak |
| 8 | RBAC | **PASS** | Global AuthGuard (session verified every request, ban check, membership-validated context). StaffRoles on every admin route. Decrypt double-gated: `@Permissions("FINANCIAL_DATA_DECRYPT")` + PermissionsGuard, SUPER_ADMIN explicitly cannot bypass sensitive permissions (`permissions.guard.ts` SENSITIVE_PERMISSIONS). Guard matrix covered by payout-decrypt-security.spec (26 tests) |
| 9 | Security | **PASS** | helmet + CSP, tiered rate limits, CORS allowlist, ValidationPipe whitelist+forbidNonWhitelisted (mass-assignment blocked), env fail-closed validation, prod insecure-JWT refuse, Stripe webhook `constructEvent` verification, payout webhooks fail-closed (missing secret → 503, bad sig → 401, never enqueued), HMAC-signed queue jobs verified by every worker, AES-256-GCM payout details + redaction of provider errors. `.env.development` not git-tracked |
| 10 | Payouts | **PARTIAL FAIL** | Execution: APPROVED→PROCESSING claimed version-guarded BEFORE provider call; deterministic idempotency key `payout-{id}-v{version}`; retry checks provider truth before re-sending (`payout-execution.service.ts:198-210`). FAIL: webhook payload mapping broken for real provider shapes (F-2); FAILED withdrawal has no reversal path (F-4) |
| 11 | Settlements | **PASS w/ 1 finding** | Dual approval enforced, release version-guarded, debt netted before credit, partial unique index blocks dup active settlement (proven by live insert attempt). Finding F-5: `customerApprove` unguarded status overwrite |
| 12 | Refunds | **PASS** | Idempotent (unique `Transaction.reference` + in-tx double-check), full clawback w/ debt model when settlement RELEASED, platform-order revenue reversal non-destructive (`reversedAt`), wallet credit version-guarded — `refund.service.ts` whole-file review |
| 13 | Concurrency | **PASS (executed)** | 16/16 live: double-pay, over-spend, double-release, withdrawal over-draw, idempotency storm, execute race, double mark-paid — all exactly-once, zero drift. 1000-user load previously proven (151 orders/s, p99 434ms, batch 15) |
| 14 | Workers & Queues | **PASS w/ notes** | BullMQ attempts 3-5 + exponential backoff, failed jobs retained 7d, HMAC payload verification in every worker, startup connection check fail-fast, SIGTERM graceful close. Status poller real (10m repeatable, version-guarded transitions). Notes: `payout-execute` job is a dead no-op handler (no producer); webhook handler dead-on-arrival for real payloads (F-2) |
| 15 | API Contracts | **PARTIAL FAIL** | api-client tolerantly unwraps `{items}` envelopes. But `OrderResponse.items[]` declares `serviceType/topic/budget/assignedTo` — fields the API never returns (OrderItem = price/targetUrl/anchorText/websiteId). Portal dashboard + checkout render permanent "—" (`portal/dashboard/page.tsx:490`, `checkout/[id]/page.tsx:100`) |
| 16 | Notifications | **PASS w/ gaps** | Settlement release, withdrawal lifecycle, chargeback → signed `push-in-app` jobs → Notification rows; queue retries cover transient loss. Gaps: in-app only (email worker exists but money events don't email); enqueued post-commit — process crash between commit and enqueue loses the notification (rare, non-financial) |
| 17 | Audit Logs | **PASS w/ gap** | All critical actions logged: payment, refund, settlement lifecycle incl. approval revocation, withdrawal lifecycle, payout execution start/complete/fail/recover, decrypt (actor/reason/IP/UA), chargeback, role changes. Gap: 18/66 `audit.log` calls pass `tx` — the other 48 are either outside transactions (fine) or in colder in-tx paths (pool-starvation risk under load; hot money paths fixed in batch 15) |
| 18 | Reporting & Reconciliation | **~80% coverage** | Detects: wallet drift, publisher withdrawable drift, stuck PROCESSING (1h/2h), FAILED-without-execution, COMPLETED-without-execution, duplicate COMPLETED, lifetimePaid drift, stuck DELIVERED orders. Blind spots: no global money-conservation identity; debtBalance and lifetimeEarnings drift unchecked; reservedBalance not independently checked; no provider-side compare (orphan Wise/Stripe transfers invisible — documented gap) |
| 19 | Frontend UX | **PARTIAL FAIL** | Core flows wired and e2e-proven (batch 14). Issues: service type renders "—" on portal (Part 15); FINANCE staff cannot reach finance UI; staff badge shows only "Super Admin"/"Operations" |
| 20 | Performance & Scale | **PASS to ~10K users** | Pool 25 + tx timeouts tuned; auth context cached 30s; reconciliation grouped queries; proper composite indexes. Risks at 100K+/1M orders listed below |
| 21 | Technical Debt | **EXCELLENT** | Zero TODO/FIXME/HACK markers across apps+packages. Dead code: `payout-execute` worker handler, deprecated `UserRole`/`MemberRole` enums (documented), `Withdrawal.REVERSED` status defined but never set |
| 22 | Disaster Recovery | **FAIL** | DB/Redis outage at boot → fail-fast (good); Redis outage mid-run → BullMQ reconnects; provider outage → execution FAILED + provider-truth retry (good); crash between provider send and DB write → stale-PROCESSING flag + manual recovery (documented). FAIL: no backups, no monitoring, no alerting, no process supervision, no runbook |

---

## FINDINGS

### F-1 — HIGH — Financial Integrity
**Stripe deposit webhook can double-credit a wallet in a race window**
- File: `apps/api/src/modules/billing/billing.service.ts:180-186`
- Repro: webhook A and B for same `session.id` interleave: B passes `findFirst` dedupe before A commits → A commits → B re-reads wallet (fresh version) → B's increment succeeds → B's `transaction.create` hits P2002 → catch block `return`s **inside** the open transaction → B's wallet increment **commits** with no transaction row.
- Root cause: P2002 handler returns (commit) instead of throwing (abort). The same pattern in `deposit()`/`withdraw()` correctly lets P2002 propagate.
- Business impact: minted money on duplicate webhook delivery (Stripe retries make duplicates routine). Reconciliation wallet-drift check would detect after the fact.
- Security impact: none direct (requires valid signed webhooks).
- Remediation: in the catch at line 180-186, rethrow (or throw a benign abort error) so the transaction rolls back; idempotency is then carried entirely by the unique constraint.

### F-2 — HIGH — Payout Liveness
**Payout webhook processing cannot match real Wise/Stripe payloads — webhook path is effectively dead**
- File: `apps/worker/src/processors/payout.processor.ts:154,173` (`data.providerExecutionId ?? data.id`, `data.status === "COMPLETED"`)
- Repro: real Wise webhook carries the transfer id at `data.resource.id` and state at `data.current_state` (`outgoing_payment_sent`); Stripe payout events carry `data.object.id` and `status: "paid"`. Neither matches `data.id`/`data.status ∈ {COMPLETED, FAILED}` → handler returns `skipped` on every genuine event.
- Contrast: the status poller normalizes correctly via `WISE_STATUS_MAP`/`STRIPE_STATUS_MAP` (`packages/shared/src/payout-status.ts:45,63`).
- Business impact: payout completion latency = poll interval (10 min), not webhook latency; "webhooks are the primary completion signal" (worker comment) is false in practice. No money loss — poller transitions safely.
- Remediation: per-provider payload normalization in `handleWebhook` reusing the same status maps; integration-test against recorded real payloads.

### F-3 — HIGH — Multi-Tenancy / Information Disclosure
**Cross-tenant order leak + creation DoS via globally-unique idempotency key**
- Files: `apps/api/src/modules/orders/orders.service.ts:41-46`; `packages/database/prisma/schema.prisma:472` (`@@unique([idempotencyKey])`)
- Repro: org B calls `POST /orders` with an `idempotencyKey` already used by org A → service returns org A's full existing order (title, instructions, amount, website) with no org check. Also lets an attacker pre-squat predictable keys to hijack/block victims' order creation.
- Root cause: replay lookup is key-only; uniqueness is global instead of per-tenant.
- Remediation: scope to `@@unique([organizationId, idempotencyKey])`; on replay, verify `existing.organizationId === data.organizationId` (else 409).

### F-4 — HIGH — Operations / Funds Availability
**FAILED withdrawal has no reversal path — publisher funds locked indefinitely**
- Files: `apps/api/src/modules/publisher-payouts/publisher-payouts.service.ts:409-423` (reject requires `status: "PENDING"`); `WITHDRAWAL_REVERSAL` written only there
- Repro: withdrawal APPROVED → execute → provider hard-fails (bad bank details) → withdrawal FAILED. Publisher's `withdrawableBalance` was decremented at request time. Only path forward is `retryExecution` re-sending the **same** payout method. No endpoint returns the money to withdrawable so the publisher can fix details and re-request.
- Business impact: publisher support escalations; funds limbo (tracked, not lost). `Withdrawal.REVERSED` enum value exists but is never set.
- Remediation: admin "reverse failed withdrawal" action: FAILED → REVERSED + `WITHDRAWAL_REVERSAL` transaction + withdrawable re-credit (version-guarded, idempotent on transaction reference).

### F-5 — MEDIUM — State Integrity
**`customerApprove` can overwrite a RELEASED settlement back to CUSTOMER_APPROVED**
- File: `apps/api/src/modules/settlements/settlements.service.ts:146-149`
- Repro: customerApprove reads status PENDING (outside tx) → concurrent forceApprove×2 releases the settlement → customerApprove's unconditional `update({status: CUSTOMER_APPROVED})` flips the RELEASED row back.
- Mitigating control: a second release is still blocked — `SettlementApproval @@unique([settlementId, type])` makes the re-approve's `create(type: ADMIN)` throw P2002 and abort, so **money cannot move twice**; only the status field corrupts.
- Remediation: make the update conditional (`updateMany where status in [PENDING, UNDER_REVIEW] + version`), as every other transition already does.

### F-6 — MEDIUM — Chargeback Workflow
**Chargebacks are alert-only: no wallet freeze, no funds hold, no linkage to the deposit**
- File: `apps/api/src/modules/billing/billing.service.ts:97-129`
- `charge.dispute.created` → audit row + staff notifications only. The disputed deposit remains spendable; by the time finance reacts, the org can have spent the money on orders (publisher settlement liability on charged-back funds).
- Remediation (beta-acceptable manual, document it): runbook = immediately freeze org wallet via support action; post-beta: auto-hold `dispute.amount` from `availableBalance` keyed on `payment_intent → session → transaction.reference`.

### F-7 — MEDIUM — Frontend Contract Drift
**api-client `OrderResponse` declares fields the API never returns; portal renders "—"**
- Files: `packages/api-client/src/services/orders.ts:20-28` (`serviceType/topic/budget/assignedTo` on items); `apps/portal/src/app/dashboard/page.tsx:490`; `apps/portal/src/app/dashboard/orders/checkout/[id]/page.tsx:100`
- Backend `OrderItem` carries `price/targetUrl/anchorText/websiteId`; service type lives on `order.type`.
- Remediation: regenerate api-client types from actual controller responses; switch portal reads to `order.type`. Sweep all `.list()` callers (NOW.md already flags this).

### F-8 — MEDIUM — RBAC UI Gap
**FINANCE staff locked out of the finance UI they're authorized to use**
- Files: `apps/admin/src/lib/auth.tsx:23` (staffRole type omits FINANCE); `apps/admin/src/app/dashboard/layout.tsx:17,45` (finance + audit-logs nav `adminOnly` → SUPER_ADMIN only)
- Backend grants FINANCE access to settlements/withdrawals/payouts/reconciliation. The admin FE hides those pages from FINANCE and labels every non-SUPER_ADMIN "Operations".
- Remediation: add FINANCE to the role union; gate nav by role list per item, not `adminOnly` boolean.

### F-9 — MEDIUM — Operations Readiness
**No production deployment, backup, or observability story**
- Evidence: no Dockerfiles anywhere; `infrastructure/{postgres,redis,traefik,monitoring}` empty; compose has healthchecks but no restart policies; no pg_dump/WAL backup job; no alerting (reconciliation must be manually invoked).
- Business impact: a disk failure loses the financial ledger; a crashed worker stays down silently; drift detection depends on a human remembering to call `GET /admin/reconciliation`.
- Remediation before first real dollar: nightly `pg_dump` + offsite copy + restore test; process supervision (systemd/pm2/container restart); cron-driven reconciliation with alert on `ok: false`; uptime monitor on `/api/v1/health`.

### F-10 — LOW — Misc
1. `audit.log` in-tx without `tx` in colder paths (48 call sites unaudited individually; e.g. `settlements.service.ts:176`, `:368`) — pool-starvation class, hot paths already fixed.
2. Auth context cache (30s TTL): ban/role revocation latency ≤30s; no API endpoint to ban a user (DB-only op, no cache invalidation hook).
3. `Order_websiteId_fkey` drift between live DB and schema (cosmetic; re-sync on next migration).
4. `handleExecute`/`payout-execute` worker job: dead no-op handler, no producer.
5. `MarketplaceReview.status` defaults `"APPROVED"` — review spam goes live unmoderated.
6. Money amounts pass through JS `Number` in `submitPayment` (`order-payment.service.ts:24`) — exact for 2-dp values in practice, but Decimal end-to-end is the standard the rest of the codebase already follows.
7. Deprecated enums `UserRole`/`MemberRole` still in schema (documented for removal).
8. Notifications enqueued post-commit — crash window loses them (non-financial).

---

## SCORES (0-10)

| Dimension | Score | Basis |
|---|---|---|
| Backend | 8.5 | Version-guarded money paths, single refund path, idempotency throughout; F-1/F-3/F-5 dent it |
| Frontend | 6.0 | Works e2e, but contract drift, FINANCE lockout, client-side-only guards |
| Security | 8.0 | Layered, fail-closed, insider-threat-aware decrypt; F-3 leak is the blemish |
| Financial Integrity | 8.5 | DB-enforced invariants + live-proven exactly-once under attack; F-1 race + reconciliation blind spots |
| Operations | 3.5 | No backups, no monitoring, no deployment artifacts, manual reconciliation |
| Scalability | 7.0 | Load-proven at 1000 users / 151 orders/s; unbounded reconciliation scans + analytics tables are later problems |
| **Overall Platform** | **7.3** | |
| **Beta Readiness** | **7.5** | with the conditions below |
| **Production Readiness** | **4.5** | blocked on ops + F-1..F-4 |

## LAUNCH RECOMMENDATION: **CONTROLLED BETA**

Conditions (before first external user):
1. Fix F-1 (one-line rethrow) — money-minting race in deposit webhook.
2. Fix F-3 (scope idempotency key per org) — cross-tenant data leak.
3. Nightly DB backup + tested restore; supervised processes; cron reconciliation with alert (F-9 minimum slice).
4. Document + staff the chargeback runbook (F-6) and FAILED-withdrawal manual recovery (F-4).

Beta guardrails: invite-only orgs, deposit cap per org, manual payout execution only (already the default), daily reconciliation review.

## TOP 10 RISKS BEFORE LAUNCH
1. F-1 webhook double-credit race
2. F-3 cross-tenant idempotency leak
3. No DB backups (total ledger loss scenario)
4. No alerting — silent worker death stalls all payouts/notifications
5. F-4 FAILED-withdrawal fund lock → support fires
6. F-6 chargeback funds spendable during dispute
7. F-2 payout completion latency (10 min poll) misread as "payout stuck"
8. Manual-only reconciliation (drift can age for days)
9. F-7 portal showing "—" erodes customer trust on day one
10. F-8 FINANCE staff can't operate finance — SUPER_ADMIN becomes a bottleneck

## TOP 10 RISKS BEFORE 10x GROWTH
1. 48 unconverted in-tx `audit.log` calls → pool starvation on dispute/refund/settlement admin bursts
2. No email channel for money events — in-app only
3. Reconciliation `findMany` full-table scans (all wallets, all COMPLETED/FAILED withdrawals) in memory
4. No provider-side reconciliation — orphan Wise/Stripe transfers invisible
5. Crash window between provider send and DB write (manual recovery only)
6. Single API process, single worker process — no horizontal story
7. Auth cache per-instance — multi-instance deploy reintroduces 3-5 DB queries/request or needs shared cache
8. `MarketplaceListingView/Click` unbounded growth, no archival
9. Review spam (default-APPROVED)
10. No order accept/delivery deadlines — SUBMITTED orders wait forever (capital stuck in escrow)

## TOP 10 RISKS BEFORE 100x GROWTH
1. No double-entry ledger — cached-balance + transaction-log model strains under partial failures at volume
2. Wallet/PublisherBalance version-guard hot-row contention (optimistic-lock retry storms on popular orgs)
3. Reconciliation runtime grows linearly with history — needs incremental/windowed checks
4. Single Postgres — no read replicas, no partitioning (Transaction, AuditLog, OrderEvent are append-heavy)
5. BullMQ single Redis — queue durability and throughput ceiling
6. Payout batching (PayoutBatch model exists, flow unused) needed for fee efficiency
7. Multi-currency: `currency` columns exist but all math assumes USD
8. No idempotent event-sourcing for order state machine — replay/repair tooling absent
9. Marketplace search on Postgres LIKE/index scans — needs a search engine
10. Compliance surface (KYC for publishers, 1099/tax reporting, AML on payouts) — zero tooling today

## IMMEDIATE ACTION PLAN (this week)
1. F-1 rethrow fix + regression test (webhook duplicate race)
2. F-3 composite unique + org check + migration
3. F-5 conditional update in customerApprove
4. Backup cron + restore drill; systemd/pm2 supervision; reconciliation cron + alert
5. F-8 FINANCE role in admin FE (small, unblocks finance staffing)

## 30-DAY ROADMAP
1. F-2 webhook payload normalization with recorded real payloads
2. F-4 reverse-failed-withdrawal admin action
3. F-7 api-client type regeneration + portal field sweep
4. Chargeback auto-hold (F-6) keyed on payment_intent
5. Email notifications for money events
6. Finish audit-in-tx sweep (48 call sites)
7. Order accept/delivery deadlines + timeout sweep
8. Provider-side reconciliation (list Wise/Stripe transfers vs PayoutExecution)

## 90-DAY ROADMAP
1. Double-entry ledger (escrow/revenue accounts) replacing cached-balance reconciliation as source of truth
2. Stripe Connect onboarding flow for publishers (KYC delegated to Stripe)
3. Horizontal deploy: shared auth cache (Redis), multi-instance API/worker, container images + CI/CD
4. Incremental reconciliation + finance dashboard with drift trends
5. Multi-currency groundwork or explicit USD-only enforcement at DTO layer
6. Data lifecycle: archival for views/clicks/audit, table partitioning plan
