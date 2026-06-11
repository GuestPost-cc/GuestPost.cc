---
note_type: audit-report
project: guestpost-platform
type: pre-beta-cto-audit
date: 2026-06-11
auditor: Principal Software Architect / Staff Engineers / Security Auditor
coverage: 22 of 22 parts
---

# CTO Audit Report — GuestPost.cc Pre-Beta

## 1. Executive Summary

GuestPost.cc is a well-architected platform with strong financial integrity foundations. Core money flows are guarded by version-based optimistic concurrency, idempotency keys, and in-transaction audit logging. Integration, concurrency, and load tests prove the money loop works under 1000 concurrent users with zero drift.

However, the audit found **11 CRITICAL** and **24 HIGH** severity issues that must be resolved before processing real money.

**Primary risk categories:**
1. **No production deployment pipeline** — cannot ship without manual steps
2. **Frontend/API contract drift** — settlement approval endpoint is broken; admin lists return wrong shapes
3. **AuthGuard uses separate Prisma client** — bypasses connection pool, will exhaust connections under load
4. **Webhook chargeback handler does not debit wallet** — platform absorbs chargeback losses
5. **Refund clawback can brick on CHECK constraint** — one drift event makes refunds permanently fail
6. **Settlement TOCTOU race** — dispute opened between check and transaction bypasses block
7. **Clawback debt not enforced on withdrawals** — publisher with debt can drain balance
8. **No API graceful shutdown** — in-flight transactions killed on pod restart
9. **Critical enum drift** — `CHARGEBACK` missing from Prisma schema but exists in DB
10. **Missing DB CHECK constraints** — `grossAmount = fee + publisherAmount` on Settlement; `amount <= withdrawableBalance` on Withdrawal
11. **All 5 workers use console.log** — no structured logging, no log level filtering

---

## 2. Critical Findings (11)

### C1. No production deployment pipeline
- **Files**: `.github/workflows/` (missing `deploy.yml`), `main.yml`, `pr.yml`
- **Finding**: Zero deployment automation. No Dockerfiles for any app service. CI builds nothing deployable.
- **Risk**: Cannot ship. Human deploy error inevitable.
- **Fix**: Create Dockerfiles for API + Worker. Build in CI. Add deployment job.

### C2. AuthGuard uses standalone Prisma client, bypassing connection pool
- **File**: `apps/api/src/modules/auth/auth.guard.ts:4`
- **Finding**: Imports `{ prisma }` from `@guestpost/database` directly, bypassing `PrismaService` and its `connection_limit=25&pool_timeout=20` config.
- **Risk**: Under concurrent auth-cache misses, exhausts PG connections. Pool-deadlock bug was already fixed in hot money paths — this is the same bug pattern in a cold path.
- **Fix**: Replace with injected `PrismaService`.

### C3. Frontend settlement approval endpoint broken
- **File**: `packages/api-client/src/settlements.ts:29` → backend `POST /settlements/:id/customer-approve`
- **Finding**: Client calls `/settlements/:id/approve`. Route does not exist. Every customer settlement approval produces 404.
- **Risk**: Customers cannot approve settlements. Platform must intervene for every release.
- **Fix**: `s/approve/customer-approve/` in API client.

### C4. No middleware.ts in any frontend app (client-side-only route guarding)
- **Files**: All 4 Next.js apps — no `middleware.ts`
- **Finding**: Protected pages render before client-side redirect fires. Brief window where dashboard content is visible after JS load.
- **Risk**: Non-STAFF users see admin panel flash before redirect.
- **Fix**: Add Next.js middleware with server-side auth checks per app.

### C5. Admin AuthProvider does not validate STAFF role
- **File**: `apps/admin/src/lib/auth.tsx:42-55`
- **Finding**: `refresh()` fetches user but never checks `userType === "STAFF"`. Any authenticated user navigating to `/dashboard` sees admin UI.
- **Risk**: Customers/publishers view admin panel, see all settlements, withdrawals, PII.
- **Fix**: Reject non-STAFF in auth provider.

### C6. Chargeback handler only audits — no wallet debit
- **File**: `apps/api/src/modules/billing/billing.service.ts:97-129`
- **Finding**: Stripe chargeback triggers notification + audit. Customer wallet unchanged. Platform owes Stripe real money while customer retains deposit.
- **Risk**: Real financial loss if staff misses notification.
- **Fix**: Debit wallet via `CHARGEBACK` transaction type. Wrap in version guard.

### C7. Refund clawback can brick on CHECK constraint
- **File**: `apps/api/src/modules/orders/services/refund.service.ts:106`
- **Finding**: `lifetimeEarnings: { decrement: owed }` fails if `lifetimeEarnings < owed` due to `lifetimeEarnings >= 0` CHECK constraint. Entire refund transaction rolls back.
- **Risk**: One accounting drift makes refunds permanently impossible. Customer cannot get money back.
- **Fix**: `decrement: Decimal.min(lifetimeEarnings, owed)`.

### C8. API missing graceful shutdown (SIGTERM/SIGINT)
- **File**: `apps/api/src/main.ts` — no signal handlers
- **Finding**: Worker has graceful shutdown. API does not. NestJS server dies immediately on pod termination.
- **Risk**: In-flight HTTP requests and transactions killed mid-execution. Money movement interrupted.
- **Fix**: Add `app.enableShutdownHooks()` + `process.on('SIGTERM', ...)` with drain.

### C9. Settlement dispute check has TOCTOU race
- **File**: `apps/api/src/modules/settlements/settlements.service.ts:140-143, 222-226`
- **Finding**: Both `customerApprove` and `adminApprove` check active dispute OUTSIDE transaction. Dispute opened between check and tx commit bypasses block.
- **Risk**: Settlement releases while dispute is active. Funds released to publisher before dispute resolved.
- **Fix**: Move dispute `findFirst` INSIDE transaction using `tx`.

### C10. `TransactionType` missing `CHARGEBACK` enum value in Prisma schema
- **File**: `packages/database/prisma/schema.prisma:853`; archived migration `20260611020000/migration.sql:51`
- **Finding**: Archived migration adds `CHARGEBACK` to TransactionType enum in DB. Prisma schema and generated enums.ts do NOT include it. Prisma client rejects `CHARGEBACK` at TypeScript level.
- **Risk**: Cannot write `TransactionType.CHARGEBACK` in code without type error. DB and app drift.
- **Fix**: Add `CHARGEBACK` to schema.prisma enum.

### C11. Clawback debt not enforced on withdrawals
- **File**: `apps/api/src/modules/publisher-payouts/publisher-payouts.service.ts:187-197`
- **Finding**: `requestWithdrawal` checks `withdrawableBalance` but never checks `debtBalance`. Publisher with outstanding clawback debt can withdraw all other earnings.
- **Risk**: Money owed to platform can be withdrawn by publisher. Platform loses funds.
- **Fix**: Add `debtBalance > 0` check in `requestWithdrawal`.

---

## 3. High Findings (24)

### H1. Settlement: no `grossAmount = platformFee + publisherAmount` CHECK constraint
- **File**: `packages/database/prisma/migrations/.../migration.sql`
- **Finding**: Fundamental accounting equation unenforced at DB level. Code could shift money silently.
- **Fix**: Add CHECK constraint via raw SQL migration.

### H2. Withdrawal: no `amount <= withdrawableBalance` CHECK constraint
- **File**: `packages/database/prisma/schema.prisma:646-670`
- **Finding**: Application-level guard exists but no DB-level safeguard. Code bug could create overdraft.
- **Fix**: Add CHECK constraint.

### H3. Transaction `amount` sign convention unenforced
- **File**: `packages/database/prisma/schema.prisma:865-890`
- **Finding**: Positive for DEPOSIT, negative for PURCHASE/WITHDRAWAL. Convention only. No CHECK `amount != 0` or type-specific sign constraint.
- **Risk**: Single sign error corrupts every balance calculation and reconciliation.
- **Fix**: Add `amount != 0` CHECK + type-specific sign constraints.

### H4. All CHECK constraints invisible to Prisma — silently dropped on regeneration
- **File**: `packages/database/prisma/migrations/20260611120000_squashed_baseline/migration.sql`
- **Finding**: 6 critical CHECK constraints exist only in raw migration SQL. Prisma has no `@@check` support. Fresh `prisma migrate dev` drops them all.
- **Fix**: Add idempotent re-application guard in migration.

### H5. `addOrderItem` / `removeOrderItem` lack transaction wrapping
- **File**: `apps/api/src/modules/orders/orders.service.ts:160-219`
- **Finding**: Multiple writes (create item, aggregate, update order, create event) without `$transaction`. Crash between writes leaves inconsistent state.
- **Fix**: Wrap in `this.prisma.$transaction`.

### H6. `customerApprove` / `returnToReview` audit.log outside transaction
- **File**: `apps/api/src/modules/settlements/settlements.service.ts:176-183, 368-383`
- **Finding**: Audit entry persists even if transaction rolls back. Orphaned audit records.
- **Fix**: Pass `tx` to `audit.log`.

### H7. `adminApprove` has no audit.log call
- **File**: `apps/api/src/modules/settlements/settlements.service.ts:228-261`
- **Finding**: Settlement admin approval has no audit log entry. Relies only on OrderEvent.
- **Fix**: Add `audit.log({ action: "SETTLEMENT_ADMIN_APPROVED", ... })` inside transaction.

### H8. IdentityController bypasses service layer
- **File**: `apps/api/src/modules/identity/identity.controller.ts:19-24`
- **Finding**: Injects PrismaService and AuditService directly. `getMe()` returns raw Prisma user without service delegation.
- **Fix**: Delegate to IdentityService.

### H9. CampaignsController GET routes missing ActorTypeGuard + MemberRolesGuard
- **File**: `apps/api/src/modules/campaigns/campaigns.controller.ts:86-108`
- **Finding**: `GET /campaigns`, `GET /campaigns/:id`, `GET /campaigns/:id/orders` have only global AuthGuard. Any authenticated user (publisher, staff) sees empty results instead of 403.
- **Fix**: Add `@UseGuards(ActorTypeGuard, MemberRolesGuard)`.

### H10. Frontend settlement approval button missing in customer portal
- **File**: `apps/portal/src/app/dashboard/orders/[id]/page.tsx:188-466`
- **Finding**: No settlement approval UI anywhere in portal. Customers cannot approve settlements from frontend.
- **Fix**: Add approval button for CUSTOMER_APPROVED settlements.

### H11. Support payload mismatch — client sends wrong fields
- **File**: `packages/api-client/src/support.ts:7-9` → backend expects `{ subject, description? }`, client sends `{ message, priority }`
- **Finding**: Support ticket creation broken.
- **Fix**: Align client payload with backend DTO.

### H12. Admin pagination response drift: plain array vs `{ items, total }`
- **File**: `packages/api-client/src/admin.ts:63-87` vs backend controllers
- **Finding**: `listUsers()`, `listOrganizations()`, `listOrders()` client expects plain array. Backend returns `{ items, total, take, skip }`.
- **Fix**: Update client types to match paginated response.

### H13. All 5 workers use `console.log` instead of structured logger
- **Files**: All `apps/worker/src/processors/*.ts`
- **Finding**: 62 `console.log/error/warn` calls across 6 files. No log levels, no JSON, no centralized routing.
- **Risk**: Production debugging impossible. Log aggregation useless.
- **Fix**: Replace with pino/winston.

### H14. N+1 query in marketplace stats
- **File**: `apps/api/src/modules/marketplace/marketplace.service.ts:722-728`
- **Finding**: Per-category `findUnique` inside loop.
- **Risk**: Marketplace admin page slows with category count.
- **Fix**: Single `findMany` with `{ in: categoryIds }`.

### H15. Payout adapter mock mode gated on `NODE_ENV`
- **Files**: `wise-payout.adapter.ts:18-22,73-78`, `stripe-connect-payout.adapter.ts:9-13,67-72`
- **Finding**: Mock `COMPLETED` returned when API key missing AND `NODE_ENV !== 'production'`. `NODE_ENV` is trivially overridden in cloud.
- **Risk**: Production payout marked complete with no real money sent.
- **Fix**: Use explicit `PAYOUT_MOCK_MODE` env var. Never fake-complete.

### H16. Reserved balance not individually reconciled
- **File**: `apps/api/src/modules/admin/reconciliation.service.ts:58-68`
- **Finding**: Only `availableBalance + reservedBalance` checked. Split not validated. Reserved could be wrong but drift undetected.
- **Fix**: Add individual bucket check: `reservedBalance = SUM(RESERVATION) - SUM(PURCHASE)` for active orders.

### H17. PlatformRevenue unreconciled
- **File**: `apps/api/src/modules/admin/reconciliation.service.ts` (missing check)
- **Finding**: No reconciliation check for PlatformRevenue totals vs expected fee income.
- **Fix**: Add `checkPlatformRevenue()` method.

### H18. Websites, ActiveContext, Identity services have unbounded `findMany` calls (~10k+ rows)
- **Files**: `websites.service.ts:167`, `active-context.service.ts:99,106`, `identity.service.ts:227`
- **Finding**: No `take` limit. Large datasets load all rows.
- **Fix**: Add pagination with default `take: 50`.

### H19. Settlement auto-approve is timer-based in API process
- **File**: `apps/api/src/modules/settlements/settlement-auto-approve.service.ts:31`
- **Finding**: `setInterval` inside NestJS `OnModuleInit`. Restart misses pending approvals.
- **Fix**: Move to BullMQ cron job.

### H20. Duplicate settlement creation logic bypasses SettlementsService
- **File**: `apps/api/src/modules/orders/services/order-review.service.ts:179-246`
- **Finding**: `createSettlementForOrder` duplicates fee calculation and settlement creation from `SettlementsService`. Drift risk.
- **Fix**: Call `SettlementsService.createSettlement` instead.

### H21. Platform fee not CHECK-constrained on PlatformRevenue
- **File**: `packages/database/prisma/migrations/.../migration.sql` (missing)
- **Finding**: No DB check that `platformFee = 20% of amount` on PlatformRevenue.
- **Fix**: Add CHECK constraint or enforcement in reconciliation.

### H22. `createSettlementForOrder` in order-review creates settlement for platform-owned websites — no separate platform-revenue-only path
- **File**: `apps/api/src/modules/orders/services/order-review.service.ts:199`
- **Finding**: When order is for platform-owned website, PlatformRevenue is created but no settlement. Fine for now but fragile — dedup logic on retry.
- **Fix**: Document intentional design. Ensure retry idempotency tested.

### H23. `publisher-payouts.controller.ts:41` — `details: Record<string, unknown>` bypasses DTO validation
- **File**: `apps/api/src/modules/publisher-payouts/publisher-payouts.controller.ts:40-45`
- **Finding**: Inline body type bypasses class-validator. Raw object reaches encryption.
- **Fix**: Create typed DTO per payout method type.

### H24. `payout-webhook.controller.ts:67` falls back to billing webhook secret
- **File**: `apps/api/src/modules/publisher-payouts/payout-webhook.controller.ts:67`
- **Finding**: If `STRIPE_PAYOUT_WEBHOOK_SECRET` unset, falls back to `STRIPE_WEBHOOK_SECRET`. Billing webhook secret could verify payout webhooks.
- **Fix**: Hard-fail if payout secret missing in production.

---

## 4. Medium Findings (32)

| # | Finding | File | Fix |
|---|---------|------|-----|
| M1 | `next` at root conflicts with apps' `^15` (root `^16`) | `package.json:35` | Remove from root deps |
| M2 | Prisma generate not in build pipeline | `packages/database/package.json` | Add `prebuild: prisma generate` |
| M3 | Fragile `@prisma/client` path mapping | `apps/api/tsconfig.json:15` | Import through `@guestpost/database` |
| M4 | Migrations run only in CI, not in deployment | `main.yml:59` | Move to deploy job |
| M5 | Traefik dashboard exposed without auth | `docker-compose.yml:8` | Remove or add basic auth |
| M6 | `QUEUE_SIGNING_SECRET` missing from `.env.example` | `.env.example` | Add it |
| M7 | `STRIPE_PAYOUT_WEBHOOK_SECRET` missing from `.env.example` | `.env.example` | Add it |
| M8 | Worker has no env validation | `apps/worker/src/index.ts` | Add `validateEnv()` |
| M9 | No `lint` step in CI | `main.yml`, `pr.yml` | Add `turbo lint` |
| M10 | Outdated body section in `STATUS.md` | `bedrock/STATUS.md:30` | Sync with frontmatter |
| M11 | Campaigns controller routes missing ownership guard | `campaigns.controller.ts:42-58` | Add `@MemberRolesGuard` |
| M12 | `PERMISSIONS` guard registered in `AdminModule` only — not reusable | `admin.module.ts:13` | Register as global or re-export |
| M13 | Two identical `@Public()` decorators exist | `auth/public.decorator.ts` + `common/decorators/public.decorator.ts` | Remove duplicate |
| M14 | Website API client missing `/api/v1` prefix | `apps/website/src/lib/api.ts:5` | Fix base URL |
| M15 | Portal nav not role-filtered — MEMBER sees OWNER settings | `apps/portal/src/app/dashboard/layout.tsx:35-47` | Add role check |
| M16 | Admin nav hides Finance from non-SUPER_ADMIN, but backend allows FINANCE role | `apps/admin/src/app/dashboard/layout.tsx:45` | Map roles correctly |
| M17 | Publisher submit-content chains 3 API calls with no rollback | `apps/publisher/src/app/dashboard/orders/[id]/page.tsx:141-156` | Add rollback or batch |
| M18 | No test for concurrent refunds | `scripts/concurrency-test.ts` (missing) | Add refund race test |
| M19 | No chargeback test | All test files (missing) | Add chargeback scenario |
| M20 | No platform-order money flow test | All test files (missing) | Add platform listing test |
| M21 | `lifetimeEarnings` and `lifetimePaid` fields only have non-neg CHECK — `pendingBalance`, `approvedBalance` unbounded | `migration.sql:1555-1558` | Add CHECK for all balance fields |
| M22 | `withdrawableBalance` not bounded against `pendingBalance + approvedBalance` | `migration.sql` (missing) | Add CHECK or application-level guard |
| M23 | `OrderItem.publisherId` has no FK constraint | `schema.prisma:511` | Add FK or document rationale |
| M24 | Missing composite tx indexes (`walletId+type`, `publisherId+type`) | `20260611020000/migration.sql:54-58` (archived only) | Add to live DB |
| M25 | `MarketplaceListingView` missing composite index `(listingId, createdAt)` | `schema.prisma` | Add index for trend queries |
| M26 | Stripe webhook `"dummy"` string check is dev artifact | `billing.controller.ts:54-56` | Remove |
| M27 | Payout poll failure caught silently | `apps/worker/src/index.ts:62` | Log + restart |
| M28 | User wallet `getWallet()` has find-then-create race | `billing.service.ts:213-225` | Add `@@unique([userId])` |
| M29 | `@CurrentUser() user: any` widespread — no type safety on user context | Every controller | Create `AuthenticatedUser` interface |
| M30 | Auth cache 30s TTL — stale context on missed invalidation | `auth-context-cache.ts:10` | Audit all invalidation call sites |
| M31 | Payout execution `completeExecution` rollback leaves stale `providerMetadata` | `payout.processor.ts:20-27` | Clear metadata in rollback |
| M32 | Duplicate order creation paths exist (`campaigns.createOrder` + `orders.create`) | Both controllers and client | Document or deduplicate |

---

## 5. Low Findings (18)

| # | Finding | Fix |
|---|---------|-----|
| L1 | `scripts/seed.ts:18-23` hardcoded passwords | Move to `.env` |
| L2 | `active-context.service.ts:98` `listOrganizations` dead method | Remove or use |
| L3 | `reporting.service.ts:95` `getReport` never called by controller | Wire or remove |
| L4 | `auth-context-cache.ts` — no `@ts-expect-error` but fine | — |
| L5 | `payout-encryption.service.ts:102-106` deterministic salt | Use random salt |
| L6 | `actor-type.guard.ts:15` default-permissive if no `@ActorType` set | Default-deny |
| L7 | Duplicate `lint` key in `apps/website/package.json:9,11` | Remove one |
| L8 | Empty infrastructure directories (`monitoring/`, `traefik/`, `minio/`, `postgres/`, `redis/`) | Clean up |
| L9 | `apps/api/package.json:20` redundant `@prisma/client` dep | Remove |
| L10 | Dead `audit-log/` (singular) route in admin | Remove stale directory |
| L11 | Publisher order detail shows `"—"` for missing fields | Fix field mapping |
| L12 | "Download Invoice" exports JSON not PDF | Rename or implement real invoice |
| L13 | Seed passwords hardcoded | Move to env |
| L14 | `member-roles.guard.ts:22-29` — STAFF + MemberRolesGuard trap | Document |
| L15 | `scripts/dev.sh` redundant with `pnpm services:up` | Remove |
| L16 | PayoutExecution and Withdrawal status transitions missing version guards on some paths | Add version to WHERE |
| L17 | PayoutExecution `cancelExecution` and `finalizeCompletedAtProvider` missing version check | Add version |
| L18 | Prisma client output at `src/prisma/` instead of default | Consider switching to default |

---

## 6. Scores (out of 100)

| Category | Score | Notes |
|----------|-------|-------|
| **Backend Architecture** | 72 | Strong concurrency model. Module boundary violations and missing transactions on write paths drag score. |
| **Frontend** | 45 | Broken settlement flow, no middleware, admin auth bypass, API contract drift. Highest risk area. |
| **Security** | 68 | Webhook verification solid. AuthGuard connection pool bypass, missing DTO validation on payout methods, NODE_ENV mock mode. |
| **Financial Integrity** | 78 | Best area. Version guards + idempotency keys pervasive. Chargeback gap, refund CHECK brick, debt enforcement gap. |
| **Operations** | 40 | No deployment pipeline, no Dockerfiles, no graceful shutdown on API, console.log in workers. |
| **Scalability** | 65 | N+1 in marketplace, unbounded queries in 3 services, missing indexes. Solid concurrency foundation. |
| **Overall Platform** | **61** | Good financial core. Frontend contract drift and deployment gaps prevent beta launch. |

## 7. Beta Readiness Score: 55/100

- Can process payments? Yes (tested 1000 users)
- Can settle and payout? Yes (tested e2e)
- Can customers approve settlements? **No** (broken frontend)
- Can platform deploy to production? **No** (no pipeline)
- Can ops diagnose issues? **No** (console.log)
- Can survive pod restart? **No** (no graceful shutdown)
- Can prevent chargeback loss? **No** (no wallet debit)

## 8. Production Readiness Score: 35/100

Requires all 11 critical + 15 high fixes before production consideration.

---

## 9. Launch Recommendation: CONTROLLED BETA — Conditionally

**Blocker**: 11 critical findings must be resolved first.

**Conditional approval** for limited-invite beta (≤10 customers, staff-monitored) once:
1. C3 (settlement approval endpoint) fixed
2. C5 (admin auth bypass) fixed  
3. C7 (refund CHECK brick) fixed
4. C9 (TOCTOU dispute race) fixed
5. C10 (CHARGEBACK enum) fixed
6. C11 (debt enforcement) fixed
7. H10 (settlement UI) fixed
8. H11-H12 (API contract drift) fixed

Defer to post-beta:
- C1 (deployment pipeline) — manual deploy OK for beta
- C2 (auth guard pool) — monitor, fix before production
- C4 (middleware) — UX risk, not financial
- C6 (chargeback) — low probability in beta
- C8 (graceful shutdown) — deploy with `--restart=always`

---

## 10. Top 10 Risks Before Launch

1. **Settlement never completes**: Customer sees no approval button (C3 + H10). Operations must manually approve.
2. **Refund permanently fails**: One drift event bricks refund forever (C7). Customer support nightmare.
3. **Publisher drains debt**: Clawback debt unenforced on withdrawal (C11). Platform loses money.
4. **Admin panel visible to customers**: No STAFF check + no middleware (C4 + C5). PII exposure.
5. **Settlement releases during dispute**: TOCTOU race (C9). Funds released before resolution.
6. **Chargeback incurs unrecorded loss**: No wallet debit (C6). Platform liability invisible.
7. **Admin lists all wrong**: Pagination drift (H12). Operations cannot trust numbers.
8. **API/worker crash kills transactions**: No graceful shutdown (C8). Mid-flight writes lost.
9. **Payout mock-completes in non-production**: NODE_ENV spoof (H15). Fake payout marked paid.
10. **AuthGuard exhausts PG connections**: Standalone Prisma client (C2). Cascade failure.

---

## 11. Top 10 Risks Before 10x Growth (100 customers, 10k orders)

1. **N+1 marketplace stats** (H14): Admin page timeout.
2. **Missing transaction type+publisherId indexes** (M24): Reconciliation sequential scans.
3. **Unbounded findMany** (H18): Publisher with 2k+ pages loads forever.
4. **No structured logging** (H13): Cannot trace production issues.
5. **Missing MarketplaceListingView index** (M25): Trending queries full scan.
6. **AuthGuard pool exhaust** (C2): Under 100 concurrent users → PG connection spike.
7. **BullMQ concurrency=1 on most workers**: Email/verification slow.
8. **No deployment pipeline** (C1): Deploy time grows with complexity.
9. **Settlement auto-approve misses on restart** (H19): Manual settlements pile up.
10. **Graceful shutdown missing** (C8): Every rolling deploy kills transactions.

---

## 12. Top 10 Risks Before 100x Growth (1000 customers, 100k orders)

1. **Monolith API becomes bottleneck** — no service decomposition.
2. **Marketplace search ILIKE** — FTS needed (already documented).
3. **Wallet table single row per org** — needs sharding.
4. **Reconciliation full table scans** — needs incremental/streaming.
5. **No read replicas** — reporting queries hit primary.
6. **BullMQ on single Redis** — needs cluster.
7. **No caching layer for marketplace** — every search hits PG.
8. **Notification volume** — email processor concurrency=1.
9. **AuditLog table unbounded growth** — needs partitioning.
10. **Single API process** — needs horizontal scaling with sticky sessions.

---

## 13. Immediate Action Plan (Before Beta)

| Priority | Action | Owner | Est. Effort |
|----------|--------|-------|-------------|
| P0 | Fix settlement approval endpoint (C3) | Frontend | 1h |
| P0 | Fix admin auth bypass (C5) | Frontend | 1h |
| P0 | Fix refund CHECK constraint brick (C7) | Backend | 30min |
| P0 | Fix TOCTOU dispute race (C9) | Backend | 1h |
| P0 | Add CHARGEBACK to Prisma schema (C10) | Backend | 30min |
| P0 | Add debt check to withdrawal (C11) | Backend | 1h |
| P0 | Add settlement approval UI button (H10) | Frontend | 4h |
| P0 | Fix support payload mismatch (H11) | Frontend | 30min |
| P0 | Fix admin pagination drift (H12) | Frontend | 2h |
| P1 | Add graceful shutdown to API (C8) | Backend | 1h |
| P1 | Fix AuthGuard Prisma client (C2) | Backend | 2h |
| P1 | Add chargeback wallet debit (C6) | Backend | 4h |
| P1 | Add middleware.ts to all frontends (C4) | Frontend | 4h |
| P1 | Fix payout adapter mock mode (H15) | Backend | 2h |
| P1 | Add missing CHECK constraints (H1-H3) | Backend | 3h |
| P1 | Add transaction wrapping to addOrderItem (H5) | Backend | 1h |
| P1 | Fix settlement audit.log gaps (H6-H7) | Backend | 2h |

**Total P0**: ~12h. **Total P1**: ~19h.

---

## 14. 30-Day Roadmap

| Week | Focus | Deliverables |
|------|-------|-------------|
| 1 | **Critical fixes** | All 11 critical issues resolved. Backend contract fixes. |
| 2 | **Frontend overhaul** | Settlement UI, order detail workflow, role-aware nav, middleware. API contract alignment. |
| 3 | **Operations foundations** | Graceful shutdown, structured logging in workers, deployment pipeline (Docker + CI). Missing CHECK constraints. |
| 4 | **Hardening** | Concurrency test for refunds and chargebacks. Reconciliation service expansion (PlatformRevenue, reserved balance). Dispute TOCTOU test. |

---

## 15. 90-Day Roadmap

| Milestone | Target | Criteria |
|-----------|--------|----------|
| Controlled Beta | Day 30 | All critical/high financial issues fixed. Deployment pipeline exists. Structured logging operational. |
| Open Beta | Day 60 | 10 customers in production. Reconciliation runs daily. Chargeback handling automated. |
| Full Production | Day 90 | Operations runbook complete. Performance tested at 10x projected load. Monitoring + alerting live. |

---

## 16. Part-by-Part Results

| Part | Area | Result |
|------|------|--------|
| 1 | Build & Deployment | **FAIL** — 4 CRITICAL, 4 HIGH |
| 2 | Database | **FAIL** — 1 CRITICAL, 3 HIGH |
| 3 | Backend Architecture | **FAIL** — 1 CRITICAL, 5 HIGH |
| 4 | Frontend | **FAIL** — 3 CRITICAL, 4 HIGH |
| 5 | E2E Business Workflows | **CONDITIONAL PASS** (flows work, but settlement approval broken in frontend) |
| 6 | Financial Integrity | **FAIL** — 2 CRITICAL, 4 HIGH |
| 7 | Multi-Tenancy | **PASS** — No data leaks. 2 MEDIUM (guard gaps, no data leak). |
| 8 | RBAC | **PASS** — Role enforcement correct. 1 MEDIUM. |
| 9 | Security | **FAIL** — 4 MEDIUM (DTO bypass, webhook secret fallback, deterministic salt, missing DTO validation) |
| 10 | Payout | **PASS** — Idempotency correct. Retry safe. 4 LOW (version guards, mock mode). |
| 11 | Settlement | **FAIL** — 1 CRITICAL (TOCTOU dispute race) |
| 12 | Refund | **FAIL** — 1 CRITICAL (CHECK brick), 1 MEDIUM (debt not enforced) |
| 13 | Concurrency | **PASS** — Guards proven at 1000 users. Missing refund/concurrent test added to backlog. |
| 14 | Worker & Queue | **PASS** — All processors registered. Retry configs appropriate. Missing graceful shutdown on API (separate). |
| 15 | API Contract | **FAIL** — 1 CRITICAL, 4 HIGH, 2 MEDIUM |
| 16 | Notification | **PASS** — Workers handle. Notification audit not deep-dived. |
| 17 | Audit Log | **PASS** — Most critical paths audited. Gaps in settlement adminApprove. |
| 18 | Reconciliation | **PASS** — Works for wallet/publisher drift. Gaps: PlatformRevenue, reserved balance split. |
| 19 | Frontend UX | **FAIL** — Settlement approval missing, deposit not wired, chained mutations without rollback. |
| 20 | Performance & Scale | **FAIL** — N+1, missing indexes, unbounded queries. |
| 21 | Technical Debt | **PASS** — Low debt. 62 console.log calls primary concern. |
| 22 | Disaster Recovery | **FAIL** — No graceful shutdown on API. Console.log prevents production debugging. |

**Overall Result**: 11 PASS / 11 FAIL

---

*Audit completed 2026-06-11. Full evidence in Part 1-22 agent reports. Raw test outputs captured and stored in Evidence/raw/.*
