# Current Focus

**Status (2026-06-29): Phase 1 monetary safety + Phase 2 beta blockers + Phase 3 Operational Safety (items 1,3,4) complete.**

Pre-beta audit closed 10 dimensions. Phase 1 fixed the settlement TOCTOU gap and added the status predicate guard on `releaseFundsInternal`. Phase 2 added CSRF middleware (Bearer-presence check) and a 500-row cap on the support ticket query. Phase 3 added composite DB indexes, removed orphaned `next` from root `package.json`, and marked required env vars.

## Completed this session (2026-06-29)

| Area | Changes |
|---|---|
| **Phase 3 Operational Safety (1,3,4)** | Added `@@index([userType, banned])` and `@@index([walletId, type])` composite indexes. Removed orphaned `next: ^16.2.7` from root package.json. Marked `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` with `# REQUIRED` in `.env.example`. |
| **Fix: root next removal** | Added `next: ^15.0.0` to `packages/ui` (imported `next/navigation` implicitly via hoisting). Regenerated `pnpm-lock.yaml`. Amended commit to fix CI. |
| **Phase 7.10.2.1 — CI integration tests** | `test-db.ts`: capability-based Docker detection (no `docker exec` in CI). `ci.yml` + `pr.yml`: idempotent template-DB creation + migrate + verify + `test:integration` step. Closes audit Critical #6. |

## What's next

**No operator action items from this session** — all changes are application-layer or env-doc-only.

**Named follow-up backlog items** (next session work):

- **Phase 7.10.2.x** — Convert Phase 7.12 favorites manual-smoke race to integration spec.
- **Payout-flow hardening** — Stripe reversal Idempotency-Key (Phase 8.x), cancelExecution two-phase commit, auto-approve catch Sentry injection. 3 remaining High findings from the 2026-06-22 audit.
