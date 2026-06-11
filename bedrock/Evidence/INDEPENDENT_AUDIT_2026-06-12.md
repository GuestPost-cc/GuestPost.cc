# GuestPost.cc Independent Platform Audit #2 (post-fix verification)

Date: 2026-06-12 · Commit: 54e48d3 · Method: live test execution + line-level source verification. Predecessor: `PRE_BETA_AUDIT_2026-06-11.md` (all F-1..F-9 findings independently re-verified as fixed in code this pass).

## Part results

| # | Part | Verdict | Key evidence |
|---|------|---------|--------------|
| 1 | Business model | **PASS w/ caveats** | All money workflows close (deposit→order→settlement→withdrawal→payout, refund w/ clawback+debt, chargeback hold/release/debit, FAILED-withdrawal reversal). Caveats: SUBMITTED orders wait forever (no accept deadline); platform vs publisher websites separated by `ownershipType` + `PlatformRevenue` vs `Settlement` paths — coexistence safe (refund branches on ownership, refund.service.ts:61) |
| 2 | User journeys | **FAIL (onboarding + 2 UI gaps)** | See A-1, A-2, A-3. Everything past provisioning works end-to-end (proven by integration suite + live e2e batch 14) |
| 3 | Frontend | **~85%** | Zero mock data/placeholders (verified by sweep). Route+role guards present (admin staff-gate auth.tsx:80, useRequireRole, portal/publisher userType gates both restore+signin). Missing: dispute UI, publisher listing UI, campaign edit |
| 4 | API contracts | **PASS** | Orders + publisher-payouts + marketplace normalized at api-client boundary (Decimal strings → numbers, single mapping). All fabricated client methods/fields removed this session; every remaining client path verified against a real controller route |
| 5 | Authentication | **PASS w/ 1 config finding** | better-auth: session verified per request (auth.guard.ts:24), bearer + SameSite-Lax cookies (CSRF-safe for XHR), logout revokes server-side + clears token, wrong-audience tokens rejected AND cleared on restore. Finding A-4: trustedOrigins prod fallback includes localhost |
| 6 | RBAC | **PASS** | Staff routes class-guarded; decrypt double-gated (explicit grant, SUPER_ADMIN cannot bypass — permissions.guard SENSITIVE_PERMISSIONS); tier change FINANCE-only; live negative tests: OPERATIONS→audit-logs 403 |
| 7 | Multi-tenancy | **PASS** | Org/publisher scoping server-side everywhere; order idempotency composite-unique per org; notifications self-scoped (live cross-user 404); OrderOwnershipGuard covers customer + publisher on order detail/events |
| 8 | Financial integrity | **PASS (executed)** | 143 unit + 26 integration + 16 concurrency green this pass; reconciliation zero drift after attack suite; DB CHECK constraints enforce non-negative invariants; all dup-money vectors (payment/settlement/withdrawal/payout/refund/chargeback-replay) covered by unique references + version guards + tests |
| 9 | Payout system | **PASS w/ known gaps** | Idempotency keys deterministic (`payout-{id}-v{version}` → Wise customerTransactionId / Stripe Idempotency-Key header); webhooks signature-verified fail-closed; real payload shapes normalized via shared status maps; retry checks provider truth first; FAILED reversal blocked while COMPLETED/PROCESSING. Known accepted: crash window between provider send and DB write (stale-PROCESSING flag + manual recovery), no provider-side transfer reconciliation |
| 10 | Concurrency | **PASS (executed)** | 16/16 attacks defeated live. One transient suite failure observed when run mid-API-restart — re-run clean; suite assumes API up (setup, not product, flake) |
| 11 | Security | **PASS** | No dangerouslySetInnerHTML anywhere; React text-node rendering (XSS-safe incl. notifications/support); CSV export formula-injection neutralized; ValidationPipe whitelist+forbid (mass assignment); raw `@Body("field")` reads are enum/length-validated in services; HMAC-signed queue jobs; webhook replay = idempotent unique references |
| 12 | Database | **PASS** | 2 migrations, `migrate status` clean; CHECKs live-proven (invalid inserts rejected); only cosmetic `Order_websiteId_fkey` diff remains |
| 13 | Workers/queues | **PASS** | Retries+backoff, signed payloads verified per job, fail-fast boot, graceful shutdown, repeatable jobs idempotent by jobId (payout poll 10m, reconciliation sweep 60m). Dead `payout-execute` no-op handler remains |
| 14 | Notifications | **PASS** | All money + support events emit; self-scoped reads; spoofing blocked (server-side creation only, queue HMAC); content is system-generated strings |
| 15 | Audit logging | **PASS** | Every financial mutation, role change, decrypt (actor/reason/IP/UA), reversal, chargeback transition, ticket status change writes an audit row; SUPER_ADMIN browse + CSV export. Gap: ~46 cold-path audit.log calls not tx-bound (pool risk under load, hot paths fixed) |
| 16 | Reconciliation | **~80% coverage** | Wallet, publisher withdrawable, lifetimePaid, stuck orders/payouts, dup-COMPLETED detection — now scheduled hourly w/ staff alerts + audit row. Blind spots: no global money-conservation identity; debtBalance/lifetimeEarnings drift unchecked; reservedBalance not independently checked; no provider-side compare |
| 17 | Operations | **PASS for beta** | Backup script (verify + rotate + owner-only perms), restore drill documented, pm2 supervision doc, compose restart policies, health endpoint, scheduled reconciliation alerting. Still no offsite backup automation, no uptime monitor configured, no CI/CD |
| 18 | Performance | Top risks below | Pool 25 tuned, auth cached, reconciliation grouped queries, proper composite indexes; 1000-user load proven (151 orders/s, p99 434ms) |
| 19 | Code quality | **EXCELLENT** | Zero TODO/FIXME/HACK. Debt: dead payout-execute handler, deprecated UserRole/MemberRole enums, REVERSED-status FE filter coverage |
| 20 | Product readiness | **6/10** | Post-provisioning flows work and are discoverable; onboarding broken (A-1/A-2); dispute + listing creation API-only (A-3) |

## Findings

### A-1 — CRITICAL (product, not security) — Publisher self-serve onboarding is a dead end
- Evidence: `packages/auth/src/index.ts` (no userType on sign-up; schema default CUSTOMER); `apps/publisher/src/lib/auth.tsx:51,88` (publisher app rejects non-PUBLISHER); only `admin.service.ts:84-160 updateUserRole` creates Publisher + PublisherMembership + flips userType.
- Repro: register on :3002 → user created as CUSTOMER → publisher app refuses the session ("publishers only"). No API or UI path to self-convert.
- Impact: every real publisher requires a SUPER_ADMIN to run `PATCH /admin/users/:id/role {PUBLISHER_OWNER}`. Likelihood certain; financial impact zero (fail-closed); business impact high at any scale.
- Remediation: publisher application flow (signup intent → admin approval queue invoking the existing conversion), or invite-token signup. Beta workaround: provision via admin (document in runbook).
- Confidence: HIGH.

### A-2 — CRITICAL (product) — Customer self-serve onboarding cannot reach first deposit
- Evidence: sign-up creates bare CUSTOMER; no org auto-creation; portal has NO createOrganization UI (`grep createOrganization apps/portal/src` → empty); deposit/checkout require `@MemberRoles("OWNER")` (billing.controller.ts:27,40) — a user with no membership has customerRole null → 403.
- Repro: register on :3001 → dashboard loads → every money action 403s; no screen offers org creation (API `POST /identity/organizations` exists).
- Remediation: post-signup "create your organization" step calling the existing endpoint (small FE work — backend complete). Beta workaround: admin provisions orgs.
- Confidence: HIGH.

### A-3 — HIGH (product) — Two journeys are API-only
- Customer dispute: backend `POST /orders/:id/dispute` (orders.controller.ts:135) — no portal UI to open one (admin resolve UI exists).
- Publisher listing creation: backend `POST /marketplace/listings` (marketplace.controller.ts:184) — publisher app has no listings page at all.
- Impact: disputes funnel to support tickets; publishers can't self-list inventory. Remediation: two pages, endpoints ready.

### A-4 — LOW (security config) — Prod trustedOrigins fallback includes localhost
- `packages/auth/src/index.ts:27-34`: when `TRUSTED_ORIGINS` unset in production, localhost:3000-4000 are trusted origins. Combined with dev-style deploys this loosens origin checking. Remediation: fail-fast in production when TRUSTED_ORIGINS missing (same pattern as QUEUE_SIGNING_SECRET).

### A-5 — LOW — Order accept/delivery deadlines still absent (carried)
SUBMITTED orders hold customer funds in escrow indefinitely; only reconciliation's stuck-order check surfaces them. Remediation: timeout sweep + auto-cancel/refund policy.

### Carried accepted gaps (unchanged)
Provider-send crash window; no provider-side reconciliation; ~46 cold-path audit.log without tx; 30s auth-cache role latency; marketplace reviews default-APPROVED; in-app-only notifications (no email); FE has no component-test infra.

## Scores

| Dimension | Score |
|---|---|
| Backend | 9.0 |
| Frontend | 7.5 |
| Security | 8.5 |
| Financial integrity | 9.0 |
| Operations | 6.5 |
| Scalability | 7.0 |
| Product readiness | 6.0 |
| **Overall** | **7.8** |
| **Beta readiness** | **8.0** (invite-only/admin-provisioned) |
| **Production readiness** | **5.5** |

## Recommendation: **CONTROLLED BETA**

Conditions: admin-provisioned accounts only (A-1/A-2 make self-serve impossible anyway — fail-closed); document provisioning runbook; offsite backup copy before first dollar; uptime monitor on /health.

### Top 10 risks before launch
1. A-1/A-2 onboarding requires manual provisioning (operational bottleneck, not breakage)
2. No offsite backup automation (script exists; cron + copy not configured)
3. No uptime/queue monitoring service attached
4. Dispute UI missing — disputes will land in support tickets
5. Publisher listing UI missing — inventory growth requires staff
6. Order timeout absence — escrowed funds age silently
7. Email channel absent for money events
8. Provider-send crash window (manual recovery runbook only)
9. Single-process API/worker, no supervisor configured yet on the box
10. A-4 trustedOrigins prod fallback

### Before 10x
Cold-path audit-in-tx sweep; provider-side reconciliation; reconciliation full-scan growth; shared auth cache for multi-instance; campaign edit + reports depth; review moderation; CI/CD.

### Before 100x
Double-entry ledger as source of truth; table partitioning (Transaction/AuditLog/OrderEvent); hot-row version-guard contention strategy; payout batching; multi-currency or enforced USD-only; KYC/tax compliance tooling; search engine for marketplace.

### Immediate plan
1. Onboarding: org-creation step (portal) + publisher application/invite flow — backend exists, FE-only
2. Dispute + listing pages (endpoints ready)
3. TRUSTED_ORIGINS fail-fast in prod
4. Backup cron + offsite copy + uptime monitor
5. Order accept-deadline sweep

30-day: email notifications, campaign edit, provider-side reconciliation, audit-in-tx sweep, FE test infra.
90-day: double-entry ledger, Stripe Connect onboarding (KYC), CI/CD + containerization, incremental reconciliation, data lifecycle.
