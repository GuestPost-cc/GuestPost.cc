# Current Focus

**Status (2026-06-28): Marketplace publisher & admin flow redesign COMPLETED.** All typecheck/lint/build pass.

## Completed this session (2026-06-28)

| Area | Changes |
|---|---|
| **Publisher Portal** | Create dialog: removed legacy type/price, added inline first-service creation. Edit listing modal (title/description). Services dialog: inline edit for price/TAT/revisions/warrantyDays/currency, removed duplicate Pause button, added warrantyDays+currency fields. REJECTED→resubmit flow (backend + frontend). |
| **Admin Portal** | Force-approve gate fixed: `user.staffRole` vs deprecated `user.role`. Admin listings return ALL services (not just AVAILABLE). Display fields computed from AVAILABLE subset. Added missing AdminService client methods. Manage Services dialog reads fresh listing data. Removed invalid PUBLISHER_WEBSITE type filter. Field name fix: `revisionRounds`. |
| **Admin Preview** | Domain verification badge. Force-approve for SUPER_ADMIN. Updated status mutation signature. |
| **Backend** | `getPublisherListings`: added publisher+website Prisma includes for correct `computeListingPhase`. `submitListingForReview`: accepts REJECTED → PENDING_REVIEW. Admin listings: removed AVAILABLE-only filter, compute display from AVAILABLE subset. |
| **Portal** | Marketplace order page at `/dashboard/marketplace/[slug]/order` (single-page, bypasses 5-step wizard). |

## What's next

**Operator action items** (need user/operator, not me) before this hits prod:

1. **PR #15 / Phase 7.14** — run Gate 0 dupe sweep on staging + prod:
   ```sql
   SELECT "orderId", COUNT(*) FROM "FulfillmentAssignment"
   WHERE status IN ('ASSIGNED','IN_PROGRESS')
   GROUP BY "orderId" HAVING COUNT(*) > 1;
   ```
   If non-zero on any env, manually collapse dupes (cancel-all-but-newest per orderId) before applying the migration.

2. **PR #16 / Phase 7.13.x** — run cross-env `Escrow` presence/rowcount check on staging + prod:
   ```sql
   SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Escrow' AND relkind = 'r') AS escrow_table_exists,
          EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EscrowStatus' AND typtype = 'e') AS enum_exists;
   ```
   If table present, confirm `SELECT COUNT(*) FROM "Escrow"` is 0 (STOP if >0; investigate FK to Order). If enum present, confirm only `Escrow.status` references it.

3. **PR #17 / Phase 7.13.1.1** — run prod-scale EXPLAIN ANALYZE before applying:
   ```sql
   EXPLAIN (ANALYZE, BUFFERS) SELECT id, status FROM "Settlement" WHERE status = 'PENDING';
   ```
   Confirm the planner picks `Settlement_status_reviewEndsAt_idx` (composite leading column), NOT the soon-dropped single-column.

4. **PR #18 / Phase 7.10.2** — one-time `guestpost_test_template` setup on CI runner. Add to `.github/workflows/ci.yml` before `pnpm test:integration` (deferred to Phase 7.10.2.1 fast-follow PR).

5. **Phase 7.7 A1 dev DB drift** — pre-existing operator action from Phase 7.7 still owed. Apply migration on staging/prod + record EXPLAIN ANALYZE planner-uses-index proof + before/after counts in audit §11 Phase 7.7 entry. Until prod cutover, requestId column queries seq-scan.

**Named follow-up backlog items** (next session work):

- **Phase 8.X bundle** — close 2026-06-22 audit findings one phase per finding (same pattern as Phase 6.6 → 7.14 closed the prior batch). Remaining Criticals: settlement race windows #1+#2, payout webhook dedup #3, settlement-auto-approve audit log #4, lazy-queueServiceRef race #5, CI template-DB step #6 = Phase 7.10.2.1 already named, adapter-pg pool sizing #7. **#38 closed via Phase 8.7** (PR pending). High items cluster naturally into batches by domain: payout-flow hardening bundle (#39 Stripe reversal Idempotency-Key + #40 cancelExecution two-phase + #41 auto-approve catch fix), database hardening (#11+#12+#13), infra/CI cleanup (#15+#16+#17+#19), delta-edge guards (#8+#9+#10), worker observability (#14+#18).
- **Phase 7.10.2.1** — Spec 2 (queue GET happy-path) + TestAuthGuard (X-Test-User-Id header) + supertest api-client. HTTP-layer integration capability deferred from PR #18 for shipping velocity. ALSO ships the CI integration step (`prisma migrate deploy` to template DB before `pnpm test:integration`). **This phase closes 2026-06-22 audit Critical #6.**
- **Phase 7.10.2.x** — Convert Phase 7.12 favorites manual-smoke race to integration spec. Fast-follow now that the harness exists; same 5-caller shape as PR #18's Spec 1.
- **Phase 7.10.2.2.2** — Split AppModule into per-feature TestModules once integration suite hits 20+ specs. Deferred until the suite actually justifies the rework (currently 1 spec; ~2s/spec boot cost is fine at small scale).
- **Phase 7.10.1** — Admin "manually mark customer verified" action. Speculative; defer until real support burden surfaces.

**Strategic items still on risks.md** (long-horizon, not actively planned): no double-entry ledger, item-level settlements (mitigated by one-website-per-order invariant), reconciliation crash recovery (manual via provider idempotency), latent pool-deadlock in cold audit paths (acceptable at current scale), dispute non-idempotency, listing reviews no purchase verification, single-currency only.
