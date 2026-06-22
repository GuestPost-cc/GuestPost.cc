# Current Focus

**Status (2026-06-22): 2026-06-15 audit batch CLOSED at 31/31 (100%); 2026-06-22 audit IN PROGRESS at 6/41 closed.** All prior-audit findings closed via Phases 7.13 → 7.14. The new 2026-06-22 audit (`bedrock/Views/audits/platform-audit-2026-06-22.md`) surfaced 8 Critical + 15 High + 18 Medium findings. **Closed**: #38 via Phase 8.7 (PR #19 merged); #4 via Phase 8.4 (invalid finding; PR #20 merged); #41 via Phase 8.9 (PR #20 merged); #1 via Phase 8.1 (PR #21 merged); #2 via Phase 8.2 (PR #21 merged); **#3 via Phase 8.3** (payout webhook BullMQ jobId for replay dedup — reused `normalizeProviderWebhook` for payload extraction; PR pending). Closure flow mirrors the 6.6→7.14 pattern: each finding becomes its own Phase 8.X planning + execution cycle. Per-phase details live in `bedrock/Views/audits/platform-audit-2026-06-22.md` §12 Remediation Log.

**Audit scorecard movement (2026-06-15 → 2026-06-22)**: 11 dimensions improved (5 up by ≥ 2 grades — biggest lifts: RBAC granularity C→A, Worker observability D→A−, Reporting D→A−, Frontend mobile D→A−, Frontend reliability C+→A−); 2 unchanged; 2 slipped (State machine integrity A→A− on 2 newly-surfaced settlement race windows; Worker idempotency B→B− after the payout-flow follow-up probe surfaced 5 findings — handleExecute no-op, webhook dedupKey gap, Stripe reversal Idempotency-Key gap, cancelExecution provider-before-DB-commit, auto-approve catch swallow).

## Completed since last NOW update (2026-06-16 → 2026-06-22)

Phases 7.8 → 7.10.2 shipped across multiple sessions. Major batch on 2026-06-21 landed 8 PRs in a single day:

| PR | Phase | Audit # | One-liner |
|---|---|---|---|
| #11 | **7.13** | — | Prisma 6.19.3 → 7.8.0 + `@prisma/adapter-pg` migration. PrismaClient sites adopt the new adapter; classic Rust engine removed; `CREATE INDEX CONCURRENTLY` unlocked. |
| #12 | **7.13.1** | — | `Settlement_status_reviewEndsAt_idx` composite via `CREATE INDEX CONCURRENTLY` — first production exercise of Prisma 7's non-transactional migration model. |
| #13 | **7.13.2A** | (race-fix) | `MarketplaceFavorite` NULLS NOT DISTINCT companion unique. Plan B in `marketplace.service.ts:1066-1080` (try/create/catch-P2002/findFirst). |
| #14 | **7.13.2B** | (race-fix) | DROP original + RENAME new to canonical. **Plan deviation per Gate 0.5B**: split into TWO single-statement migrations because prisma@7.8.0 wraps multi-statement files in implicit tx → breaks DROP INDEX CONCURRENTLY. Pattern-broadening finding documented. |
| #15 | **7.14** | **#23** | Partial unique on `FulfillmentAssignment(orderId) WHERE status IN ('ASSIGNED','IN_PROGRESS')`. Per-caller P2002 catch on all 3 `upsertAssignment` callers. **Audit 30/31 → 31/31.** |
| #16 | **7.13.x** | — | `createPrismaClient()` + `createPrismaAdapter()` dual-helper. `DROP TABLE "Escrow" + DROP TYPE "EscrowStatus"` orphan cleanup (recon expanded scope: enum had a live column dependent + table itself was orphan; 0 rows on dev). |
| #17 | **7.13.1.1** | — | Drop redundant `Settlement_status_idx` (sibling cleanup; composite leading column covers status-only queries). |
| #18 | **7.10.2** | — | **Greenfield Nest+supertest integration harness.** Jest projects (unit/integration); TEMPLATE-clone DB isolation; Spec 1 closes the Phase 7.14 manual-smoke 5-caller race as a real automated test. 48 suites / 653 tests. |

**Cumulative test growth this batch:** apps/api jest 33 → 48 suites; 478 → 653 tests. Audit dashboard 30/31 → 31/31 (100%).

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
- **Phase 7.10.2.2** — Split AppModule into per-feature TestModules once integration suite hits 20+ specs. Deferred until the suite actually justifies the rework (currently 1 spec; ~2s/spec boot cost is fine at small scale).
- **Phase 7.10.1** — Admin "manually mark customer verified" action. Speculative; defer until real support burden surfaces.

**Strategic items still on risks.md** (long-horizon, not actively planned): no double-entry ledger, item-level settlements (mitigated by one-website-per-order invariant), reconciliation crash recovery (manual via provider idempotency), latent pool-deadlock in cold audit paths (acceptable at current scale), dispute non-idempotency, listing reviews no purchase verification, single-currency only.
