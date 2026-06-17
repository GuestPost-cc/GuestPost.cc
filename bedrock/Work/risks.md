---
note_type: risks
project: guestpost-platform
updated: 2026-06-17
---

# Risks

Updated 2026-06-17 after Phase 7.8 closed 22/31 findings (**11/11 Critical**, 7/14 High, **3/5 Medium** — #25, #26, #27). The auth/queue trust boundary has zero open security findings; remaining work is frontend polish (#28/#29/#30 → Phase 7.9). Original 2026-06-11 architecture review risks reassessed below.

The canonical per-finding tracker is `bedrock/Views/audits/platform-audit-2026-06-15.md` §11 Remediation Log. This file keeps the strategic risk register skimmable.

## Closed in this batch (no longer active)

| Risk (was) | Phase that closed it |
|---|---|
| Privesc via `updateUserRole` publisher path | Phase 6.7 (per-handler `@StaffRoles` + fail-closed guard + admin RBAC matrix) |
| Float money math (`Number(amount) * feeFraction`) | Closed in original Phase 9 (batch 9, 2026-06-11) — Decimal end-to-end + `splitPlatformFee` rounds once and subtracts |
| `submitPayment` silently re-charges drifted listing price without consent | Phase 6.9 (`assertOwnerOrCreator` + price-drift 409) |
| Confirm-delivery → settlement creation non-atomic | Phase 6.9 status-guarded `updateMany` in confirmDelivery |
| Tier withdrawal holds computed but never enforced | Phase 7.2 (`getWithdrawalHoldDays` lifted to shared; settlement review also tier-aware now) |
| Settlement auto-approve sweep runs in every API pod | Phase 7.3 (moved to BullMQ repeatable; cluster-wide jobId dedup) |
| Notification duplicates on every retry | Phase 7.4 (partial unique on `(userId, dedupKey)`; P2002 catch-and-swallow; drift-summary keys for reconciliation) |
| Pre-Phase-6 Settlement / PlatformRevenue rows have NULL snapshot fields forever | Phase 7.5 (one-shot SQL backfill via Order → ListingService + Website JOIN; idempotent) |
| Audit log defaults swallow errors and lose records under load | Phase 6.9 audit-meta uniformity sweep + Phase 7.0 `requestId` propagation (every audit row now correlatable end-to-end) |
| No error boundaries / no Sentry in any of 4 apps | Phase 7.0 (`error.tsx` + `global-error.tsx` per app + `@sentry/nextjs`) |
| Worker has no health endpoint, no metrics, no error reporting | Phase 7.0 (`/health` `/ready` `/metrics/queues` + `failed`-event Sentry hook on all 9 processors) |
| No PlatformRevenue surfacing (no Finance dashboard) | Phase 7.1 (`GET /admin/finance/revenue` with 4 groupings + period comparison + CSV) |
| Settlement review window default drift (7 in one path, 14 in another, neither tier-aware) | Phase 7.2 (single `getSettlementReviewDays(tier, env)` helper; NEW=30 / TRUSTED=14 / VERIFIED=7) |
| Frontend 401 storms (no `onAuthError` redirect handler) | Phase 6.8 (`buildAuthErrorHandler` with idempotency + URL sanitization + same-page debounce) |
| Reporting service channel split uses live `ownershipType` instead of snapshot | Phase 7.1 (#15 bundled — `order.fulfillmentChannel ?? website.ownershipType` snapshot-first) |
| Admin + publisher apps are desktop-only (no mobile sidebar) | Phase 7.6 (ported portal's `translate-x` drawer + backdrop + sticky mobile-only header with hamburger; pathname auto-close; `type="button"` defense; ARIA labels) |
| `requestId` lived only in `AuditLog.metadata` JSON (unqueryable, unindexed, no admin UI access) | Phase 7.7 A1 + A2 (indexed `VARCHAR(128)` column + partial btree + backfill + admin filter + Copy button) |
| API + worker logs were unstructured `console.*` calls — log aggregators couldn't parse, requestId not embedded in log lines | Phase 7.7 B + 7.7.x (structured-logger module: JSON + pretty modes, auto-injects requestId from ALS, includes `environment` + `release` tags. **All 8 worker files swept** in 7.7.x — `apps/worker/src` now has zero production `console.*` calls; allowlist contains only forever-allowed entries) |
| CI workflows (`ci.yml`, `pr.yml`) were broken in 5 latent ways masked behind earlier pnpm-action failure | Phase 7.7.x batch 2 (PR #3): turbo env passthrough + pnpm version conflict + missing root typecheck script + missing ui/api-client build dep + Sentry source-map network hang. All five fixed in one PR; CI green end-to-end on main. |
| 3 pre-existing failing test specs skipped via `testPathIgnorePatterns` to unblock PR #3 merge | Phase 7.7.y (PR #4): all 3 specs' mocks updated to match Phase 6.x production behavior; allowlist back at jest default. apps/api jest 33 suites / 478 tests, no skips. |
| Per-IP-only auth rate limits enable credential stuffing across an IP pool (#26) | Phase 7.8: Better Auth plugin layers per-`SHA-256(email)` Redis-backed counter on top of the per-IP limit. Generic 429 response is byte-identical between layers (no enumeration oracle). |
| `hasAuthCredentials()` cookie sniff trivially bypassable (audit §5.8 sub-finding) | Phase 7.8: regex written against captured Better Auth signed-cookie shape; 14-case unit test including regression for the pre-fix bypass string. |
| HMAC-signed queue payloads have no `iat` — captured signatures replayable indefinitely (#27) | Phase 7.8 **Deploy A**: `signJobPayload` injects `iat`+`v: 1` (tamper-proof — part of canonical digest); `verifyJobPayload` enforces freshness (24h default, per-queue overrides). Centralized repeatable-job registry with drift guard handles cron-payload reuse. **Deploy B** (≥48h after merge): flip `allowMissingIat` default to false. |
| `User.emailVerified` schema field never consulted (#25) — newly-registered customers could submit money-path orders without verification | Phase 7.8: AuthGuard rejects state-changing methods on non-exempt customer routes when `emailVerified=false`. Check applies at both cache-miss + cache-hit paths. Mandatory pre-merge GET-mutation audit confirmed zero state-changing GETs. CUSTOMER only (PUBLISHER + STAFF have separate verification tracks). |
| Sentry production stack traces showed minified bundle offsets (no source-map upload) | Phase 7.7 C (`@sentry/cli: true` + `widenClientFileUpload` + `sourcemaps.deleteSourcemapsAfterUpload` on all 4 Next.js apps + `SENTRY_AUTH_TOKEN` threaded in CI) |
| Worker `/metrics/queues` had no service identity + missing the Phase 7.4 `dedupHitsTotal` counter | Phase 7.7 D (extended payload with `service: { name, version, pid, started_at, uptime_s }` + `dedupHitsTotal` + new `stalledHitsTotal`) |

## Still open (residual + new)

### Critical / High that survived this batch

- **No open Criticals remain.** Phase 7.6 closed #9 (mobile UX), the last one. The 2026-06-15 platform audit has zero open production-blocker findings.
- **2 Medium findings** still open (both frontend, queued for Phase 7.9): #28 (status-color drift across pages), #29 (shared Phase A components shipped but zero imports across apps). Plus #30 (hooks-rule violation in publisher listings page) — also Phase 7.9. Phase 7.8 closed #25 + #26 + #27.
- **Drawer a11y polish gap (introduced by Phase 7.6, captured as Phase 7.6.1)**: matches portal's reference exactly, which means no escape-to-close, focus trap, or body-scroll-lock on any of the three drawers. Functional and visually correct, but keyboard-only users + screen-reader users have a degraded experience. Polish-tier risk; deferred to Phase 7.9 per 2026-06-16 roadmap.
- ~~Partial structured-logger sweep (Phase 7.7 B)~~ — **CLOSED** by Phase 7.7.x (PR #3, commit `5af902c`). All 8 worker files swept; allowlist at its forever-allowed steady state.
- ~~3 pre-existing failing test specs skipped in CI~~ — **CLOSED** by Phase 7.7.y (PR #4, commits `aa8cd55`+`74c8d51`+`b670493`). All 3 specs run again; `testPathIgnorePatterns` back at jest default.
- **Phase 7.7 A1 dev DB drift (operator action required)**: pre-existing dev DB has 5 missing migration files from 2026-06-13; Phase 7.7 A1 migration was NOT applied to dev (operator opted to skip). Must apply on staging/prod via `prisma migrate deploy` (clean history) + record EXPLAIN ANALYZE planner-uses-index proof + before/after counts in the audit §11 Phase 7.7 entry. Until prod cutover, requestId column queries seq-scan (or return empty for pre-7.7 rows).

### Pre-existing risks unchanged by this batch (still on the radar)

- **No double-entry ledger.** Reconciliation core (`packages/shared/src/reconciliation-core.ts`) is the interim drift detector; single-entry bookkeeping remains. Money conservation is provable via reconciliation; accounting audit will eventually require dual-entry escrow / revenue accounts. Medium-term re-architecture.
- **Item-level settlements not implemented.** Settlement is computed at the order level. Multi-website orders are blocked at order creation (one-website-per-order invariant), so the risk is currently mitigated, but a future "shopping cart" UX would need item-level work.
- **Crash between provider send and DB write** (Wise / Stripe Connect). Reconciliation flags stale `PROCESSING` >2h; manual recovery via provider-side idempotency-key lookup. No automated provider-side reconciliation (compare provider's transfer list vs `PayoutExecution` rows).
- **Latent pool-deadlock in colder audit-write paths.** 18/66 audit.log calls pass `tx`; hot money paths fixed in batch 15. Phase 6.9's sweep got 20+ more; remaining cold paths (some admin actions, support fan-out edge cases) still write outside the tx via `this.prisma.auditLog.create` and swallow errors. Acceptable for current scale; revisit if cold-path drift surfaces.
- **Dispute resolution non-idempotent.** RESTORE/REJECT restore hardcoded PUBLISHED regardless of pre-dispute status. REFUND resolution: refund commits, dispute update fails → unresolvable. Lower-priority cleanup.
- **Listing reviews default APPROVED without purchase verification.** Low-volume today; opens fake-review attack vector at scale.
- **Single-currency only.** `currency` is free-text USD default; non-USD orders today would settle as USD-as-its-own-currency. Phase 7.1 surfaces a warning (`meta.currencyMismatch`) when any non-USD Order exists in the revenue dashboard range. Multi-currency Phase 7.1.x is a follow-up if the platform expands beyond USD.

### Risks introduced by this batch (new)

- **`unhandledRejection` exit-after-flush in worker** — intentional architectural choice (safer than continuing with corrupt state). Override available via `UNHANDLED_REJECTION_EXIT=false`. Could cause unexpected restart loops if a transient error bubbles up unhandled at boot. Mitigation: documented loudly in worker `index.ts` header; Sentry captures every exit reason.
- **Phase 6 snapshot inline-typed `PublisherTier`.** Tier policy module defines union `"NEW" | "TRUSTED" | "VERIFIED"` separately from Prisma's generated enum. If Prisma adds a tier (PROVISIONAL etc.) without the union being updated, the exhaustive-coverage compile-time test catches it — but only if someone runs the build. Mitigation: CI runs the test suite.
- **Notification dedup `runtime + DB` belt-and-suspenders** doubles the "did the dedup fire" surface area. Could mask a real bug where one layer drops a notification that the other was supposed to catch. Mitigation: `dedup_hits_total` log counter + Sentry events on failed unique violations make the dedup rate observable.

## Decisions framework

When in doubt: closures land via a phase entry in the audit's §11 Remediation Log. This file should stay small — strategic risks only. If a risk decomposes into multiple findings, name them and link to the audit.
