# Current Focus
**Status: Backend hardening complete (batch 9) — backend-first push before frontend work.**

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
