# Current Focus
**Status: Payout go-live audit fixes complete (batch 11) — webhook signatures, provider idempotency, retry double-pay guard.**

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
