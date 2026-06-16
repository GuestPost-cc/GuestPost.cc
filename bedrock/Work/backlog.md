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
- [ ] **Phase 7.7.y — fix 3 pre-existing failing test specs** (Phase 6.x fixture drift, currently skipped via `testPathIgnorePatterns` in `apps/api/jest.config.js`). Each spec covers a real money-path / RBAC invariant; deleting them is not the answer. ~1–3h total:
  - `modules/billing/__tests__/prebeta-audit-regression.spec.ts` — F-3 "tenant-scoped order idempotency" fixture predates Phase 6's `Order.listingServiceId` invariant. **Fix**: add `listingServiceId` to the per-tenant order fixtures.
  - `modules/orders/services/__tests__/order-payment.service.spec.ts` (6 cases) — mock context sets `actorId !== creatorId` so Phase 6.9's `assertOwnerOrCreator` fires first and masks the actual `BadRequest`/`ConflictException` paths the tests want to exercise. **Fix**: set `actorId = creatorId` (or `actorRole = "OWNER"`) in `beforeEach`.
  - `common/guards/__tests__/staff-roles.guard.spec.ts` — "allows access when no roles are required" expects pre-Phase-6.7 permissive behavior; Phase 6.7 hardened to fail-closed. **Fix**: either delete the test (new behavior is intentional + covered by `admin-rbac-coverage.spec.ts`) or update the mock route to include `@StaffRoles` metadata.
  Each fix removes the matching entry from `testPathIgnorePatterns` in `apps/api/jest.config.js` so the spec runs again. Mechanical; can ship file-by-file as small PRs.
- [ ] **Phase 7.3.1 — `(status, reviewEndsAt)` index on Settlement.** Tiny migration. The Phase 7.3 auto-approve worker sweep hits this access pattern every 15m. **Blocked on Prisma 6.19.3 → 7.4+ upgrade** (Prisma 6 wraps migrations in a transaction; `CREATE INDEX CONCURRENTLY` rejects with `cannot run inside a transaction block` per prisma#14456, fixed in 7.4). Out of scope until Prisma is upgraded.

## Phase 7.8 — Security Hardening Batch (per 2026-06-16 roadmap)

Bundle these together as one cohesive phase:

- [ ] **#26 — Email-keyed rate limiter** on auth endpoints. Per-IP-only limits today don't stop credential stuffing across an IP pool.
- [ ] **#27 — Job-signing `iat` validation / replay protection.** Add issued-at timestamp to signed queue payloads + freshness window.
- [ ] **Related auth/session follow-ups** discovered during implementation.

Mission: Authentication / Authorization / Replay protection / Anti-abuse in one cohesive phase.

## Phase 7.9 — Frontend Quality & Accessibility (per 2026-06-16 roadmap)

Bundle these together as one cohesive phase:

- [ ] **#28 — Status-color centralization** in `@guestpost/ui` (`STATUS_PRESENTATION`). `PUBLISHED` currently renders as 3 different greens across pages.
- [ ] **#29 — Unused shared component adoption.** Phase A components (`<BriefRenderer>`, `<FulfillmentChannelBadge>`, `<SupportPanel>`) shipped in batch 22 with zero imports today.
- [ ] **#30 — Hooks-rule violation in publisher listings page** (`apps/publisher/src/app/dashboard/listings/page.tsx:182-195`). Inline the 4 `useMutation` calls; works today but is a time-bomb.
- [ ] **Phase 7.6.1 — Drawer a11y polish** (status: Approved, Deferred — full plan preserved in `~/.claude/plans/read-the-bedrock-views-audits-platform-a-typed-spark.md` appendix). Escape-to-close + focus trap + body-scroll-lock + ARIA dialog semantics applied uniformly across portal + admin + publisher via a shared `useDrawerA11y` hook.

Mission: Frontend consistency / Accessibility / Maintainability / Shared patterns.
- [ ] **Phase 7.0.1 observability follow-ups.** Three small items, can batch into one migration / one PR:
  - Promote `requestId` from `AuditLog.metadata` JSON to a dedicated indexed column + backfill
  - Structured logger to replace `console.log` across api+worker (then `requestId` is grep-able in plain logs, not just Sentry context + audit DB)
  - Source-map upload via `SENTRY_AUTH_TOKEN` in CI (one-line `withSentryConfig` flip + `@sentry/cli` `pnpm-workspace.yaml` true-flip)
- [ ] **#26** Add email-keyed rate limiter on auth endpoints (per-IP-only today; credential stuffing across an IP pool bypasses).
- [ ] **#27** Add `iat` (issued-at) timestamp to signed queue payloads + freshness window. Captured signed payloads otherwise stay replayable indefinitely.
- [ ] **#28** Centralize status-color table in `@guestpost/ui` (`STATUS_PRESENTATION`). `PUBLISHED` currently renders as 3 different greens across pages.
- [ ] **#29** Adopt the shared Phase A components (`<BriefRenderer>`, `<FulfillmentChannelBadge>`, `<SupportPanel>`) in portal / publisher / admin order detail pages. Shipped in batch 22, exported from `@guestpost/ui`, zero imports today.
- [ ] **#30** Inline the 4 `useMutation` calls in publisher listings page (`apps/publisher/src/app/dashboard/listings/page.tsx:182-195`). Hooks-rule violation works today but is a time-bomb.

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
