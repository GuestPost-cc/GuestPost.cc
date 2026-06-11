# Current Focus
**Status: Beta hardened + load-proven (batch 15) — 1000 concurrent users, zero money drift, full automated test suite.**

## Next session — pending fixes
- Frontend/API contract sweep: batch 16 fixed order.serviceType->type + paginated unwrap, but other pages likely share the drift (portal orders/campaigns/reports use `order.items?.[0]?.serviceType` which is optional-chained so degrades to "—" rather than crashing — verify against real `items` shape). Audit every `.list()`/paginated client method for array-vs-{items} mismatch.
- Latent pool-deadlock risk: only 18/66 audit.log calls pass `tx`. Hot money paths fixed; sweep remaining in-transaction audit.log/this.prisma.* calls in colder paths (disputes, refunds, settlements admin actions) before full production load.
- Run servers via `pnpm dev:all` (compose + all apps) for a stable local stack — session-started foreground processes die with the shell.

## Completed (2026-06-11, batch 15 — integration + concurrency + 1000-user load)
- **3 automated test harnesses** (package.json: test:integration / test:concurrency / test:load):
  - `integration-test.ts` — full money loop, 26 assertions incl. money conservation at each step, state-machine integrity, two-step settlement approval, tier-hold enforcement, idempotency replay
  - `concurrency-test.ts` — 7 parallel attacks (double-pay, over-spend, double-release, withdrawal over-draw, idempotency storm, execute race, double mark-paid) + reconciliation referee. 16/16
  - `load-test.ts` — provisions N users via DB (bypasses auth/billing rate limiters legitimately for setup), runs N concurrent order+payment flows. **1000/1000 paid, 0 errors, 151 orders/s, p99 434ms, zero drift**
- **Critical concurrency bug fixed — double-charge**: `billing.reserve`/`payFromReserved` opened their OWN `$transaction` (independent commit), so under parallel submit-payment every request debited the wallet and only the order version-guard deduped → wallet drained N×. Fix: added optional `existingTx` param; submitPayment now claims the order (version-guarded DRAFT→PAID) BEFORE any money moves, and reserve/pay run inside that same tx (atomic rollback for losers)
- **Pool-deadlock bug fixed (throughput killer)**: `createOrder` and `submitPayment` called `this.prisma.*` / `audit.log` (new connection) while holding a `$transaction` connection → pool starvation → 20s timeouts, 35% error rate at 40 concurrent. Fix: use `tx.` for in-transaction reads, pass `tx` to `audit.log`. Throughput went 1.2→151 orders/s
- **PrismaService tuned**: connection_limit=25 + pool_timeout=20 injected into DATABASE_URL if absent; transactionOptions maxWait 10s / timeout 20s
- **Settlement release return fix**: admin-approve returned the pre-release ADMIN_APPROVED snapshot instead of the final RELEASED row
- 115 unit + 26 integration + 16 concurrency all green; 11/11 builds

## Completed (2026-06-11, batch 14 — beta bring-up)
- **DB rebuilt from scratch**: migration chain was unreplayable (db-push drift: missing DisputeStatus enum, dup indexes, missing FK columns) → squashed to single baseline `20260611120000_squashed_baseline` (schema DDL + hand-written CHECK constraints/partial indexes carried forward); old chain archived in `prisma/migrations_archive/`
- **New seed** `scripts/seed.ts` (pnpm seed): 6 users (admin/finance/staff/publisher/client/member), staff bootstrap via DB (no self-promote API — old seed scripts used removed `set-staff` endpoint), roles via admin API, org + member invite, $5000 wallet via dev deposit, 3 publisher websites, 3 categories, 4 approved listings, 3 payout providers. Credentials in script output
- **Bugs found by e2e money loop, all fixed**:
  - `Order_websiteId_required` CHECK too strict (DRAFT couldn't carry websiteId — createOrder always does) → relaxed to non-DRAFT-requires-website
  - `OrderEventType` enum missing `ORDER_SUBMITTED` (code emitted it) → added
  - Wise/Stripe adapters never registered in PayoutProviderService → registered
  - `getActiveProvider` decrypted unconditionally → empty/object config (manual provider) passes through
  - `markWithdrawalPaid` couldn't complete in-flight manual executions (PROCESSING dead-end) → completes manual execution, refuses automated-provider ones (double-pay guard)
  - api-client: settlement approve path wrong, withdrawal verbs POST vs PATCH, publisher-payouts paths/shapes all wrong → fixed + added execute/executions/retry/cancel/reconciliation/decrypt/markPaid/payout-methods
- **Frontend extended**: publisher payout-methods page (add bank/PayPal, masked display, deactivate) + nav; withdrawals page wired to payout methods; admin finance: 4 tabs (settlements/withdrawals/payouts/reconciliation), execute payout, executions drill-down w/ retry/cancel, audited decrypt dialog (reason required)
- **Verified e2e**: deposit $5000 → order $250 → fulfillment state machine → manual-verify → delivery → settlement (customer+admin approve) → $200 publisher withdrawable → withdrawal (NEW-tier hold enforced, then VERIFIED) → manual execute → mark-paid → lifetimePaid $200 → reconciliation 0 drift. Decrypt RBAC: admin w/ grant 200, OPERATIONS 403, audit row written
- All services running: API :4000, website :3000, portal :3001, publisher :3002, admin :3003, worker (payout poll registered)
- 115 API tests pass; all 11 turbo build targets pass

## Completed (2026-06-11, batch 11 — go-live audit fixes)
- Webhook controller now verifies signatures BEFORE queueing, fail-closed: Stripe HMAC (`stripe-signature` t/v1, 300s tolerance, timing-safe) via `STRIPE_PAYOUT_WEBHOOK_SECRET` (falls back to `STRIPE_WEBHOOK_SECRET`); Wise RSA-SHA256 (`x-signature-sha256`) via `WISE_WEBHOOK_PUBLIC_KEY` (PEM). Missing config → 503, bad sig → 401, never enqueued
- Wise adapter: idempotency now via `customerTransactionId` (deterministic UUID from idempotency key) — previous body field `idempotencyKey` was ignored by Wise (duplicate-transfer risk)
- Stripe adapter: idempotency moved to `Idempotency-Key` HTTP header — previous form field was ignored by Stripe
- Both adapters: mock fallbacks (missing API key → fake COMPLETED) now throw in production
- `retryExecution`: checks provider status of prior `providerExecutionId` before re-sending; provider COMPLETED → reconcile local state (audit `PAYOUT_EXECUTION_RECOVERED_COMPLETED`), provider PROCESSING → 409. Closes FAILED-marked-but-actually-paid double-payout window
- Deleted dead processors (`payout-execution/webhook/status.processor.ts`) — unregistered, contained unguarded racy webhook handler
- 105 tests pass (14 new in payout-golive-security.spec)

## Completed (2026-06-11, batch 12 — CTO audit fix)
- `payout-webhooks/:provider` was behind global AuthGuard (no `@Public()`) — providers would 401, payouts stuck PROCESSING forever. Added `@Public()`; signature verification is the route's authentication

## Completed (2026-06-11, batch 13 — scale/operational improvements from CTO audit)
- **Status poller now real**: `packages/shared/src/payout-status.ts` (pure provider status fetchers — return null w/o API key, never assume completion); worker `handleCheckStatus` polls PROCESSING executions and transitions via shared `completeExecution`/`failExecution` helpers (same version-guarded tx as webhook path, audit `PAYOUT_STATUS_POLL_COMPLETED/FAILED`); repeatable BullMQ job registered on worker startup (every 10m, jobId `payout-check-status-poll`, HMAC-signed payload)
- **Reconciliation batched**: all N+1 loops → grouped queries (fixed query count regardless of rows); single execution groupBy answers FAILED-orphan/COMPLETED-orphan/duplicate-COMPLETED checks
- **AuthGuard cached**: 30s per-instance TTL cache (`common/auth-context-cache.ts`, 10K-entry cap) — was 3-5 DB queries/request; session still verified every request; explicit invalidation on context switch, membership invite/remove, role changes. PermissionsGuard (decrypt) deliberately uncached
- 115 tests pass (10 new: cache TTL/eviction/invalidation, provider status mapping/skip semantics)

## Known gaps (accepted for controlled beta, documented)
- Status poller (`payout-check-status`) counts but doesn't transition — stuck PROCESSING relies on webhooks + reconciliation stale alerts + manual retry
- Crash between provider send and DB write: reconciliation flags stale PROCESSING >2h; recovery manual via provider idempotency-key lookup
- No provider-side reconciliation (compare Wise/Stripe transfer list vs PayoutExecution rows) — orphan provider transfers invisible



## Completed (2026-06-11, batch 10 — financial data decryption hardening)
- Repaired interrupted prior session: schema.prisma had duplicate `model PayoutProvider {` (parse error) → fixed, client regenerated, `packages/database` rebuilt
- PermissionsGuard: SUPER_ADMIN no longer bypasses SENSITIVE_PERMISSIONS (`FINANCIAL_DATA_DECRYPT` must be explicitly granted on StaffMembership, any role)
- Decrypt endpoint `POST /admin/payout-methods/:id/decrypt`: permission-gated, reason required (min 10 chars), `PAYOUT_METHOD_DECRYPTED` audit (actor/reason/IP/UA), `Cache-Control: no-store`
- Provider error redaction in PayoutExecutionService: logger + `errorMessage` column + audit metadata + rethrown error all pass through `redactSensitive()`
- Migration `20260611030000_payout_execution_and_decrypt_rbac`: PayoutProvider/PayoutExecution/PayoutBatch tables + enums, PayoutMethod.displayDetails/encryptionKeyVersion/version, StaffMembership.permissions, Withdrawal.payoutBatchId — **NOT YET APPLIED, dev DB was down**
- Fixed refund.service.spec mock (wallet.findUnique) broken by prior session
- 91 tests pass (26 new in payout-decrypt-security.spec: guard matrix, prod key enforcement, rotation, GCM tamper, masking, redaction, audit)

## Apply when DB up
```bash
cd packages/database && npx prisma migrate deploy
```

**Status (prior): Backend hardening complete (batch 9) — backend-first push before frontend work.**

## Completed (2026-06-11, batch 9 — CTO review fixes)
- All launch-blocker fixes from full architecture review: privesc, Decimal money math, one-website-per-order, clawback debt model, forceCancel refund delegation, audit-in-tx, chargeback handler, withdrawal holds + ledger rows, dispute previousStatus, atomic delivery+settlement, pagination, price-drift 409, domain dedupe, PayoutMethod, settlement auto-approve sweep, reconciliation endpoint
- Migrations: `20260611000000_business_logic_hardening`, `20260611010000_sync_enum_drift` (repaired db-push drift — dev DB now zero-drift vs schema)
- 71 unit tests pass (new: refund branches, withdrawal holds/ledger, fee split, domain normalization)

## Next Steps (backend completion, pre-frontend)
1. Double-entry ledger design (escrow/revenue accounts) — reconciliation endpoint is interim guard
2. Real payout rail (Stripe Connect) on top of PayoutMethod
3. WebsiteVerification (DNS TXT) model + endpoints, required before listing approval
4. Order accept/delivery deadlines + timeout sweep (SUBMITTED orders currently wait forever)
5. Integration/concurrency tests against real Postgres (parallel approvals, money-conservation property test)
6. Run GET /admin/reconciliation after any manual data surgery; legacy pre-batch-9 withdrawals show as expected publisher drift (no WITHDRAWAL tx rows)

## Standing risks
See `Work/risks.md` — "Still open" section.
