# Current Focus

**Status (2026-06-29): Phase 1 monetary safety + Phase 2 beta blockers + Phase 3 Operational Safety (items 1,3,4) complete.**

Pre-beta audit closed 10 dimensions. Phase 1 fixed the settlement TOCTOU gap and added the status predicate guard on `releaseFundsInternal`. Phase 2 added CSRF middleware (Bearer-presence check) and a 500-row cap on the support ticket query. Phase 3 added composite DB indexes, removed orphaned `next` from root `package.json`, and marked required env vars.

## Completed this session (2026-06-28/29)

| Area | Changes |
|---|---|
| **Monetary Safety (Phase 1)** | Two critical fixes in `settlements.service.ts`: (1) `evaluateSettlementEligibility` re-check inside the `$transaction` using `tx` client — closes the TOCTOU window where a concurrent dispute could bypass the gate. (2) `status: { notIn: ["CANCELLED", "REFUNDED", "DISPUTED"] }` predicate on `releaseFundsInternal` order `updateMany` — defense-in-depth against overwriting terminal states. New Phase 8.10 regression spec (happy path + TOCTOU race). |
| **CSRF Protection (Phase 2 Item 3)** | New `CsrfMiddleware` validates state-changing requests carry a `Bearer` token when a session cookie is present. The API client always sends both channels — a CSRF attack would carry only the cookie without the JS-inaccessible Bearer token. Safe methods and Bearer-present requests bypass. |
| **Support Ticket Cap (Phase 2 Item 5)** | Added `take: 500` to `listTickets()` — prevents unbounded queries for actors with many tickets. Admin variant already paginated. Portal consumer unaffected at beta scale. |
| **Pre-Beta Deep Audit** | Full 10-dimension audit: architecture, security, code quality, frontend, monetary safety, performance, DevOps, dependencies, business logic edge cases, compliance. Identified 2 critical fixes (Phase 1) + 3 beta blockers (Phase 2 items 3-5). |

## What's next

**No operator action items from this session** — all changes are application-layer or env-doc-only.

**Named follow-up backlog items** (next session work):

- **Phase 3 — Operational Safety (remaining)** — Worker process isolation (deferred to post-beta). `AuditLog(organizationId)` and `Notification(organizationId)` indexes confirmed already present in schema — no action needed.
- **Phase 7.10.2.1** — CI integration test template-DB step. Closes 2026-06-22 audit Critical #6.
- **Phase 7.10.2.x** — Convert Phase 7.12 favorites manual-smoke race to integration spec.
- **Payout-flow hardening** — Stripe reversal Idempotency-Key (Phase 8.x), cancelExecution two-phase commit, auto-approve catch Sentry injection. 3 remaining High findings from the 2026-06-22 audit.
