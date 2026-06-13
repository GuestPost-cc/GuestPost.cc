# GuestPost.cc Full A–Z Audit — 2026-06-12 (extreme-security pass)

Commit `b97292a`. Method: live re-execution + fresh adversarial battery on the newest surfaces (invites/switch/membership-status) and surfaces never probed before (account enumeration, password policy, MFA, audit immutability, residual PII on secondary listing endpoints). Auditor disclosure: authored much of this code — this is rigorous self-attack, not third-party independence.

## VERDICT: OPEN BETA (unchanged) — overall 8.4

Money engine and tenant isolation survive direct attack. Gaps are operational + identity-hardening, not correctness.

---

## A. CORE STRUCTURE & BUSINESS LOGIC — PASS
- Monorepo: api (NestJS) + worker (BullMQ) + 4 Next apps + shared/db/ui/api-client packages. Clean module boundaries.
- Money workflows close end-to-end (deposit→order→settlement→withdrawal→payout, refund w/ clawback+debt, chargeback hold/release/debit, FAILED-withdrawal reversal). Platform vs publisher orgs branch on `ownershipType`.
- Org model now correct: personal-org creator = OWNER (invariant fixed), invites are PENDING until accepted, per-org workspace isolation.

## B. END-TO-END USABILITY — PASS w/ gaps
Verified live this session: customer signup→org-gate→deposit, publisher signup→convert→listing, invite→pending→accept→switch, full money loop (26/26 integration). Gaps: no email channel (in-app notifications only), support is ticket-only, no campaign-level analytics depth.

## C. UI/UX — 8/10
Sticky sidebars, role-aware nav (owner-only items hidden from MEMBER, finance from OPERATIONS), org switcher w/ pending-invite badges, status maps guarded against unknown enum values, error/empty/loading states present. Friction: no bulk actions, no saved filters, marketing site legal pages need counsel.

## D. SECURITY — 9/10 (battery clean, identity-hardening gaps)

### Repelled live this pass
| Attack | Result |
|---|---|
| Invite-accept IDOR (other user's membershipId) | 404 |
| Weak password signup ("123") | 400 PASSWORD_TOO_SHORT |
| Switch into unaccepted (PENDING) org | 403 |
| MEMBER deposit in inviting org | 403 |
| (prior) privesc ×4, mass-assign, negative deposit, garbage JWT | 403/400/401 |

### New findings
**S-1 — MEDIUM — Account enumeration via invite.** `inviteMember` returns `404 "User not found"` for unregistered emails vs success for registered → an org owner can probe whether any email has an account. `identity.service.ts:142`. Confirmed live. Fix: return a generic success ("If that user exists, they've been invited") and create the pending invite keyed by email even when no user yet (claim on signup), OR uniform 202 regardless.

**S-2 — LOW — Residual internal-field leak on secondary listing endpoints.** The public search/detail PII leak was fixed (toPublicListing), but `getFavorites` / `getRecommendations` / saved-lists return the raw listing row — still carrying `organizationId`, `publisherId`, `semrushData`, `metricsData`, `trafficData`. No publisher email (no publisher include there), and these are authed (user's own data), so lower risk — but internal ids + raw provider metric dumps still leak. `marketplace.service.ts:524+`. Fix: route these through `toPublicListing` too.

**S-3 — HIGH (for production) — No MFA/2FA.** better-auth configured with email/password + Google + magic-link, but no second factor. SUPER_ADMIN can decrypt payout banking details and move money — a single phished staff password is full compromise. `packages/auth/src/index.ts`. Fix: enable better-auth `twoFactor` plugin, mandatory for STAFF, optional for customers/publishers.

**S-4 — LOW — No explicit session/cookie hardening config.** better-auth uses defaults (7-day session). No configured `expiresIn`/`updateAge`. Acceptable for beta; tighten for production (shorter staff sessions, idempotent refresh).

**S-5 — LOW — Audit log is append-only by convention, not enforcement.** No `auditLog.delete`/`update` anywhere in code (good), but nothing at the DB level stops a compromised admin with direct DB access from deleting rows. Fix (defense-in-depth): a Postgres rule/trigger blocking UPDATE/DELETE on AuditLog, or ship audit to append-only external sink.

### Strong, verified
helmet+CSP, tiered rate limits (auth/marketplace/admin/billing), fail-closed webhook signature verify (Stripe HMAC + Wise RSA), HMAC-signed queue jobs, AES-256-GCM payout details w/ explicit-grant decrypt (SUPER_ADMIN cannot bypass), CSV formula-injection neutralized, ValidationPipe whitelist, tenant isolation structural, prod env fail-fast.

## E. FINANCIAL INTEGRITY — 9.5 (live-proven)
Reconciliation `ok:true` (per-account conservation), 16/16 concurrency, 30/30 signed-webhook provider validation, 9 DB CHECK constraints + 6 orphan probes all zero. Money-in/out balances.

## F. SCALABILITY — 7/10
1000-user load proven (151 ord/s, p99 434ms). Risks at 100K: no double-entry ledger, reconciliation full-table scans, single Postgres/Redis, per-instance auth cache, marketplace LIKE search.

## G. OPERATIONS — 7/10
Backup script + runbook + scheduled reconciliation alerting + CI. Gaps: no offsite backup automation, no uptime monitor attached, container build needs ≥4GB host.

---

## IMPROVEMENT ROADMAP — "better everything"

### Extreme-security hardening (priority)
1. **MFA for staff** (S-3) — mandatory TOTP for SUPER_ADMIN/FINANCE/OPERATIONS.
2. **Fix enumeration** (S-1) + uniform responses on auth-adjacent endpoints.
3. **Audit-log immutability** at DB level (S-5).
4. **Step-up auth** for the highest-risk actions (payout decrypt, force-approve, tier change) — re-prompt password/MFA even within a live session.
5. **Per-endpoint rate limits** on invite/switch (currently only the generous global fallback) — invite-spam + enumeration throttle.
6. **Secret rotation runbook** + `PAYOUT_ENCRYPTION_KEY` versioned rotation (schema already has `encryptionKeyVersion` — wire the rotation job).
7. **CSP tighten**: currently allows `'unsafe-inline'` styles — move to nonce-based.
8. **Anomaly alerts**: velocity checks (N withdrawals/hour, deposit→immediate-withdraw, new-publisher large payout) feeding the existing staff-notification rail.

### Core workflow / feature upgrades
9. **Double-entry ledger** — replace cached-balance + reconciliation with an immutable ledger as source of truth; reconciliation becomes a one-line invariant. Biggest correctness+scale win.
10. **Email channel** — money events (settlement, payout, dispute, chargeback) currently in-app only; add transactional email (the email worker exists, unused for these).
11. **Stripe Connect onboarding** — delegate publisher KYC to Stripe; unlocks automated payouts beyond the manual rail.
12. **Order accept/delivery SLAs** — auto-cancel/refund SUBMITTED orders past deadline (reconciliation already detects stale ones; add the action).
13. **Dispute evidence flow** — structured dispute UI (attachments, publisher response) instead of funneling to support tickets.
14. **Provider-side reconciliation** — compare Wise/Stripe transfer lists vs PayoutExecution to catch orphan provider transfers (current blind spot).
15. **Marketplace search engine** (Meilisearch/Typesense) — replace SQL LIKE; faceted, fast, typo-tolerant.
16. **Bulk operations** — multi-order checkout, bulk listing moderation, CSV import for publishers.
17. **Webhook delivery to customers** (org API keys exist) — let agencies integrate order status into their own tools.
18. **Saved searches + alerts** — notify when matching inventory lists.

### Data lifecycle / scale
19. Partition Transaction/AuditLog/OrderEvent (append-heavy).
20. Shared Redis-backed auth cache for multi-instance deploy.
21. Archival for view/click analytics tables.

---

## SCORES
Backend 9.0 · Frontend 8.5 · Security 9.0 (→ 9.5 after MFA) · Financial 9.5 · Operations 7.0 · Scalability 7.0 · Product 8.0 · **Beta 8.5 · Production 6.5 · Overall 8.4**

## Top 5 before any public launch
1. MFA for staff (S-3)
2. Offsite backup automation + uptime monitor
3. Fix account enumeration (S-1)
4. Real Wise sandbox transfer + container build on real host
5. Legal review (terms/privacy/refund) + audit-log immutability

## Final verdict
**OPEN BETA** with the documented guardrails. The platform's money core is the strongest part — proven by live attack, concurrency, and reconciliation, not by trusting prior reports. To reach Limited/Full Production the work is identity hardening (MFA, step-up, enumeration) + operational closure (backups, monitoring, real provider creds, legal), plus the double-entry ledger as the long-term correctness foundation. None of it is firefighting; it's deliberate hardening of an already-sound system.
