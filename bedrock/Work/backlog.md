---
note_type: backlog
project: guestpost-platform
updated: 2026-06-16
---

# Backlog

Forward roadmap after the Phases 6.6 → 7.7 audit batch. Canonical source for per-finding status is `bedrock/Views/audits/platform-audit-2026-06-15.md` §11.

**Critical-finding status: 11/11 closed** (Phase 7.6 closed the last one, #9 Mobile UX). All remaining items are High / Medium / strategic.

**2026-06-16 roadmap pivot** (post-Phase-7.7): future work is bundled into Phase 7.8 (Security Hardening) and Phase 7.9 (Frontend Quality & Accessibility) per the project-direction prompt. Phase 7.6.1 is approved but deferred into 7.9.

## Next (named follow-ups from the batch)

- [x] **Phase 7.7.x — complete structured-logger sweep.** ✅ DONE 2026-06-16 (commit `5af902c` on PR #1). All 8 worker files swept (85 callsites → logger.*); 4 stale `.js`/`.map` build artifacts removed; allowlist trimmed to forever-allowed entries only (`apps/api/src/main.ts` boot fallback + 3 browser `auth.tsx`).
- [x] **Phase 7.7.y — fix 3 pre-existing failing test specs** ✅ DONE 2026-06-16 (PR #4 merged, 3 commits `aa8cd55` + `74c8d51` + `b670493`). All 3 specs' mocks updated to match Phase 6.x production behavior; `testPathIgnorePatterns` back at jest default; apps/api jest now 33 suites / 478 tests with zero skips. No production code changed.
- [ ] **Phase 7.3.1 — `(status, reviewEndsAt)` index on Settlement.** Tiny migration. The Phase 7.3 auto-approve worker sweep hits this access pattern every 15m. **Blocked on Prisma 6.19.3 → 7.4+ upgrade** (Prisma 6 wraps migrations in a transaction; `CREATE INDEX CONCURRENTLY` rejects with `cannot run inside a transaction block` per prisma#14456, fixed in 7.4). Out of scope until Prisma is upgraded.

## Phase 7.8 — Security Hardening Batch (per 2026-06-16 roadmap) ✅ DONE

- [x] **#26 — Email-keyed rate limiter** on auth endpoints. ✅ DONE 2026-06-17 (PR pending; commits `7a12a1e` + `f3fe975`). Better Auth plugin layers per-`SHA-256(email)` Redis counter on 4 verified endpoints (`/sign-in/email`, `/sign-up/email`, `/sign-in/magic-link`, `/request-password-reset`) on top of the existing per-IP Express limiter. Generic 429 byte-identical between layers (no enumeration oracle).
- [x] **#27 — Job-signing `iat` validation / replay protection** ✅ DONE 2026-06-17 (**Deploy A**; commits `058fa7e` + `f489e2e`). `signJobPayload` injects `iat`+`v: 1`; `verifyJobPayload` enforces 24h default freshness (per-queue overrides: delivery-verification 96h, payout 72h). Centralized `apps/worker/src/repeatable-job-registry.ts` with drift guard handles cron-payload reuse via `maxAgeMs: 0` bypass.
- [x] **§5.8 sub-finding — `hasAuthCredentials()` cookie sniff** ✅ DONE 2026-06-17 (commit `81174ee`). Regex written against captured Better Auth signed-cookie shape; 14-case unit test.
- [x] **#25 — Email-verification gate** ✅ DONE 2026-06-17 (commit `4dbfd67`). AuthGuard rejects state-changing methods on non-exempt customer routes when `emailVerified=false`. Bundled into Phase 7.8 per "related auth/session follow-ups".
- [x] **Deploy B — flip `allowMissingIat` default to `false`** ✅ DONE 2026-06-18 (commit `0e9eca1`). One-line flip in `ROLLOUT_DEFAULTS` plus docblock + 2 spec assertions rebadged. Pre-flight greps confirmed (a) no production callsite passes `allowMissingIat` explicitly and (b) all 10 worker processors emit the standard `"job signature invalid — rejecting"` log on a verify-failure (set-equality with `verifyJobPayload` callsites). The opt-in survives as an explicit emergency-rollback arg on `verifyJobPayload`. PR scheduled to merge ≥48h after Phase 7.8 (i.e. ≥ 2026-06-19 17:38 UTC).

Mission: Authentication / Authorization / Replay protection / Anti-abuse in one cohesive phase. **Status: complete (Deploy A + Deploy B both shipped).**

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

## Acceptance / ops gaps (carried from prior batches, still open)

- [ ] **VPS-or-cloud shared-dev hosting decision.** Batch 24 confirmed dev stack is too heavy for 2GB RAM. Options: bigger VPS (4GB+), cloud sandbox (Railway / Fly / Render), or production-build-only deployment (`next start` not `next dev`). Today: laptop-only.
- [ ] **Docker image build OOM on 8GB local Docker VM.** Container builds validated through install but final `nest build` OOMs. Open: build on ≥4GB CI runner, then push GHCR.
