---
note_type: backlog
project: guestpost-platform
updated: 2026-06-16
---

# Backlog

Forward roadmap after the Phases 6.6 → 7.6 audit batch. Canonical source for per-finding status is `bedrock/Views/audits/platform-audit-2026-06-15.md` §11.

**Critical-finding status: 11/11 closed** (Phase 7.6 closed the last one, #9 Mobile UX). All remaining items are High / Medium / strategic.

## Next (named follow-ups from the batch)

- [ ] **Phase 7.3.1 — `(status, reviewEndsAt)` index on Settlement.** Tiny migration. The Phase 7.3 auto-approve worker sweep hits this access pattern every 15m. Must use `CREATE INDEX CONCURRENTLY` (Prisma migration needs `-- prisma+postgresql migrate.transaction = false` directive at the top of the SQL) to avoid table-write lockout on prod-sized tables.
- [ ] **Phase 7.6.1 — Drawer a11y polish.** Apply uniformly across portal + admin + publisher: escape-to-close (`useEffect` keydown listener), focus trap (move focus into drawer on open + restore on close), body-scroll-lock (toggle `overflow:hidden` on `<html>` while open), and consider `role="dialog"` + `aria-modal="true"` + `aria-expanded` on the hamburger. None of the three apps have these today; uniform polish pass is right scope.
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
