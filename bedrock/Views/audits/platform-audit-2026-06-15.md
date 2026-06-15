---
title: GuestPost.cc Platform Audit
date: 2026-06-15
authors: 5 parallel domain auditors (money, marketplace+orders, security, workers, frontend) + synthesis
supersedes: bedrock/Views/AUDIT_REPORT.md (2026-06-11, pre-Phase-6/7)
---

# GuestPost.cc — Full Platform Audit

A to Z review of business logic, workflows, workers, database, money flow, lifecycles, security, vulnerabilities, and improvement priorities for a production-grade guest-post marketplace ("guest-posting operating system").

---

## §0. Executive Summary

GuestPost.cc is **closer to production-grade than the average marketplace codebase I've reviewed**, but it has a small set of high-severity issues — concentrated in (1) RBAC enforcement at admin endpoints, (2) frontend reliability primitives, and (3) two half-shipped Phase 6/6.5 features — that would cause real incidents on day one of a public launch.

### Overall posture (one-paragraph verdict)

The data model and money-handling core are rigorous: every financial mutation is wrapped in a Postgres transaction, every state row carries a `version` column for optimistic locking, the `Settlement` table has a partial UNIQUE on `(orderId)` for races, fees are computed via exact Decimal subtraction, and Phase 6's snapshot trio (`listingServiceId`, `serviceType`, `ownerType`, `fulfillmentChannel`, `unitPrice`) is consistently captured at creation and read on the routing hot-path. SSRF guards exist on the delivery-verification worker (uncommon in marketplaces), HMAC job signing is mandatory and uniformly enforced across all 9 worker processors, the helmet + CSP configuration is one of the strongest I've seen, and the global ValidationPipe is set to `forbidNonWhitelisted: true`.

The gaps are not in those mechanics — they're in **coverage uniformity, observability, and admin-side enforcement**. The standardized `orderEventMetadata` audit helper is used at 2 of ~30 money-touching audit callsites. The admin support endpoints bypass the channel-aware visibility matrix that the customer/publisher endpoints enforce. The `SettlementAutoApproveService` runs as a `setInterval` in every API instance instead of one worker job. There is no PlatformRevenue reporting endpoint despite the data being in the DB. There is no Sentry, no error boundaries, no 401-redirect handler in any frontend app. Publisher and admin apps are effectively desktop-only because their sidebars don't collapse on mobile. The shared `<BriefRenderer>`, `<FulfillmentChannelBadge>`, `<SupportPanel>` shipped in Phase A are exported from `@guestpost/ui` but **zero pages import them yet**.

### Production-readiness scorecard

| Dimension | Score | Notes |
|---|---|---|
| Data model + money invariants | **A−** | Optimistic locking everywhere, partial UNIQUE on Settlement, CHECK constraints on all money columns, snapshot trio. Multi-currency declared but unimplemented. |
| State machine integrity (order lifecycle) | **A** | 18 states, version-guarded transitions, every business endpoint atomic. One race in `confirmDelivery` inner `updateMany` (no status guard). |
| Channel-aware routing (Phase 6/6.5) | **A** | Snapshot-first, ownership-fallback applied uniformly at all 9 hot-path reads. Zero holdouts. |
| Auth + global guards | **B+** | Better Auth + JWT-cookie + bearer-token; helmet excellent; ValidationPipe strictest setting. **Email verification not enforced.** |
| RBAC granularity | **C** | Class-level `@StaffRoles` decorator on AdminController is *overridden* by handler-level decorators — and many handlers have no override, so FINANCE inherits read access to every customer/order/ticket. |
| Multi-tenant isolation | **A−** | Tenant-scoped composite uniqueness on idempotency keys. One subtle case-sensitivity issue with `User.email`. |
| Worker idempotency | **B** | Money-touching paths (payout, refund clawback, deposit) are version-guarded and idempotent. Email/notification/report queues are not — retries duplicate side effects. |
| Worker observability | **D** | No Sentry, no metrics, no health endpoint on the worker. Console-log only. |
| Job signing + queue security | **A−** | HMAC mandatory, stable canonicalization, timing-safe compare. No replay protection (no `iat`). |
| SSRF + outbound calls | **B** | Per-hop guard with private-IP allowlist; rejects RFC1918, loopback, link-local. **DNS rebinding not addressed.** No body-size cap on delivery-verification fetch. |
| Frontend reliability (errors/loading/empties) | **C+** | Portal is genuinely excellent. Publisher/admin are uneven; no error boundaries; no Sentry; toasts shed server messages. |
| Frontend mobile | **D (publisher/admin), B+ (portal)** | Portal has a proper drawer; publisher/admin sidebars don't collapse below `lg`. |
| Frontend design-system consistency | **C** | `PUBLISHED` renders as three different greens depending on the page; ticket OPEN is blue vs red between portal & admin; new shared badge components unused. |
| Reporting + finance visibility | **D** | `PlatformRevenue` is the platform's actual cut — written but **never read** by any endpoint or UI. No revenue dashboard exists. |
| Documentation + audit trail uniformity | **C+** | Audit rows exist for every mutation but only 2/~30 use the Phase 6 metadata helper. Two competing `auditMeta` helpers diverge. |

**Weighted overall: B / Pre-production**. The platform can power a private beta or invite-only customer set today. Public launch should wait on the §2 cross-domain critical findings.

---

## §1. Architecture in 60 seconds

```
                    ┌─────────────────────────────────────────┐
                    │   apps/website (:3000, public, SSR)     │
                    └─────────────────────────────────────────┘
                                       │
   ┌───────────────────────────────────┼───────────────────────────────────┐
   │                                   │                                   │
   ▼                                   ▼                                   ▼
apps/portal (:3001)         apps/publisher (:3002)              apps/admin (:3003)
customer/agency                 site owners                  SUPER_ADMIN/OPS/FINANCE
   │                                   │                                   │
   └───────────────────────────────────┼───────────────────────────────────┘
                                       │
                          packages/api-client (HTTP)
                                       │
                                       ▼
                          apps/api (NestJS, :4000)
                          │       │           │
                Postgres 17 │   Redis 7 │   MinIO/R2
                   │         │           │
                   │      BullMQ          │
                   │   ┌─────┴────────┐   │
                   └──▶│ apps/worker  │◀──┘
                       │ 9 processors │
                       │ 4 crons      │
                       └──────────────┘

Shared:
  packages/database  → Prisma schema (14 migrations through Phase 7)
  packages/shared    → briefs/, lifecycle/, audit/, queues, signing, fee math, cores
  packages/ui        → 33 components (BriefRenderer/FulfillmentChannelBadge/SupportPanel new)
  packages/auth      → Better Auth handler config
```

Build: pnpm 11 + Turbo 2, 11 build targets. Better Auth for sessions (cookie + bearer). Money paths: orders → wallet → settlement → platform-revenue (PLATFORM) OR settlement-release → publisher-balance → withdrawal → payout-execution → provider (Stripe Connect / Wise / manual).

---

## §2. Top 30 Cross-Domain Findings (synthesized + ranked)

Each finding is cross-tagged with the agent(s) that surfaced it. Severity is the synthesized rating across security, financial, operational, and UX impact.

### Critical (production-blockers / financial integrity / data-exposure)

**#1 — Admin support endpoints bypass channel-aware visibility matrix** [marketplace, security]
`apps/api/src/modules/admin/admin.service.ts:1065-1189` — `listTicketsAdmin`/`getTicketAdmin`/`addTicketMessageAdmin` operate on every ticket regardless of `assignedToUserId`/`fulfillmentChannel`. The class-level `@StaffRoles("SUPER_ADMIN","OPERATIONS","FINANCE")` is `getAllAndOverride`-overridden by handler decorators, but these handlers have no override, so every staff role sees and replies to every ticket. The whole point of Phase 6.5 is defeated through the `/admin/support/*` route.
*Fix:* delegate to `SupportService` with the staff actor OR gate to SUPER_ADMIN/FINANCE only.
✅ **FIXED 2026-06-15** — Phase 6.6. All four bypass methods deleted from `admin.service.ts`; admin controller delegates to `SupportService` with the staff actor. Matrix enforcement is the single code path. See §11 Remediation Log.

**#2 — AdminController class-decorator override leaks customer data to FINANCE** [security]
`apps/api/src/modules/admin/admin.controller.ts:30,92-127,403-432` — same pattern. `listUsers`, `getUser`, `listOrganizations`, `listOrders`, `listMarketplaceListings`, `getMarketplaceStats`, `listSupportTickets`, etc. inherit the broad class-level allowance because Nest's Reflector takes handler-level last. **A FINANCE staffer can dump every customer's membership graph, every cross-org order, every support thread.**
*Fix:* remove the class-level decorator; every handler must declare exactly which roles it allows.
✅ **FULLY FIXED 2026-06-15** — Phase 6.7. (1) `StaffRolesGuard` is now fail-closed — empty/missing role metadata throws ForbiddenException instead of allowing. (2) Class-level `@StaffRoles` on `AdminController` removed; every handler declares its own gate explicitly per the 4-category matrix (universal-staff-reads / financial-actions / operational-actions / admin-overrides). (3) Metadata-coverage test (`admin-rbac-coverage.spec.ts`) reflects over every route and fails if any handler lacks `@StaffRoles` — prevents future PR regressions. (4) Finance data-exposure review: narrowed `listOrders` / `listOrganizations` projections to drop `Website.verificationToken` (DNS-TXT secret) and `Organization.settings` (opaque config JSON) from response shapes.

**#3 — `submitPayment` allows MEMBER role to drain the org wallet** [security]
`apps/api/src/modules/orders/orders.controller.ts:92-99` — `@MemberRoles("OWNER","MEMBER")`. Any invited org member can take a DRAFT order to PAID. `cancelOrder` correctly restricts to OWNER. Approve-content / confirm-delivery / customer-approve-settlement (which release publisher payment) are also OWNER+MEMBER.
*Fix:* restrict money-moving customer endpoints to OWNER, or add a per-org "can approve money movements" permission.
✅ **FIXED 2026-06-15** — Phase 6.9. Layered-defense fix that improves on the audit's recommendation: controller stays `OWNER+MEMBER` (so a MEMBER who placed an order can still act on THEIR OWN order — legitimate use), service layer enforces `OWNER || creator` via the new `assertOwnerOrCreator` helper. Non-creator MEMBERs are refused at the service layer. Same pattern applied to `customerAcceptDelivery` and settlement `customerApprove`. The 3 endpoints that already had inline checks (`approveContent`, `confirmDelivery`, `submitReview`) kept theirs. 17 tests + reflection-based coverage.

**#4 — `orderEventMetadata` helper is used at only 2 of ~30 money-audit callsites** [money]
`packages/shared/src/audit/order-event-metadata.ts` has the standard. `SETTLEMENT_CREATED` and `ORDER_REFUNDED` use it; every other Order/Settlement/PlatformRevenue audit callsite does not. `delivery-intervention.service.ts` defines a *competing* `auditMeta` helper that drifts. Financial-forensic queries keying on `metadata.fulfillmentChannel` / `metadata.serviceType` / `metadata.listingServiceId` get patchy results.
*Fix:* sweep every callsite + add a lint or test rule. Retire `auditMeta` in `delivery-intervention.service.ts`.
✅ **FIXED 2026-06-15** — Phase 6.9. Swept 20+ callsites across 10 service files (orders/, settlements/, delivery flows). `delivery-intervention.service.ts:auditMeta` retired and replaced with `deliveryAuditMeta` which itself spreads `orderEventMetadata` (delivery-specific extras layered on top). Coverage test in `phase-6-9-money-path-rbac.spec.ts` walks every audit.log callsite in the perimeter and fails CI if any new one omits the helper.

**#5 — No PlatformRevenue surfacing anywhere** [money]
The platform's actual cut is on `PlatformRevenue` rows with all 5 Phase 6 snapshot fields. **No endpoint reads it.** No admin UI shows it. Finance has no live revenue dashboard, no per-channel split, no CSV export. This is the highest-value latent data in the system.
*Fix:* `GET /admin/finance/revenue?from=&to=&groupBy=serviceType|fulfillmentChannel|month`, CSV export, "Revenue" tab on `/admin/finance`.

**#6 — Settlement review window is NOT tier-aware (spec says NEW=30d / TRUSTED=14d / VERIFIED=7d)** [money]
The tier-based table exists at `publisher-payouts.service.ts:10-14` (`TIER_WITHDRAWAL_HOLDS`) — for **withdrawal** hold. Settlement review uses a single `SETTLEMENT_REVIEW_DAYS` env (default 7 in `order-review.service.ts:325`, **14 in `settlements.service.ts:79`** — two paths with different defaults).
*Fix:* lift to a shared constant; resolve per-publisher `tier` in both paths.

**#7 — No 401-redirect handler in any frontend app** [frontend]
`packages/api-client/src/client.ts:69` exposes `onAuthError?: () => void`. No app sets it. Expired tokens produce a wall of red toasts on every protected page. **This is the most common user-facing failure mode in production.**
*Fix:* `createApiClient({ baseUrl, onAuthError: () => { clearToken(); router.push('/'); } })`.
✅ **FIXED 2026-06-15** — Phase 6.8. Shared `buildAuthErrorHandler` factory in `packages/api-client/src/auth-redirect.ts` with production-grade safeguards beyond the audit's recommendation: idempotency guard (concurrent 401s fire ONE redirect), auth-endpoint skip (a 401 from `/auth/sign-in/email` is "wrong password", not "expired"), open-redirect-resistant `returnTo` sanitizer (rejects `//evil.com`, `javascript:`, `http://...`), same-page debounce (no redirect loops), full-page nav via `window.location.assign` (flushes all in-memory state). Each sign-in page reads sanitized `returnTo` to land users back where they bounced. 48 tests + 4 new XSS/open-redirect attack vectors covered.

**#8 — No error boundaries (`error.tsx`/`not-found.tsx`) in any dashboard app + no Sentry** [frontend, workers]
Any uncaught render throws Next.js default 500. No error-reporting service is wired in any of the 4 apps OR the worker. Production incidents are invisible until customers email.
*Fix:* `error.tsx` per app, `@sentry/nextjs` in apps + `@sentry/node` in worker.

**#9 — Publisher and admin apps don't collapse on mobile** [frontend]
`apps/publisher/src/app/dashboard/layout.tsx:54-100`, `apps/admin/src/app/dashboard/layout.tsx:54-102` — the 256px sidebar is permanent below `lg`, crowding content into a strip. Portal has a proper drawer.
*Fix:* mirror portal layout pattern.

**#10 — `SettlementAutoApproveService` runs in every API instance via `setInterval`** [workers]
`apps/api/src/modules/settlements/settlement-auto-approve.service.ts:32` — with N pods you get N concurrent timers every 15m. Per-row writes are version-guarded so no corruption, but triple DB load + an embarrassing pattern.
*Fix:* move to a worker repeatable job with `jobId: "settlement-auto-approve"`.

**#11 — Worker has no health endpoint, no metrics, no error reporting** [workers]
`apps/worker/src/index.ts` — K8s can't tell if the worker is alive other than process exit. BullMQ `failed` events go to `console.error` and disappear.
*Fix:* minimal Express health server, BullMQ `failed` event → Sentry.

### High (correctness / reliability / production hardening)

**#12 — Notification duplicates on every retry across 6+ call sites** [workers]
The `notification` queue, `report` queue, and direct `prisma.notification.create` calls in reconciliation, delivery-verification, trust-core, website-verification have no dedup. `Notification(userId, type, message)` has no unique constraint. Reconciliation drift writes a notification per staff member every hour until cleared.
*Fix:* add `Notification.dedupKey` + `@@unique([userId, dedupKey])`; deterministic keys per event (`recon:${runId}`, `delivery-failed:${versionId}`).

**#13 — Delivery-verification has no response-body size cap** [security, workers]
`apps/worker/src/processors/delivery-verification.processor.ts:78` — `res.text()` buffers the full body. A 1GB malicious response at concurrency 4 OOMs the worker pod.
*Fix:* stream with hard cap (e.g., 5MB), abort on overrun.

**#14 — DNS rebinding not addressed in SSRF guard** [security, workers]
`delivery-verification.processor.ts:23-35` — `isSafePublicUrl` checks hostname literally, then `fetch()` resolves it later. Attacker domain whose A record returns 169.254.169.254 (AWS metadata) bypasses the guard.
*Fix:* `dns.lookup` first; reject if resolved IP private; or undici dispatcher with `connect.lookup`.

**#15 — `reporting.service.ts:52` reads `website.ownershipType` not `fulfillmentChannel`** [money, marketplace]
The campaign report's channel split uses the legacy source. A site reassigned mid-flight would re-attribute historical revenue — exactly what the snapshot was created to prevent.
*Fix:* `(o.fulfillmentChannel ?? o.website?.ownershipType) === "PLATFORM"`.

**#16 — `removeFavorite` blasts service-scoped waitlist favorites** [marketplace]
`marketplace.service.ts:1037-1041` — `deleteMany where {userId, listingId}` drops ALL favorites for the pair, including service-specific WAITLIST notify-me entries.
*Fix:* scope to `serviceType: null`; add a separate endpoint for service-scoped removal.

**#17 — No endpoint to create a service-scoped (WAITLIST notify-me) favorite** [marketplace, frontend]
`addFavorite` hardcodes `serviceType: null`. The waitlist fan-out logic at `marketplace.service.ts:728-749` exists and works — but no customer can ever subscribe to it.
*Fix:* extend `CreateFavoriteDto` with optional `serviceType`; thread through `addFavorite`.

**#18 — Auto-`FulfillmentAssignment.assignedByUserId` = customer's userId** [marketplace]
`apps/api/src/modules/orders/orders.service.ts:282-296` — the audit row implies the customer assigned the order to the Ops staffer.
*Fix:* set `assignedByUserId = managedByUserId` (self-assignment) or sentinel; rely on `auto: true` metadata to disambiguate.

**#19 — Support fan-out uses object-identity Set, fires duplicates** [marketplace]
`apps/api/src/modules/support/support.service.ts:309-332` — `Set<{userId, organizationId}>` plus `recipients.add({...})` produces N references for one user. Users with multiple roles get duplicate notifications per event.
*Fix:* `Map<userId, organizationId>` keyed on string.
✅ **FIXED 2026-06-15** — Phase 6.6. `fanOutTicketEvent` now uses `Map<userId, organizationId | null>`; dedupe is covered by the `dedupes a user who holds multiple roles` test. Same pass also fixed channel-aware recipient sets (Finance no longer pinged on PLATFORM PUBLIC, etc.).

**#20 — Favorites page shows $0 because the response is missing services** [marketplace, frontend]
`marketplace.service.ts:997-1010 getFavorites` includes images/tags but not `services` — and the listing-level `price` column was dropped in Phase 7. Portal favorites page displays $0 for every listing.
*Fix:* include `services: {where: AVAILABLE}` and project `priceFrom`/`serviceTypes` server-side.

**#21 — Phase 6 snapshot backfill missing for historical Settlements/PlatformRevenue** [money]
Migration `20260615100000_phase6_additive` only added nullable columns. Pre-Phase-6 rows have NULL `listingServiceId`/`serviceType`/`unitPrice` forever; any report grouped by `serviceType` underreports.
*Fix:* one-shot SQL migration joining `Settlement → Order → ListingService → Website`; idempotent via `WHERE listingServiceId IS NULL`.

**#22 — Confirm-delivery inner `updateMany` lacks status guard** [marketplace]
`order-review.service.ts:209-242` — the `transition()` call drops the `status: "VERIFIED"` check. A racing customer-accept (PUBLISHED→DELIVERED) could let confirm-delivery commit on a DELIVERED row.
*Fix:* add `status: "VERIFIED"` to `updateMany.where`.
✅ **FIXED 2026-06-15** — Phase 6.9. `where: { id, version, status: "VERIFIED" }`. Race-detection test in `phase-6-9-money-path-rbac.spec.ts` grep-asserts the literal stays in the source.

**#23 — Claim race lets two Ops both succeed** [marketplace]
`order-fulfillment-assignment.service.ts:50-72` — pre-check outside tx; upsert cancels every existing open assignment then creates own. Two double-clickers both pass pre-check, both cancel each other, both end ASSIGNED.
*Fix:* partial unique index on `FulfillmentAssignment(orderId)` WHERE `status IN (ASSIGNED, IN_PROGRESS)`; or `SELECT … FOR UPDATE`.

**#24 — Platform website + auto-listing defaults are wrong** [marketplace]
`admin.service.ts:646-664` creates platform listing with `status: APPROVED` and no services. `createPlatformWebsite` doesn't override `verificationStatus`, so platform sites carry `PENDING_VERIFICATION` despite being self-owned.
*Fix:* listing → DRAFT; verificationStatus → VERIFIED for platform.

**#25 — Email-verification not enforced anywhere** [security]
`apps/api/src/modules/auth/auth.guard.ts:42` — only `banned` is checked; `User.emailVerified` is in the schema but never consulted. A freshly registered customer can immediately create orders, file disputes, open tickets.
*Fix:* in `AuthGuard.canActivate`, after loading the user, require `emailVerified` for state-changing customer routes.

### Medium

**#26 — Per-IP-only auth rate limits enable credential stuffing across an IP pool** [security] — add an email-keyed limiter on top of the 5/min/IP cap.

**#27 — Job signing has no `iat` / replay protection** [workers, security] — captured signed payloads remain replayable indefinitely; reduce to a freshness window.

**#28 — Status-color drift: `PUBLISHED` renders as three different greens** [frontend] — `green-700`, `emerald-700`, `#22c55e` depending on page; centralize via `STATUS_PRESENTATION` in `@guestpost/ui`.

**#29 — Shared Phase A components (`<BriefRenderer>`, `<FulfillmentChannelBadge>`, `<SupportPanel>`) shipped but unused** [frontend] — zero imports across `apps/`; pages still hand-roll equivalents (notably portal order-detail's `OrderSupportPanel` at lines 1026–1077).

**#30 — Hooks-rule violation in publisher listings page** [frontend] — `apps/publisher/src/app/dashboard/listings/page.tsx:182-195` calls `useMutation` inside `makeLifecycleMutation` then invokes it 4 times at component scope. Stable today, time-bomb tomorrow.

---

## §3. Money Flow Deep Dive

### 3.1 Domain model

15 models hold or move money. Key invariants:
- `Order.amount` (nullable Decimal), `OrderItem.price` summed into `Order.amount` at end of create tx
- `Wallet.{availableBalance, reservedBalance, version}` — CHECK constraint `>= 0` on both; `@@unique([organizationId])`
- `Transaction.reference @unique` (global) — the idempotency lever for all wallet mutations
- `Settlement.{grossAmount, platformFee, publisherAmount, unitPrice?, version}` — raw-SQL partial UNIQUE `Settlement_orderId_active_key` on `(orderId) WHERE status != 'CANCELLED'`
- `PlatformRevenue.{amount, platformFee, netRevenue, unitPrice?, reversedAt}` — refunds set `reversedAt`, never delete
- `PublisherBalance.{pendingBalance, approvedBalance, withdrawableBalance, debtBalance, lifetimeEarnings, lifetimePaid, version}` — CHECKs `>= 0` on each
- `Withdrawal.{amount, version, idempotencyKey?}` — `@@unique([publisherId, idempotencyKey])`
- `PayoutExecution.{amount, fee, version, idempotencyKey}` — `@@unique([withdrawalId, idempotencyKey])`

Models *missing* despite being implied by prompt or future use:
- No `WalletBalance`/`WalletTransaction` split — wallet is single-row, ledger is `Transaction`
- No standalone `Refund` model — refunds are `Transaction.type = REFUND + Order.status = REFUNDED`
- No `Currency` table — `currency` is free-text default `"USD"`

### 3.2 Happy path A→Z

```
[customer hits listing-detail page, picks service]
     │
     ▼
createOrder  ── txn ──→ Order(DRAFT, listingServiceId snapshotted, briefData Zod-validated)
                       + OrderItem(price snapshotted from ListingService)
                       + optional FulfillmentAssignment(auto, PLATFORM-only)
                       + ORDER_CREATED event
     │
     ▼
submitPayment ── txn ──→ Order(version+1, claim DRAFT→SUBMITTED via updateMany)
                       + drift-check vs ListingService.price (out-of-tx update + 409)
                       + Wallet.reserve(amount) — Transaction(RESERVATION, -amount)
                       + Wallet.payFromReserved(amount) — Transaction(PURCHASE, -amount)
                       + PAYMENT_CAPTURED event + audit
     │
     ▼  publisher/Ops state transitions (no money)
SUBMITTED → ACCEPTED → CONTENT_CREATION → CONTENT_READY → CUSTOMER_REVIEW
     │
     ▼  approveContent (customer)
APPROVED → markPublished (publisher) → PUBLISHED
                                          │
                                          ▼  worker auto-verify
                                       VERIFIED (or MANUAL_REVIEW → customer accept)
                                          │
                                          ▼  confirmDelivery (customer)
                            txn: VERIFIED→DELIVERED
                                + createSettlementForOrder(tx, order)
                                  ├─ PLATFORM: PlatformRevenue.create(grossAmount,
                                  │            platformFee, netRevenue, snapshot trio)
                                  └─ PUBLISHER: Settlement.create(status=PENDING,
                                              reviewEndsAt, snapshot trio,
                                              SettlementApproval upsert via auto-approve)
                                + DELIVERY_CONFIRMED event + audit
     │
     ▼  customer customerApprove (or auto-approve sweep after reviewEndsAt)
PENDING|UNDER_REVIEW → CUSTOMER_APPROVED (status+version guard, dispute blocks)
     │
     ▼  admin adminApprove
CUSTOMER_APPROVED → ADMIN_APPROVED → releaseFundsInternal(tx)
                                  ├─ checkSeparationOfDuties (PLATFORM only)
                                  ├─ updateMany RELEASED + settledAt
                                  ├─ debtApplied = min(PublisherBalance.debt, publisherAmount)
                                  ├─ credited = publisherAmount - debtApplied
                                  ├─ withdrawableBalance += credited;
                                  │  debtBalance -= debtApplied;
                                  │  lifetimeEarnings += publisherAmount
                                  ├─ Transaction(SETTLEMENT_RELEASE, publisherAmount)
                                  ├─ if debtApplied: Transaction(DEBT_REPAYMENT, -debtApplied)
                                  └─ Order → COMPLETED + enqueue trust recompute
     │
     ▼  publisher requestWithdrawal
PublisherBalance.withdrawableBalance -= amount; lifetimeEarnings unchanged
Withdrawal(status=PENDING, availableAt = now + tierHoldDays * 24h)
Transaction(WITHDRAWAL, -amount)
     │
     ▼  admin approveWithdrawal → executeWithdrawal → provider API
                                                       │
                                       ┌───────────────┴───────────────┐
                                       ▼                               ▼
                              webhook (Stripe/Wise)              status poller (every 10m)
                                       │                               │
                                       └────────── payout.processor ───┘
                                       completeExecution (txn):
                                       PROCESSING → COMPLETED + lifetimePaid += amount
                                       (status+version guards on PayoutExecution,
                                       Withdrawal, PublisherBalance)
```

### 3.3 Refund path (the canonical money-back flow)

Every refund — customer cancel of PAID order, admin refund, admin force-cancel of PAID, dispute resolve REFUND — funnels through `RefundService.refundOrder`:

1. Triple idempotency check: out-of-tx `findFirst`, in-tx `findFirst`, post-write P2002 on `Transaction.reference @unique` (`refund-${orderId}` or supplied key)
2. PLATFORM order: `PlatformRevenue.updateMany set reversedAt = now WHERE reversedAt IS NULL`
3. PUBLISHER + settlement NOT released: cancel settlement (version-guarded)
4. PUBLISHER + settlement RELEASED → **clawback**:
   - `clawedNow = min(PublisherBalance.withdrawableBalance, publisherAmount)`
   - `newDebt = publisherAmount - clawedNow`
   - `withdrawableBalance -= clawedNow; debtBalance += newDebt; lifetimeEarnings -= publisherAmount`
   - `Transaction(SETTLEMENT_CLAWBACK, -clawedNow)`
   - settlement → CANCELLED
5. Wallet credit refund to customer's `availableBalance`; Transaction(REFUND, +amount)
6. Order → REFUNDED + REFUND_ISSUED event + audit (uses `orderEventMetadata` — one of the only callsites)

**Customer always gets the full refund. Publisher's debt funds eventually claim from future settlements.** Math is exact.

### 3.4 Concurrency invariants

Every money mutation uses:
- `prisma.$transaction(async (tx) => …)` wrapping all writes
- `updateMany({ where: { id, version }, data: { …, version: { increment: 1 } } })` followed by `count === 0 → ConflictException`
- Often also a status guard: `where { id, version, status: <expected> }`

Audited cracks:
- `submitPayment` writes drifted prices via non-tx client (`this.prisma`) on purpose so a 409 keeps the price corrections — documented in code; safe.
- `addOrderItem`/`removeOrderItem` don't lock `Order.version`, but DRAFT-only and `submitPayment`'s status+version guard catches downstream.
- `OrdersService.cancelOrder` non-paid path only handles `PENDING_PAYMENT`, not DRAFT (with reservation from a half-completed flow).
- `cancelExecution` calls provider BEFORE local txn — 2-hour window where provider has cancel, local row is PROCESSING; reconciliation eventually catches but the publisher is stuck.

### 3.5 Idempotency table (per money endpoint)

| Operation | Mechanism | Verdict |
|---|---|---|
| createOrder | `@@unique([organizationId, idempotencyKey])` | ✅ tenant-scoped |
| submitPayment | Order version+status DRAFT guard | ✅ only one tx claims |
| refundOrder | Triple-check + `Transaction.reference @unique` | ✅ hardest guarantee |
| createSettlement | Partial UNIQUE `Settlement_orderId_active_key` | ✅ DB-level |
| customer/admin approve | Status + version guard | ✅ |
| auto-approve sweep | Status + version guard | ✅ |
| settlement release | `status: ADMIN_APPROVED, version` | ✅ re-entrant safe |
| requestWithdrawal | `@@unique([publisherId, idempotencyKey])` | ✅ |
| executeWithdrawal | Provider IK `payout-${withdrawalId}-v${version}` | ✅ |
| payout webhook | Sig-verified + `providerExecutionId` lookup + `status === PROCESSING` | ✅ |
| Stripe deposit webhook | `Transaction.reference = session.id @unique` + P2002 aborts tx | ✅ |
| Stripe chargeback | `chargeback-hold-${dispute.id}` reference | ✅ |
| markWithdrawalPaid (AUTOMATED provider) | **Refused** (webhook owns it) | ✅ |

### 3.6 Multi-currency

`currency` is a free-text column defaulting `"USD"` on `Order`, `Wallet`, `Transaction`, `ListingService`. **There is no exchange-rate service, no per-currency wallet, no Decimal-safe FX.** Wise payout hardcodes `currency: "usd"`. A non-USD listing would settle USD-as-its-own-currency with no conversion. **Multi-currency is structurally declared, functionally absent.**

Decision needed: either remove `currency` from money-bearing tables and CHECK-constrain `'USD'`, or build a real Currency + FX layer with snapshot rates per row. **Cheap insurance regardless**: add `currency` columns to `Settlement`/`PlatformRevenue`/`Withdrawal`/`PublisherBalance`/`PayoutExecution` with `'USD'` default so future migration is non-destructive.

### 3.7 Money flow strengths

- Single canonical refund path with documented clawback math (`refund.service.ts`)
- `splitPlatformFee` rounds fee to 2dp HALF_UP and subtracts for net — `fee + net === gross` always
- Stripe deposit triple-checked + tx abort on P2002 (F-1 regression test)
- Partial UNIQUE on Settlement is the DB-level race guarantee
- Reconciliation core uses BigInt at 12dp scale, set-based, catches: wallet drift, balance drift, stuck orders/withdrawals, double-COMPLETED executions, `lifetimePaid` drift
- Webhook signing fails closed (503 if secret unset)
- Provider-recovery before retry — `finalizeCompletedAtProvider` reconciles, never double-pays
- Tx-scoped `audit.log(params, tx?)` makes audit row atomic with money movement

---

## §4. Marketplace + Order Lifecycle Deep Dive

### 4.1 Listing → Service lifecycle

`MarketplaceListing.status`: DRAFT / PENDING_REVIEW / APPROVED / REJECTED / PAUSED / ARCHIVED.

`computeListingPhase()` (`packages/shared/src/lifecycle/listing-phase.ts:55`) derives UI phase:
- PUBLISHER + DRAFT + website≠VERIFIED → `AWAITING_VERIFICATION`
- PUBLISHER + DRAFT + no AVAILABLE service → `AWAITING_SERVICES`
- PUBLISHER + DRAFT + verified + ≥1 AVAILABLE → `READY_FOR_REVIEW`
- PENDING_REVIEW → `IN_REVIEW`
- PLATFORM + DRAFT + ≥1 AVAILABLE → `READY_TO_PUBLISH`
- APPROVED → `PUBLISHED`; PAUSED/REJECTED/ARCHIVED → respective

Phase 6 endpoints: `POST /marketplace/listings/:id/{submit,pause,unpause,archive}` — version-guarded, audit-logged, fail-fast on website unverified or no AVAILABLE service.

`ListingService` (the orderable unit) carries `(listingId, serviceType, price, currency, turnaroundDays, revisionRounds, warrantyDays?, requirements?, fulfillmentSettings?, availability, version)`:
- WAITLIST→AVAILABLE flip triggers waitlist fan-out (matching `MarketplaceFavorite` notifications)
- DELETE is soft-pause (preserves historical `Order.listingServiceId` resolvability)

### 4.2 Order 18-state machine

(See §3.2 for the money-relevant slice.) Full state set: `DRAFT, PENDING_PAYMENT, PAID, SUBMITTED, ACCEPTED, CONTENT_REQUESTED, CONTENT_CREATION, CONTENT_READY, CUSTOMER_REVIEW, APPROVED, PUBLISHED, VERIFIED, DELIVERED, SETTLED (legacy), COMPLETED, CANCELLED, REFUNDED, DISPUTED`.

Every transition is a business-named endpoint (submit-payment / accept / submit-content / mark-content-ready / submit-for-review / approve-content / mark-published / confirm-delivery / cancel / dispute / etc.). The `transition()` helper enforces `updateMany where { id, version, status: expectedStatus }` — except the inner call from `confirmDelivery` (`order-review.service.ts:222`) drops the status guard, creating finding #22.

### 4.3 Channel-aware routing (Phase 6/6.5)

The "channel snapshot wins, ownership fallback" pattern is applied **uniformly** at all 9 hot-path reads:

| File | Reads |
|---|---|
| `order-operations.service.ts:38` | `assertPlatformOrder` |
| `order-fulfillment-assignment.service.ts:21` | `assertPlatformOrder` |
| `order-delivery.service.ts:170` | delivery proof scope |
| `order-review.service.ts:278` | settlement vs platform-revenue branching |
| `refund.service.ts:68` | refund path branching |
| `order-ownership.guard.ts:61` | publisher access defense |
| `support.service.ts:62` | ticket creation snapshot |
| `settlements.service.ts:479` | release-side branching |

Pattern: `order.fulfillmentChannel ?? (website.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")`. Zero holdouts found in business-logic hot paths.

### 4.4 Support ticket lifecycle (Phase 6.5)

Participant matrix:

| Channel | Customer org | Assigned publisher | Assigned Ops | Unassigned platform | SUPER_ADMIN | FINANCE |
|---|---|---|---|---|---|---|
| PUBLISHER | R+W | R+W | — | — | R+W | R+W |
| PLATFORM | R+W | — | R+W | R only | R+W | R+W |
| Generic | R+W | — | — | — | R+W | R+W |

`SupportService.listTickets(actor)` enforces this via a single role-keyed OR clause. `addMessage` enforces the same matrix in `assertCanReply`. **But the admin route `/admin/support/tickets` bypasses this entirely (finding #1).**

### 4.5 Orphans + half-shipped features

- `MarketplaceFlag` (fraud flags): schema exists, no writer code path → DROP or implement
- `ListingFulfillmentRule`: schema exists, no reader/writer → DROP or implement
- `MarketplaceSearchHistory`: schema exists, `searchListings` doesn't write → wire it
- `MarketplaceListingClick`: only written on favorite, not on view/share/cta_click → expand
- `MarketplaceRecommendation`: AI rows never written, falls back to rule-based → leave or build worker
- `MarketplaceFavorite.serviceType`: WAITLIST notify-me schema + fan-out exist, no endpoint to create → finding #17

---

## §5. Security & Permissions Deep Dive

### 5.1 Auth surface

Better Auth at `/api/v1/auth/*`, mounted before body parsers. Email+password, magic-link, Google OAuth. Both cookies (`guestpost-session`, SameSite=Lax, Secure in prod) and bearer tokens accepted. **Two parallel auth identifiers double the rotation surface**; bearer is held in-memory and doesn't survive page reload, so cookie is effective primary.

`AuthGuard` (global) does:
1. `auth.api.getSession({ headers })`
2. Refuse `banned`
3. Resolve org/publisher/staff context via `ActiveContextService`
4. **30-second in-process cache** of resolved context

The 30s cache is per-process. Role downgrades propagate across replicas by TTL only; `invalidateAuthContext(userId)` is called on writes but only on the writing instance.

**Email verification is in the schema but never enforced** (finding #25).

### 5.2 RBAC layer

| Guard | What it checks |
|---|---|
| `AuthGuard` | Better Auth session, populates `req.user` |
| `ActorTypeGuard` | `userType ∈ {CUSTOMER, PUBLISHER, STAFF}` |
| `MemberRolesGuard` | `customerRole`/`publisherRole`/`staffRole` ∈ allowed |
| `StaffRolesGuard` | STAFF + `staffRole` ∈ allowed |
| `OrderOwnershipGuard` | order/settlement → org or publisher match; PUBLISHER refused on PLATFORM channel |
| `PermissionsGuard` | `StaffMembership.permissions` JSON (`FINANCIAL_DATA_DECRYPT`) |

`PermissionsGuard` is gated even for SUPER_ADMIN — proper insider-threat boundary.

**The AdminController class-decorator override (#2) is the biggest RBAC gap.**

### 5.3 IDOR / multi-tenant isolation

Pattern: every service does `findFirst({ where: { id, organizationId } })`. Composite UNIQUE on `(organizationId, idempotencyKey)` blocks cross-tenant key replay at the DB. `OrderOwnershipGuard` adds a second layer.

Minor leaks:
- `addFavorite` doesn't filter listing status → leaks existence of PAUSED/REJECTED listings by ID enumeration
- `GET /admin/users/:id` returns full org+publisher membership graph to any staff (currently leaks to FINANCE via finding #2)
- `User.email @unique` is case-sensitive — Better Auth normalizes, but direct admin invites could desync

### 5.4 Input validation

Global `ValidationPipe` with `whitelist: true, forbidNonWhitelisted: true, transform: true` — strictest Nest setting. **But** several controllers accept inline body types (`@Body() body: { foo: string }`):
- `POST /support/tickets` — unbounded content. ✅ **FIXED 2026-06-15** via `CreateTicketDto` (subject 3–200, description 0–10000, orderId regex+bounded).
- `POST /support/tickets/:id/messages` — unbounded content. ✅ **FIXED 2026-06-15** via `AddTicketMessageDto` (`@MinLength(1)` + `@MaxLength(10_000)` + `@IsEnum(TicketMessageVisibility)` on the new `visibility` field). Applied to both `/support/*` and `/admin/support/*` paths.
- `POST /admin/withdrawals/:id/execute` — `providerName` not validated. ✅ **FIXED 2026-06-15** via `ExecuteWithdrawalDto` (regex + 2–50 char bound).
- `POST /admin/disputes/:id/resolve` — `action` not enum-validated. ✅ **FIXED 2026-06-15** via `ResolveDisputeDto` (`@IsIn(["RESTORE", "REFUND", "REJECT"])` + resolution string bounds).
- `POST /api-keys` — `permissions[]` not allowlisted. ✅ **FIXED 2026-06-15** via `CreateApiKeyDto` (name 3–100, permissions max 32 entries with `domain:action` regex + 50 char each).
- **Bonus sweep** — every remaining `@Body("foo")` extraction in `AdminController` (15+ routes covering role mutations, listing moderation, website management, dispute resolution, force-cancel, refund, manual-verify, content submission, publication) was replaced with a typed DTO. Inline body extraction is now gone from `AdminController`.

`briefData` is `@IsObject()` then Zod-`strict()`-validated → unknown keys rejected. Discriminator `kind` is server-injected (anti-spoof). ✅

### 5.5 Injection

Single `$queryRaw` in the codebase: `SELECT 1` in worker health check. All other queries are Prisma-builder. ✅

### 5.6 CSRF

No CSRF middleware. Better Auth uses cookies + SameSite=Lax. The **only** CSRF defense for cookie-borne sessions is the CORS allowlist (`main.ts:378-403`). SameSite=Lax blocks cross-site POST/PUT/DELETE/PATCH from third-party origins, so this is "good enough for the era" — but **not robust** against same-site subdomain XSS or against a future SameSite policy regression.

### 5.7 File upload + storage

S3 presign is **GET-only** (`packages/shared/src/object-storage.ts`). No client-direct PUT. All puts go through the worker with server-determined keys (e.g., `deliveries/${versionId}/page.html`). No content-type validation needed; no filename traversal risk. Strong posture.

`OrderDeliveryService.submitDelivery` accepts a publisher-provided `screenshotUrl` string that gets rendered in customer/admin UI — CSP `imgSrc https:` allows but `scriptSrc 'self'` blocks JS, so XSS risk reduced to image-based phishing.

### 5.8 Rate limiting

Strong tier-based defaults: auth at 5/min, marketplace anon at 60, authed at 300, billing at 10, verification triggers at 15. **All per-IP only** — credential stuffing across an IP pool bypasses. Endpoints without explicit dedicated limiters: `POST /support/tickets`, `POST /orders/:id/dispute`, `POST /admin/orders/:id/refund`, `POST /publisher-payouts/withdrawals` — all rely on generic auth fallback (300/min).

`hasAuthCredentials()` sniffs for `guestpost-session=` in the cookie *without validating* — an attacker sending a junk session cookie gets bumped to the higher authed tier.

### 5.9 Secret + env handling

`validateEnv()` is solid: requires `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`; in prod requires `QUEUE_SIGNING_SECRET`, refuses placeholder JWT, warns on weak entropy. `QUEUE_SIGNING_SECRET` cannot reuse `JWT_SECRET` in prod. `PAYOUT_ENCRYPTION_KEY` requires 64+ hex in prod. Excellent.

Weak spots:
- `BETTER_AUTH_URL` defaults to `http://localhost:4000` *in production* if unset
- `.env.example` has `MINIO_SECRET_KEY=change_me_in_production` placeholder; no startup check
- `AllExceptionsFilter` logs full stack on 5xx; Prisma errors carry user input verbatim

### 5.10 SSRF / external

Delivery-verification (`apps/worker/src/processors/delivery-verification.processor.ts`):
- Per-hop allowlist check; rejects RFC1918, loopback, link-local IPv4, IPv6 ULA/loopback/link-local
- Manual 5-hop redirect cap
- 15s `AbortSignal.timeout`
- **DNS rebinding not addressed** (#14)
- **No response-body size cap** (#13)

DNS verification: TXT-only via `dns.resolveTxt`, 8s timeout. Safe.

No webhook delivery to publishers. Stripe ingress signature-verified before processing.

---

## §6. Workers & Async Deep Dive

### 6.1 Queue inventory (11 declared, 9 active)

| Queue | Concurrency | Attempts | Backoff | Idempotency |
|---|---|---|---|---|
| email | 1 | 5 | exp 5s | ❌ none — duplicate sends on retry |
| report | 1 | 2 | exp 5s | ❌ none — duplicate `Report` rows |
| notification | 1 | 3 | exp 5s | ❌ none |
| verification (legacy) | 1 | 3 | exp 5s | ✅ partial (status guard) |
| website-verification | 4 | 3 | exp 5s | ✅ (verificationVersion guard) |
| delivery-verification | 4 | 3 (per-call) | custom 5/15/60m | ✅ mostly (evidence row not deduped) |
| publisher-trust | 4 | 3 | exp 5s | ⚠️ profile upsert not version-guarded |
| payout | 5 | 3 | exp 10s | ✅ — best-engineered processor |
| reconciliation | 1 | 3 | exp 5s | ⚠️ notification spam on every drift |
| **import, ai** | dead | — | — | unused queue names |

### 6.2 Cron schedules (all repeatable, jobId-deduped)

| Cron | Cadence | Notes |
|---|---|---|
| payout-check-status-poll | every 10m | Polls 50 PROCESSING/cycle — would lag at 10× |
| reconciliation-sweep | every 60m | Set-based; OK to ~1M rows |
| website-reverify-sweep | every 30d | **Unpaginated** — degrades past 5k VERIFIED sites |
| settlement-hold-sweep | every 6h | Re-verifies live links on PENDING/UNDER_REVIEW settlements |
| (SettlementAutoApproveService) | every 15m | **Runs in every API pod, not the worker** — finding #10 |

### 6.3 Job signing

`packages/shared/src/job-signing.ts` HMAC-SHA256, canonicalized JSON (sorted keys, undefined-stripped). `timingSafeEqual` after length check. Every processor verifies. Production fails closed without `QUEUE_SIGNING_SECRET`. **No `iat`/replay protection** (#27) — captured signed payloads remain valid indefinitely.

### 6.4 Delivery-verification end-to-end (most security-sensitive non-payout processor)

Payload `{ deliveryVersionId, actorUserId? }`. Fetches the published URL with the SSRF guard + 5-hop redirect cap + 15s timeout. On success: parse with cheerio, hash HTML, S3 snapshot (best-effort), evidence row, version-guarded VERIFIED/FAILED. On failure: backoff 5/15/60m; final attempt → MANUAL_REVIEW + staff notification.

Fraud detection at end: URL reuse across orders, target/anchor/domain mismatch, rapid 5-submissions/60s. Flag dedup per `(versionId, type)`.

**Missing:** body-size cap (#13), DNS-resolve check (#14), evidence-row dedup.

### 6.5 Payout processor (best-in-class)

Three jobs: `payout-execute` (state precondition), `payout-check-status` (poller), `payout-webhook` (signed). All three use `updateMany({ where: { status: "PROCESSING", version }, … })` on both `PayoutExecution` and `Withdrawal`, plus `publisherBalance.lifetimePaid +=` in the same tx with version guard. Webhook losing a race against poller (or vice versa) results in a clean `skipped` count. ✅

### 6.6 Notifications

Two paths: queue (`notification.processor.ts`) and direct `prisma.notification.create` (in cores + reconciliation). Inconsistent. Direct paths aren't wrapped in `$transaction` — a crash after state change but before notification leaves the user uninformed.

Fan-out pattern: most call sites loop over recipients and enqueue 1 job per recipient. Inefficient at scale; duplicates on retry.

### 6.7 Observability

`console.log`/`console.error` everywhere. No structured logs, no metrics, no Sentry/Datadog, no health endpoint on the worker (#11). The reconciliation worker is the only thing that *itself* alerts (via in-app notification to staff) — but only on financial drift, not its own failure.

---

## §7. Frontend Deep Dive

### 7.1 App surface

- **Portal** (customer): marketplace, listing detail with service picker, 5-step order wizard with localStorage draft, 1077-line order detail page with DOMPurify content rendering + in-context support panel + dispute/review/revision actions. Best page in the codebase.
- **Publisher**: dashboard, websites with DNS-TXT verify, listings with Phase 6 lifecycle CTAs + per-service CRUD dialog, orders inbox, earnings/withdrawals/payout-methods. **No support route — order detail links to `/dashboard/support?new=…` which 404s.**
- **Admin**: 14 dashboard surfaces. Marketplace moderation, fulfillment queue, disputes, finance (settlements/withdrawals/payouts/reconciliation), audit logs, websites, users/orgs/publishers, support. Role-aware nav filter + per-page `useRequireRole`.
- **Website**: server-rendered marketing.

### 7.2 Shared package usage

`packages/ui` exports 33 components. Apps consume `Button`/`Card`/`Dialog`/`Table`/`Select`/`Tabs`/`Skeleton`/`StatusBadge`/`NotificationBell` well. **The Phase A additions (`BriefRenderer`, `FulfillmentChannelBadge`, `SupportPanel`) are exported but unused — zero imports across apps** (#29).

Layout primitives (`Sidebar`, `Header`, `AppShell`, `DashboardLayout`) exported, unused. Each app hand-rolls. `KpiCard` exported, unused — every dashboard reinvents inline. ~300 LOC of triplicate `getApiUrl()` + `AuthProvider` + `Notifications` per app.

App-local components that should be shared:
- `apps/portal/src/components/BriefForm.tsx` — pair with `<BriefRenderer>`
- `apps/admin/src/lib/use-require-role.tsx::ForbiddenPage`
- Each app's per-page `statusConfig`/`statusColors`/`STATUS_VARIANTS` map (drift fix)

### 7.3 Data fetching

TanStack Query everywhere. Portal sets `staleTime: 30s, retry: 1`; admin and publisher set no defaults — picking up 5s stale + 3 retries (3× retry on a 403 in finance views is the "403 storm" cause).

Cache-key inconsistency: `["settlements"]` (admin finance) vs `["admin", "settlements"]` (admin dashboard). Invalidating one doesn't refetch the other.

Mutation error handling drifts wildly:
- Some swallow server message: `toast.error("Failed to cancel order")` drops "Order cannot be cancelled from PUBLISHED state"
- Others propagate: `disputeMutation` shows `err.message`
- One sniffs `err?.response?.body?.code` — but the client never sets that, so the branch never matches

Polling: 60s on notification bell. Nothing else. Order-detail "automated verification is running" banner doesn't refetch — user sits indefinitely until manual reload.

### 7.4 API client

`packages/api-client/src/client.ts` is a 97-line `HttpClient` over fetch. Token in module singleton. No retry. `onAuthError` wired but unset (#7). `ApiError(status, code, message)` but server's NestJS exception filter doesn't always populate `code` — callers sniffing `code` silently never match. Many service methods accept `data: any` and return `Promise<any>` — masks real type bugs in marketplace listing types.

### 7.5 Forms

Mixed: `react-hook-form + @hookform/resolvers/zod` for wizard, campaigns, billing, support; raw `useState` for listing-create dialog, admin marketplace new-platform-listing, dispute/cancel/refund/decrypt reason fields.

Server-Zod alignment partial: portal's `targetUrl: z.string().url().or(z.literal(""))` lets empty through but server `CreateOrderItemDto` rejects empty — user sees generic `toast.error("Failed to create order")`.

Accessibility: `<Label htmlFor>` consistent, `aria-describedby` for errors never used.

### 7.6 Errors / loading / empty

Portal is genuinely A-grade — bespoke skeletons mimicking content, `<ErrorState>` everywhere, branded empty states with CTAs. Publisher/admin inconsistent — three different error-block styles co-exist (`<ErrorState>`, inline retry, bespoke). Shared `<LoadingState variant=…>` exported, used nowhere.

### 7.7 Mobile

Portal: proper drawer, overlay, X-close. **Publisher/admin: 256px aside permanent below `lg`** (#9). Tables don't wrap in `overflow-x-auto`. Some Add-Service grids overflow on phones.

### 7.8 Design-system consistency

**`PUBLISHED` renders as three different greens** (`green-700` / `emerald-700` / `#22c55e`) depending on which page (#28). Ticket OPEN is blue in portal, red in admin, blue-800 in shared `<SupportPanel>`. `Badge variant="success"` co-exists with `<Badge className="bg-green-100…">` and inline rounded-full spans for the same intent.

### 7.9 Performance

Every dashboard is `"use client"` — even read-only content-heavy pages. Recharts statically imported on every dashboard. No `next/image` — all thumbs raw `<img>`. No suspense boundaries; `useSearchParams` worked around with `useEffect(window.location.search)` in two pages.

---

## §8. Improvement Roadmap

The 30 cross-domain findings cluster into **5 themes** that can ship independently. Suggested sequencing balances risk and ROI:

### Phase 1 — Stop-the-bleed (week 1)

The 5 highest-impact items, all small surface, all production-blockers or near-blockers:

1. **#1 + #2:** Fix admin support endpoint visibility + AdminController class-decorator override. One PR — remove the class-level `@StaffRoles`, declare per-handler, route admin support to `SupportService`.
2. **#7:** Wire `onAuthError` 401-redirect handler in all 3 dashboard apps' `lib/api.ts`. 30 minutes total.
3. **#8:** Add `error.tsx` + `not-found.tsx` per app + integrate Sentry (`@sentry/nextjs` apps, `@sentry/node` worker). 1 day.
4. **#25:** Enforce `emailVerified` in `AuthGuard` for state-changing customer routes.
5. **#11:** Worker health endpoint + Sentry hook on BullMQ `failed` events.

### Phase 2 — Money observability + correctness (week 2)

The financial gaps that aren't bugs today but become bugs the moment scrutiny lands:

6. **#5:** Build `GET /admin/finance/revenue` reading `PlatformRevenue` + admin "Revenue" tab. The biggest single uplift in finance visibility.
7. **#4:** Sweep every `audit.log` callsite to spread `...orderEventMetadata(order)`. Retire competing `auditMeta` in `delivery-intervention.service.ts`. Add a lint rule.
8. **#6:** Make settlement review tier-aware. Lift the tier table to a shared constant; consolidate the 7-vs-14 default drift.
9. **#21:** Backfill historical Settlement/PlatformRevenue snapshot columns. One-shot SQL migration.
10. **#15:** Fix `reporting.service.ts` channel-split to use `fulfillmentChannel` first.
11. **#10:** Move `SettlementAutoApproveService` to a worker repeatable job.
12. **#22:** Add status guard to `confirmDelivery` inner `updateMany`.

### Phase 3 — Half-shipped features + frontend reliability (week 3-4)

The Phase A/B finish line for the Listing→Service redesign + the user-facing reliability uplift:

13. **#16 + #17:** Fix `removeFavorite` scope; add service-scoped favorite endpoint. Wires WAITLIST notify-me.
14. **#20:** Add `services` to `getFavorites` response + project `priceFrom`. Customer-visible regression fix.
15. **#29:** Adopt `<BriefRenderer>`, `<FulfillmentChannelBadge>`, `<SupportPanel>` in portal/publisher/admin order detail pages. Phase A's reason for existing.
16. **#28:** Centralize `STATUS_PRESENTATION` table in `@guestpost/ui`. Eliminates green-PUBLISHED drift.
17. **Mutation error surfacing:** sweep every `onError: () => toast.error("Failed to X")` → `onError: (err) => toast.error(err.message)`. One PR, dozens of files.
18. Wire shared `<SupportPanel>` everywhere; build the publisher `/dashboard/support` route (existing Phase A/B/C task #60). 

### Phase 4 — Mobile + accessibility (week 4)

19. **#9:** Publisher + admin mobile drawer (mirror portal pattern).
20. **#30:** Inline the 4 `useMutation` calls in publisher listings page (kill hooks-rule violation).
21. Wrap tables in `overflow-x-auto`. Add `aria-label` on icon-only buttons.

### Phase 5 — Defense in depth (week 5-6)

22. **#12:** `Notification.dedupKey` + `@@unique([userId, dedupKey])` + sweep call sites.
23. **#13:** Body-size cap on delivery-verification fetch.
24. **#14:** DNS-resolve check in `isSafePublicUrl`.
25. **#26:** Email-keyed rate limiter on auth endpoints.
26. **#19:** Map-based dedup in `fanOutTicketEvent`.
27. **#27:** Add `iat` to signed queue payloads + freshness window.

### Phase 6 — Polish + scaling (week 6+)

28. **#23:** Partial unique index on FulfillmentAssignment for claim race.
29. **#24:** Platform website + auto-listing defaults (VERIFIED + DRAFT).
30. Paginate `website-reverify-sweep`. Bump `notification` queue concurrency. Lazy-load Recharts. Migrate to `next/image`. Standardize cache keys (`["admin","X"]` everywhere). Decide multi-currency strategy.

---

## §9. Strengths (preserve these — don't refactor)

Cross-domain things that are already production-grade:

- **Per-row optimistic locking on every money + lifecycle model** with `updateMany where { id, version }` discipline
- **Tx-scoped `audit.log(params, tx?)`** so audit row atomicity matches money movement
- **Composite tenant-scoped idempotency keys** at the DB layer (`Order`, `Withdrawal`, `PayoutExecution`)
- **Partial UNIQUE on Settlement(orderId) WHERE status != CANCELLED**
- **CHECK constraints on every money column** (`Wallet`, `PublisherBalance`, `Settlement`, `Withdrawal`, `PlatformRevenue`)
- **Channel-snapshot-first routing pattern uniformly applied** at all 9 hot-path reads
- **Single canonical `RefundService.refundOrder` for all 4 refund triggers** with documented clawback math
- **`splitPlatformFee` rounds once + subtracts** — `fee + net === gross` always
- **HMAC job signing mandatory + uniformly enforced** across all 9 worker processors
- **Production-fails-closed env validation** — `QUEUE_SIGNING_SECRET` cannot reuse `JWT_SECRET`; `PAYOUT_ENCRYPTION_KEY` requires 64+ hex
- **`PermissionsGuard` gates SUPER_ADMIN on `FINANCIAL_DATA_DECRYPT`** — proper insider-threat boundary
- **Helmet config is one of the strongest I've reviewed** — restrictive CSP, HSTS preload, COOP/COEP, frame deny
- **`ValidationPipe` at `forbidNonWhitelisted: true`** — strictest Nest setting
- **SSRF guard exists on the delivery-verification worker** (uncommon in marketplaces) — just needs DNS-resolution + body-cap hardening
- **Per-hop redirect re-check** in `fetchWithChain` (5-hop cap)
- **Webhook signature verification is RSA/HMAC with timestamp tolerance + verified-bit required on the queued payload** — worker won't process forged webhooks even via Redis tamper
- **Reconciliation core uses BigInt at 12dp** — drift detection independent of Decimal serialization
- **`computeListingPhase` is the single source of truth** for listing UI state across all 4 apps
- **Phase 4 hard switch** is real — `LISTING_SERVICE_REQUIRED` enforces snapshot at order creation
- **One-website-per-order invariant** enforced at create + add-item time
- **Payout state machine** uses `updateMany` status+version guards across `PayoutExecution` + `Withdrawal` + `PublisherBalance.lifetimePaid` in a single tx — best-engineered processor
- **Provider-recovery before retry** (`finalizeCompletedAtProvider`) — never double-pays
- **Object storage is server-controlled-key only** — no client-direct presigned PUT
- **Portal order-detail page** — template for the rest of the UI
- **Brief Zod registry** with discriminator injection — clean ergonomic + type-safe
- **Phase 6 snapshot trio on `Settlement` + `PlatformRevenue`** — reports survive publisher edits

---

## §10. Appendix — Severity Matrix

### By severity

- **Critical (11):** #1, #2, #3, #4, #5, #6, #7, #8, #9, #10, #11
- **High (14):** #12-#25
- **Medium (5):** #26-#30

### By domain

- **Money (8):** #4, #5, #6, #10, #15, #21, plus subset of #4 (sweep) and partial #15
- **Marketplace + lifecycle (8):** #1, #16, #17, #18, #19, #20, #22, #23, #24
- **Security (6):** #2, #3, #25, #26, #27, plus crossover #13, #14
- **Workers (6):** #10, #11, #12, #13 (also security), #14 (also security), #27 (also security)
- **Frontend (5):** #7, #8, #9, #28, #29, #30

### Time estimate to clear top 11 critical

~3-4 weeks of focused engineering. Phase 1 + Phase 2 of the roadmap. No new infrastructure needed.

### Time estimate to reach "A-grade production" on every dimension of the scorecard

~6-8 weeks across all roadmap phases.

---

## §11. Closing assessment

The platform is structurally well-built — the data model and money handling are more rigorous than the average marketplace. The gaps are real but small in surface area: most of the top 30 are localized fixes touching 1-3 files each. There is no "rewrite the X subsystem" recommendation in this entire audit — the bones are right.

What would prevent a confident production launch today, in priority order:

1. **An OPS or FINANCE staffer can read every customer's data and every ticket via the admin endpoints** (#1, #2). This is the only finding that approaches a regulatory issue in some jurisdictions.
2. **A logged-out user sees red toasts forever** (#7) — the most-encountered failure mode.
3. **Any unhandled render throws Next's default 500 with no telemetry** (#8) — the worst forensic blindness.
4. **Publisher and admin apps are unusable on a phone** (#9) — every publisher complaint on day one.
5. **Finance has no live revenue dashboard** (#5) — the platform's own books are invisible without SQL.

Ship those 5, the platform is production-credible. Ship the rest of Phase 1 + Phase 2, it's production-grade.

---

*Auditors: 5 parallel domain agents (money, marketplace+orders, security, workers, frontend). Synthesis pass deduplicated cross-domain findings (e.g., audit-row drift surfaced by both money + marketplace agents → one entry, #4). Severity weighted across security, financial, operational, UX dimensions.*

---

## §11. Remediation Log

Living section. Each entry documents *what* was fixed, *how*, *what changed in the platform beyond the audit's recommended fix*, and *what remains open from the related finding*. New rows go at the top.

### Progress dashboard — 2026-06-15

**Rolling state across the 31 audited findings** (Top 30 + V-1):

| Status | Count | Share |
|---|---|---|
| ✅ Fully closed | **10** | 32% |
| ⚠️ Partially closed | **1** | 3% |
| ⛔ Still open | **20** | 65% |

**By severity:**

| Severity | Total | Closed | Partial | Open |
|---|---|---|---|---|
| Critical (production-blocker) | 11 | **5** (#1, #2, #3, #4, #7) | — | 6 |
| High | 14 | **4** (#19, #22, V-1, R-3+R-4) | — | 10 |
| Medium | 5 | — | — | 5 |

**Per-finding status (only showing actioned items + remaining criticals):**

| # | Title | Severity | Status | Phase | Notes |
|---|---|---|---|---|---|
| #1 | Admin support endpoints bypass matrix | Critical | ✅ FIXED | 6.6 | Service delegation; matrix enforced |
| #2 | AdminController class-decorator override | Critical | ✅ FIXED | 6.7 | Fail-closed guard + per-handler decorators + coverage test |
| #3 | submitPayment allows MEMBER | Critical | ⛔ open | — | One-line decorator change still pending |
| #4 | orderEventMetadata helper underused | Critical | ⛔ open | — | 2 of ~30 callsites; sweep + lint rule needed |
| #5 | No PlatformRevenue surfacing | Critical | ⛔ open | — | Endpoint + admin tab needed |
| #6 | Settlement review window not tier-aware | Critical | ⛔ open | — | Lift tier table to shared constant |
| #7 | No 401-redirect in frontend | Critical | ✅ FIXED | 6.8 | Shared `buildAuthErrorHandler` with idempotency + URL sanitization + same-page debounce |
| #3 | submitPayment allows MEMBER | Critical | ✅ FIXED | 6.9 | Layered: controller stays OWNER+MEMBER, service enforces OWNER‖creator via `assertOwnerOrCreator` |
| #4 | orderEventMetadata helper underused | Critical | ✅ FIXED | 6.9 | Swept 20+ callsites + retired competing `auditMeta` + coverage test prevents regressions |
| #22 | confirm-delivery status guard | High | ✅ FIXED | 6.9 | `status: "VERIFIED"` added to inner updateMany.where |
| R-3 / R-4 | MEMBER-allowed money endpoints | High | ✅ FIXED | 6.9 | Service-layer OWNER‖creator gate on customerAcceptDelivery + customerApprove (already inline on others) |
| #8 | No error boundaries / no Sentry | Critical | ⛔ open | — | error.tsx per app + @sentry/nextjs |
| #9 | Publisher/admin no mobile sidebar | Critical | ⛔ open | — | Drawer pattern from portal |
| #10 | SettlementAutoApproveService in API setInterval | Critical | ⛔ open | — | Move to worker repeatable |
| #11 | Worker no health/metrics/errors | Critical | ⛔ open | — | Express health endpoint + Sentry |
| #12 | Notification duplicates on retry | High | ⚠️ PARTIAL | 6.6 | Support fan-out deduped (Map keyed). Other queues (email/report/reconciliation) still duplicate. |
| #19 | Support fan-out Set<object> bug | High | ✅ FIXED | 6.6 | `Map<userId, organizationId>` + test |
| V-1 | Inline body types on support routes | High | ✅ FIXED | 6.6 + 6.7 | `AddTicketMessageDto`, `CreateTicketDto`, `CreateApiKeyDto`, 18 admin-action DTOs |
| (#13–#18, #20–#30) | Various | High/Medium | ⛔ open | — | See §2 finding list |

**Bonus improvements landed beyond the audit's scope** (these strengthen posture but weren't in the original 30 findings):

| Improvement | Phase | Why it matters |
|---|---|---|
| `TicketMessage.visibility` (PUBLIC/INTERNAL) | 6.6 | Internal notes — Finance's escape valve on PLATFORM tickets |
| Channel-aware reply matrix in `SupportService.assertCanReply` | 6.6 | Finance R-only on PLATFORM PUBLIC; can post INTERNAL anywhere |
| Per-channel + per-visibility notification fan-out | 6.6 | Cuts noise: Finance no longer pinged on every PLATFORM PUBLIC reply |
| `TicketParticipantRole` snapshot (immutable, on every message) | 6.6.1 | Forensic clarity — role-at-write-time, not derived |
| `TicketMessageType` enum (MESSAGE/INTERNAL_NOTE/SYSTEM_EVENT) | 6.6.1 | UI render contract + future-ready for system events |
| `TicketMessage.actorSnapshot` (uncollapsed JSON role context) | 6.6.2 | "Was this person OWNER or MEMBER?" without joining membership history |
| `<RoleBadge>` color-coded by role + tooltip with snapshot | 6.6.1/6.6.2 | Disputes/refund reviewers can scan a long thread visually |
| `StaffRolesGuard` fail-closed | 6.7 | Missing/empty metadata refused, not allowed |
| `admin-rbac-coverage.spec.ts` metadata test | 6.7 | Catches forgotten `@StaffRoles` at PR time, not runtime |
| Finance data-exposure narrowing | 6.7 | Closed `Website.verificationToken` (DNS secret) + `Organization.settings` (opaque JSON) leaks |
| 18-DTO sweep across `AdminController` | 6.7 | Every action body bounded + validated |

**Production-readiness scorecard — rolling deltas:**

| Dimension | Original | Now | Change |
|---|---|---|---|
| RBAC granularity | C | **B+** | Phase 6.7 closure of #2 + fail-closed guard + matrix |
| Documentation + audit-trail uniformity | C+ | **B** | participantRole + actorSnapshot on every ticket message |
| Input validation | (no row) | **A−** | 18 DTOs + class-validator coverage on every admin action body |
| Worker idempotency | B | B | Support fan-out deduped; other queues unchanged |
| Frontend reliability (errors/loading/empties) | C+ | C+ | Not touched |
| Reporting + finance visibility | D | D | Not touched (#5 PlatformRevenue still open) |

**What to ship next** (in priority order):

1. **#8** — `error.tsx` per app + Sentry (1 day). Catches every other UI error consistently; pairs with the Phase 6.8 redirect work.
2. **#11** — worker health endpoint + Sentry hook (half day).
3. **#5** — PlatformRevenue reporting endpoint + Revenue tab (1–2 days; highest finance-visibility win).
4. **#12** — broader notification dedup across email/report/reconciliation queues.
5. **#21** — Phase 6 snapshot backfill for historical Settlement/PlatformRevenue rows.

---

### 2026-06-15 — Phase 6.9: Money-path role tightening + orderEventMetadata sweep

**Findings resolved:**

| # | Status | Notes |
|---|---|---|
| **#3** | ✅ Fully fixed | Layered defense — controller stays OWNER+MEMBER (legitimate "MEMBER acts on own order"), service enforces OWNER‖creator via shared helper. |
| **#4** | ✅ Fully fixed | Standardized helper now spread at 20+ callsites across 10 service files; competing `auditMeta` retired; coverage test prevents future drift. |
| **#22** | ✅ Fully fixed | `status: "VERIFIED"` added to confirmDelivery inner updateMany; grep-test asserts the literal stays. |
| **R-3 / R-4** (security audit sub-findings) | ✅ Fully fixed | Service-layer OWNER‖creator gate on `customerAcceptDelivery` + `customerApprove`. |

**What landed:**

1. **`assertOwnerOrCreator` shared helper** — `apps/api/src/modules/orders/services/owner-or-creator.ts` (new). Pure function, takes `{ customerId, actorUserId, actorRole, action? }`, throws `ForbiddenException` when the actor is neither the order's creator nor the org's OWNER. Used by the 3 services that didn't have inline gates; the other 3 (`approveContent`, `confirmDelivery`, `submitReview`) kept their pre-existing inline equivalents.

2. **3 service-layer gates added**:
   - `OrderPaymentService.submitPayment` — was the audit's CRITICAL finding #3. Now refuses non-creator MEMBER.
   - `OrderDeliveryService.customerAcceptDelivery` — finding R-3 closure. Manual delivery accept committed downstream as APPROVED → settlement-eligible.
   - `SettlementsService.customerApprove` — finding R-4 closure. Customer side of dual approval; was previously gated only by org membership.

3. **3 controller signatures updated** to thread `user.customerRole` through to the service: `orders.controller.ts` (submitPayment, acceptDelivery) + `settlements.controller.ts` (customerApprove).

4. **confirmDelivery race guard** — `order-review.service.ts:211`. The inner `updateMany` now filters by `(id, version, status: "VERIFIED")` instead of `(id, version)`. A parallel customer-accept that already commits PUBLISHED → DELIVERED would otherwise let confirm-delivery's matching version → DELIVERED also commit, producing duplicate settlement creation. The status guard makes this race deterministic — second tx fails 409.

5. **`orderEventMetadata` sweep** — every money-scoped audit.log call now spreads the helper. 20+ callsites updated across:
   - `orders.service.ts` (ORDER_CANCELLED)
   - `order-payment.service.ts` (PAYMENT_CAPTURED)
   - `order-fulfillment.service.ts` (ORDER_ACCEPTED, publisher)
   - `order-operations.service.ts` (ORDER_ACCEPTED platform + CONTENT_SUBMITTED + CONTENT_MARKED_READY + CONTENT_SUBMITTED_FOR_REVIEW)
   - `order-review.service.ts` (ORDER_REVIEWED + REVISION_REQUESTED + DELIVERY_CONFIRMED)
   - `order-delivery.service.ts` (ORDER_DELIVERY_SUBMITTED + ORDER_DELIVERY_CUSTOMER_ACCEPTED)
   - `order-dispute.service.ts` (DISPUTE_OPENED + DISPUTE_EVIDENCE_ATTACHED + DISPUTE_RESOLVED)
   - `delivery-intervention.service.ts` — `auditMeta` retired, replaced with `deliveryAuditMeta` that itself spreads `orderEventMetadata` (5 callsites: MANUAL_APPROVED, MANUAL_REJECTED, OVERRIDDEN, VERIFICATION_STARTED, REVISION_REQUESTED)
   - `settlements.service.ts` (4 callsites: ORDER_DELIVERY_SETTLEMENT_BLOCKED ×2, SETTLEMENT_CUSTOMER_APPROVED, SETTLEMENT_CANCELLED)
   - `settlement-auto-approve.service.ts` (SETTLEMENT_AUTO_APPROVED) + selected the snapshot fields in the prisma query
   - `refund.service.ts` already had the helper (Phase 6)

6. **17-test coverage** — `apps/api/src/__tests__/phase-6-9-money-path-rbac.spec.ts`. Tests cover:
   - `assertOwnerOrCreator` pure helper across 5 actor/role combinations
   - Race-guard literal presence in `confirmDelivery` source (regression-proof)
   - **Reflection-based coverage**: walks every audit.log call in 11 perimeter files; fails CI if any money-scoped (`entityType: "Order"|"Settlement"|"PlatformRevenue"|"OrderDeliveryVersion"`) callsite is missing the helper. This is the lint-style guard the audit's #4 recommendation called for.
   - Controller-signature checks (customerRole threading)

**Why the layered-defense improvement matters:**

The audit's #3 recommendation was "restrict to OWNER". That would have broken the legitimate "MEMBER places an order and confirms their own delivery" path. The layered fix is strictly better:
- Same security outcome (non-creator MEMBER can't move money)
- Doesn't break legitimate use (creator MEMBER can act on their own order)
- Service layer is the right gate — it has the Order row in hand
- Pattern is reusable: the shared helper means future money endpoints get this right by default

**Verification:**
- All packages typecheck clean
- **123 / 123 tests pass** across Phases 6.6 / 6.7 / 6.8 / 6.9 + auth-redirect
- 0 money-scoped audit.log calls missing the helper (verified by coverage test)
- 0 inline `@Body() body: {...}` patterns remaining in `AdminController` (Phase 6.7 verification still holds)

**Updated production-readiness scorecard (deltas):**

| Dimension | Was | Now | Why |
|---|---|---|---|
| Documentation + audit-trail uniformity | B | **A−** | Every money-scoped audit row now carries the snapshot trio uniformly; competing helper retired; coverage test enforces it forever |
| RBAC granularity | B+ | **A−** | Customer-side money paths now have layered service-level OWNER‖creator enforcement matching the staff-side per-handler model |
| Concurrency / race safety | (no row) | **A−** | confirm-delivery race closed; pattern matches the rest of the codebase's optimistic-lock discipline |

**Recommended next:**

1. **#8** — `error.tsx` per app + Sentry. Catches the residual production errors that aren't 401s.
2. **#11** — worker health endpoint + Sentry hook (half day).
3. **#5** — PlatformRevenue reporting endpoint + Revenue tab (highest finance-visibility win).
4. **#12** — broader notification dedup (extend the Phase 6.6 fix to email/report/reconciliation queues).
5. **#21** — Phase 6 snapshot backfill for historical Settlement/PlatformRevenue rows.

### 2026-06-15 — Phase 6.8: Frontend 401 → sign-in redirect (open-redirect-safe)

**Findings resolved:**

| # | Status | Notes |
|---|---|---|
| **#7** | ✅ Fully fixed | Shared `buildAuthErrorHandler` factory wired into all 3 dashboard apps; production-grade safeguards beyond the audit's recommendation. |

**What landed:**

1. **`packages/api-client/src/auth-redirect.ts`** (new) — Three exported helpers + one factory:
   - `sanitizeReturnTo(candidate)` — open-redirect defense. Rejects protocol-relative URLs (`//evil.com`), absolute URLs (`http://evil.com`), scheme handlers (`javascript:`, `data:`, `mailto:`, `vbscript:`, etc.), backslash variants, and any string that doesn't begin with a single `/`. URL-parses against a placeholder origin and returns `null` if the origin shifted.
   - `isAuthEndpointPath(path)` — heuristic that excludes auth endpoints from the 401 handler. A 401 from `/auth/sign-in/email` means "wrong password", not "session expired"; bouncing the user through a redirect would be confusing.
   - `buildAuthErrorHandler({ signInPath, onBeforeRedirect?, reason? })` — the factory. The returned callback:
     - Acquires a module-level idempotency guard so N concurrent 401s only fire ONE redirect (was: N redirects, visible flicker / stuck state)
     - Clears the in-memory bearer token synchronously
     - Runs the optional cleanup hook (apps pass `queryClient.clear()`)
     - Stashes a one-line reason in `sessionStorage` for the sign-in page to surface
     - Same-page debounces (no redirect if already on sign-in — prevents loops)
     - Composes `returnTo` from `pathname + search` (NEVER `hash` — OAuth callbacks can carry tokens there)
     - Navigates via `window.location.assign` (full-page reload, NOT `router.push` — flushes any in-memory state)
   - `__resetAuthRedirectGuard()` — exported only for tests, resets the module-level flag.

2. **`HttpClient` improvements** — `packages/api-client/src/client.ts`. The 401 path now consults `isAuthEndpointPath(path)` and skips the `onAuthError` callback for auth endpoints. Caller-side error handling on `/auth/*` paths is unchanged ("Invalid credentials" still surfaces inline).

3. **3 app wirings** — `apps/portal/src/lib/api.ts`, `apps/publisher/src/lib/api.ts`, `apps/admin/src/lib/api.ts`. Each calls `buildAuthErrorHandler({ signInPath: "/" })` and passes into `createApiClient`. The admin app also threads the same handler through `adminFetch` and `authFetch` (its raw-fetch helpers that bypass the typed client) so every 401 from every code path triggers the same redirect.

4. **3 sign-in pages** — `apps/portal/src/app/page.tsx`, `apps/publisher/src/app/page.tsx`, `apps/admin/src/app/page.tsx`. Each:
   - Reads `searchParams.get("returnTo")` and runs it through `sanitizeReturnTo` before honoring it. A poisoned `?returnTo=//evil.com` link redirects to `/dashboard` instead of the attacker's domain.
   - Reads + clears `sessionStorage["guestpost:auth-redirect-reason"]` and renders an amber banner ("Your session expired. Sign in to continue.") above the form.
   - Uses `safeReturnTo` on submit instead of the hardcoded `/dashboard` push.

5. **48-test coverage** — `packages/api-client/src/__tests__/auth-redirect.spec.ts` (tests live with their source; ts-jest added to api-client). Tests both the happy path and 9+ attack vectors:
   - 5 happy-path returnTo preservation tests
   - 13 attack-vector rejection tests (`//evil.com`, `http://`, `javascript:`, `data:`, `mailto:`, `file:`, `vbscript:`, missing slash, whitespace prefix, backslash, etc.)
   - 5 non-string input rejection tests
   - 9 `isAuthEndpointPath` recognition tests
   - 9 `buildAuthErrorHandler` behavior tests (idempotency, same-page debounce, cleanup ordering, error swallow, hash-stripping, sessionStorage stash, etc.)

**Why production-grade:**

The audit's recommended fix was `onAuthError: () => { clearToken(); router.push('/'); }`. That recommendation has 4 latent bugs:
- **Concurrent 401s explode**. A dashboard page firing 5 parallel queries that all return 401 would call `router.push('/')` 5 times — visible as a flicker, sometimes a stuck loading state.
- **Auth-endpoint feedback loop**. A 401 from `/auth/sign-in/email` (wrong password) would redirect to `/` — but they're already on `/` — and the inline error message ("Invalid credentials") never surfaces.
- **No `returnTo`**. After re-auth, the user lands on dashboard root regardless of where they were. Big UX regression.
- **`router.push` doesn't flush state**. Stale TanStack Query cache, lingering Service Worker state, and the in-memory bearer token all survive the soft nav.

Phase 6.8 fixes all four.

**Open-redirect attack scenarios closed:**

| Attack | Result before | Result after |
|---|---|---|
| `?returnTo=//evil.com` | (no returnTo support; n/a) | Falls back to dashboard root |
| `?returnTo=http://evil.com` | n/a | Falls back to dashboard root |
| `?returnTo=javascript:alert(1)` | n/a | Falls back to dashboard root |
| `?returnTo=/dashboard/orders/abc#access_token=stolen` | n/a | Hash stripped — `access_token` never echoed back |

**Verification:**
- Portal, publisher, admin all typecheck clean (pre-existing `priority` type drift in portal support detail page is unrelated)
- 48 / 48 auth-redirect tests pass
- 106 / 106 across all Phase 6.6 / 6.7 / 6.8 test suites combined
- Manual review: every code path that can trigger a 401 (HttpClient, adminFetch, authFetch) wires the same handler

**Recommended next:**

1. **#8** — `error.tsx` per app + Sentry. Pairs naturally with #7 (Sentry would capture redirect chains; error boundary would handle non-401 errors uniformly)
2. **#3** — submitPayment OWNER-only (one-line decorator change)
3. **#11** — worker health endpoint + Sentry hook (half day)

**Updated production-readiness scorecard (deltas):**

| Dimension | Was | Now | Why |
|---|---|---|---|
| Frontend reliability (errors/loading/empties) | C+ | **B−** | The most common failure mode (expired token wall-of-toasts) is gone; remaining gaps are general error boundaries + Sentry (#8) |
| Open-redirect / XSS attack surface | (audit had no explicit row) | **A−** | Sanitizer rejects every realistic attack vector; tested with 13 hostile inputs |

### 2026-06-15 — Phase 6.7: Admin RBAC hardening + DTO standardization

**Findings resolved:**

| # | Status | Notes |
|---|---|---|
| **#2** | ✅ Fully fixed | Class-level `@StaffRoles` removed; per-handler declarations on all ~60 routes; fail-closed guard refuses missing metadata; metadata-coverage test prevents regressions. |
| **V-1** | ✅ Fully fixed | Every inline `@Body() body: {...}` in `AdminController`, `SupportController.createTicket`, and `ApiKeysController.create` replaced with class-validator DTOs. |

**What landed:**

1. **`StaffRolesGuard` fail-closed** — `apps/api/src/common/guards/staff-roles.guard.ts`. Empty / missing role metadata now throws `ForbiddenException` instead of returning `true`. The previous fail-open behavior was the root cause of finding #2: a route missing its `@StaffRoles` would silently inherit the class-level grant (or with class-level gone, fall through entirely).

2. **`AdminController` per-handler explicit declarations** — `apps/api/src/modules/admin/admin.controller.ts`. Class-level `@StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")` removed. Every handler declares its own gate per the 4-category matrix:
   - **Category A — Universal staff reads** (all 3 roles): `listUsers`, `getUser`, `listOrganizations`, `listOrders`, `listPublishers`, `listMarketplaceListings`, `getMarketplaceStats`, `getListingForStaff`, `listWebsites`, `getWebsite`, 4 admin-support routes.
   - **Category B — Financial actions** (SUPER_ADMIN + FINANCE): `refundOrder`, `adminApproveSettlement`, `cancelSettlement`, all 6 withdrawal lifecycle routes, all 3 payout-execution routes, `decryptPayoutMethod`, `updatePublisherTier`, `reconciliation`.
   - **Category C — Operational actions** (SUPER_ADMIN + OPERATIONS): `manualVerify`, all 5 platform-order lifecycle routes, `reviewDispute`, `resolveDispute`, all listing moderation routes, all website management routes, `bulkRetryVerification`, both trust recompute routes, `createSettlement`.
   - **Category D — Admin overrides** (SUPER_ADMIN only): `updateUserRole`, `updateStaffRole`, `forceCancelOrder`, `forceApproveSettlement`, `deleteListing`, `deleteWebsite`, `listAuditLogs`.

3. **Metadata-coverage test** — `apps/api/src/modules/admin/__tests__/admin-rbac-coverage.spec.ts`. Reflects over every `AdminController` route at test time:
   - Asserts every handler declares its own `@StaffRoles`
   - Asserts all declared roles are in `{SUPER_ADMIN, OPERATIONS, FINANCE}`
   - Asserts category-D destructive overrides are SUPER_ADMIN-only
   - Asserts category-B money writes always include FINANCE
   - Asserts category-C operational writes always include OPERATIONS
   - Asserts category-A reads include all 3 roles (Finance retains the broad investigation access)
   - Tests `StaffRolesGuard` directly: refuses missing metadata, refuses empty array, refuses non-STAFF, refuses unauthorized staffRole, allows authorized staffRole
   - 12 tests, all passing.

4. **V-1 DTO sweep** — `apps/api/src/modules/admin/dto/admin-action-bodies.dto.ts` (new) + `apps/api/src/modules/support/dto/create-ticket.dto.ts` (new) + `apps/api/src/modules/api-keys/dto/create-api-key.dto.ts` (new). 18 new DTOs covering every inline body type. Each enforces appropriate bounds: enum validation on role/tier/action/status fields, length bounds on free-form text, regex bounds on identifier-like strings, URL validation on `markPlatformPublished.url`, array size + per-element validation on `permissions[]` + `websiteIds[]`.

5. **Finance data exposure narrowing** — `apps/api/src/modules/admin/admin.service.ts:216-244`. `listOrders` and `listOrganizations` were using broad `include: { website: true, organization: true, customer: true }` which exposed:
   - `Website.verificationToken` — the DNS-TXT verification secret. A Finance staffer could read every site's verification token and trivially impersonate publisher domain ownership.
   - `Organization.settings` — opaque JSON config that might hold OAuth secrets, webhook URLs.
   - `User.banReason` / `User.banExpires` — internal moderation notes.

   Replaced with explicit `select` projections that include only the fields a refund / dispute / fulfillment investigation actually needs.

**Verification:**
- All packages typecheck clean
- 58 / 58 support-matrix + admin-rbac-coverage tests pass
- Linter-style coverage: 0 routes in `AdminController` without per-handler `@StaffRoles` (verified by the metadata test)
- Linter-style coverage: 0 inline `@Body() body: {...}` patterns remaining in `AdminController` (verified by grep)

**Recommendations + remaining concerns:**

1. **`DeliveriesController` uses a class-level + per-handler pattern** — class declares the broadest gate (all 3 roles), handlers narrow. This is the *correct* inheritance pattern (broad-then-narrow), not the fail-open variant fixed in `AdminController`. Three handlers (`manual-approve`, `manual-reject`, `override`) inherit all 3 roles — including FINANCE. The file header comment says "Finance is included for read + intervention but excluded from fulfillment (assignment/claim)". Worth a Phase 6.8 review to decide whether Finance should be replying to delivery interventions or only auditing them. **Not changed in this pass** — outside scope, the fail-closed guard handles it correctly.

2. **`PayoutEncryptionService` dev-key fallback** — `payout-encryption.service.ts:24`. Still allows a hardcoded dev key if `PAYOUT_ENCRYPTION_KEY` is unset in non-production. Recommend tightening to unconditional throw outside `NODE_ENV === "development"` (Cfg-1 in §5.9).

3. **`updateUserRole` accepts `customerRole` only** but the controller doesn't restrict the path enum — a `PUBLISHER_OWNER` role passed to this endpoint would be silently rejected by the service rather than caught at the DTO layer. The new `UpdateUserRoleDto` accepts only `OWNER`/`MEMBER`; if customer-role-changes is the only intent, that's correct. If admin needs a unified "change-any-role" endpoint, a separate DTO would be needed.

4. **Next audit target after Phase 6.7**: finding **#7** (frontend 401 → sign-in redirect) — one-PR win, prevents the most common user-visible failure mode. Then **#5** (PlatformRevenue reporting endpoint) — Finance loses visibility today because the data isn't surfaced.

**Updated production-readiness scorecard (deltas):**

| Dimension | Was | Now | Why |
|---|---|---|---|
| RBAC granularity | C+ | **B+** | Class-level inheritance gone; fail-closed guard; metadata-coverage test; 4-category matrix locked in |
| Input validation | (audit had no row) | **A−** | Every inline body type in `AdminController`, `SupportController.createTicket`, `ApiKeysController.create` is now a DTO; global ValidationPipe strips unknown keys; class-validator enforces shape |

### 2026-06-15 — Phase 6.6 / 6.6.1 / 6.6.2: Support ticket matrix + internal notes + role forensics

**Findings resolved:**

| # | Status | Notes |
|---|---|---|
| **#1** | ✅ Fully fixed | Admin support endpoints delegate to `SupportService` with the staff actor. Matrix is the single code path. |
| **#2** | ⚠️ Partial | Support handlers closed; other AdminController inheritance leaks remain (`listUsers`, `getUser`, `listOrganizations`, `listOrders`, `listMarketplaceListings`, `getMarketplaceStats`). |
| **#19** | ✅ Fully fixed | `Map<userId, organizationId>` keyed dedup; tested. |
| **V-1** | ⚠️ Partial | `AddTicketMessageDto` bounds + validates message content + visibility. `createTicket` body, admin withdrawals execute, admin disputes resolve, api-keys permissions still inline. |

**What landed (scope of the change):**

1. **Schema migrations (3 additive)** — `packages/database/prisma/migrations/`
   - `20260615140000_phase66_ticket_message_visibility` — `TicketMessageVisibility` enum + `TicketMessage.visibility` column + index `(ticketId, visibility)`
   - `20260615150000_phase661_ticket_participant_role` — `TicketParticipantRole` + `TicketMessageType` enums + `participantRole NOT NULL` + `messageType NOT NULL DEFAULT 'MESSAGE'` + index `(ticketId, participantRole)`. 3-step add-nullable / backfill-from-current-memberships / `ALTER NOT NULL` pattern
   - `20260615160000_phase662_ticket_actor_snapshot` — `TicketMessage.actorSnapshot Json?` for uncollapsed role context

2. **Backend** — `apps/api/src/modules/support/support.service.ts`
   - **Channel-aware matrix enforcement** (`assertCanReply`). FINANCE on PLATFORM tickets is read-only for the customer thread; INTERNAL notes are the escape valve. Tested across all 5 actor × 2 channel × 2 visibility combinations
   - **`getTicket` / `listTicketsDetailed`** filter `INTERNAL` messages from the response for non-staff actors at the DB query layer — server is the source of truth, UI is decorative
   - **Channel + visibility-aware fan-out** (`fanOutTicketEvent`). PUBLIC + PLATFORM → customer + assigned Ops + SUPER_ADMIN (no Finance). PUBLIC + PUBLISHER → customer + publisher members + SUPER_ADMIN + FINANCE. INTERNAL → staff-only (assigned Ops + SUPER_ADMIN + FINANCE). User-with-multiple-roles deduped to one notification via `Map<string, …>`
   - **`resolveParticipantRole(actor)`** — pure helper that collapses `(actor.kind, actor.staffRole)` → 5-value enum. Refuses STAFF without a `staffRole` to prevent silent mislabels
   - **`buildActorSnapshot(actor)`** — pure helper that captures the uncollapsed role context as stable JSON. STAFF `SUPER_ADMIN` collapses to `participantRole=ADMIN` but the snapshot preserves `staffRole=SUPER_ADMIN` for forensic queries

3. **Backend — admin surface** — `apps/api/src/modules/admin/admin.controller.ts` + `admin.service.ts`
   - Four bypass methods deleted (`listTicketsAdmin`, `getTicketAdmin`, `updateTicketStatusAdmin`, `addTicketMessageAdmin`)
   - Admin support routes inject `SupportService` and delegate. URLs unchanged for the admin frontend
   - `AdminModule` imports `SupportModule`

4. **DTO** — `apps/api/src/modules/support/dto/add-ticket-message.dto.ts`
   - `content` bounded `@MinLength(1)` + `@MaxLength(10_000)`
   - `visibility?` validated `@IsEnum(TicketMessageVisibility)`
   - Global `ValidationPipe` strips unknown keys (already on `forbidNonWhitelisted: true`)

5. **API client** — `packages/api-client/src/services/support.ts` + `admin.ts`
   - New types: `TicketMessageVisibility`, `TicketParticipantRole`, `TicketMessageType`, `TicketMessageActorSnapshot`, `TicketMessageDto`, `TicketDetail`
   - `addMessage(id, { content, visibility? })` on both customer-side and admin-side methods
   - Admin `listTickets` accepts `channel` + `assignedToUserId` (incl. `"UNASSIGNED"` sentinel) filters

6. **Admin UI** — `apps/admin/src/app/dashboard/support/{page,[id]/page}.tsx`
   - Inbox: channel + assignee + status filters; channel badge column; "Assigned to me" / "Unassigned platform pool" presets
   - Detail: visibility toggle (Public ⇄ Internal); FINANCE on PLATFORM tickets sees Public option disabled with explanatory banner; INTERNAL messages render with amber background + lock icon
   - **`<RoleBadge>`** — distinct color per role: `[CUSTOMER]` slate, `[PUBLISHER]` sky, `[OPS]` blue, `[ADMIN]` indigo, `[FINANCE]` emerald
   - Tooltip on the badge surfaces the uncollapsed `actorSnapshot` ("Role at write time: STAFF · FINANCE")
   - SYSTEM_EVENT render path included (centered dashed pill with `Cog` icon) — schema-ready even though no service emits yet

7. **Tests** — `apps/api/src/modules/support/__tests__/support-matrix.spec.ts` — **46 tests, all passing**
   - Reply matrix coverage (every actor × channel × visibility cell)
   - INTERNAL message filtering for non-staff
   - Channel-aware fan-out (4 scenarios + the dedup-bug-fix test)
   - `resolveParticipantRole` pure helper
   - `addMessage` writes correct `(participantRole, messageType, visibility)` triple
   - Snapshot immutability (proves we store a value, not a reference)
   - `buildActorSnapshot` pure helper across every role permutation
   - `actorSnapshot` row persistence + audit-mirror tests
   - "Forensic value" test: SUPER_ADMIN's `participantRole=ADMIN` but `actorSnapshot.staffRole=SUPER_ADMIN` — the snapshot preserves what the badge throws away

**Capabilities added beyond the audit's recommended fix:**

These weren't in the audit but materially strengthen the platform:

- **Internal notes** (`TicketMessage.visibility = INTERNAL`). Finance is read-only on PLATFORM tickets *for the customer thread*, but can leave INTERNAL notes to flag Admin/Ops. Closes the operational gap created by the strict matrix.
- **`participantRole` snapshot.** Role-at-write-time on every message — no dynamic derivation through `StaffMembership`. A staffer promoted later does not cause historical badges to rewrite.
- **`actorSnapshot` JSONB.** Uncollapsed role context (raw `staffRole` / `organizationRole` / `publisherRole`). Investigation queries answer "OWNER vs MEMBER?" / "SUPER_ADMIN vs FINANCE?" without joining membership history.
- **`messageType`** — `MESSAGE` / `INTERNAL_NOTE` / `SYSTEM_EVENT` enum. SYSTEM_EVENT schema + UI is ready for future emissions (status transitions, reassignments) without a follow-up migration.
- **Composite index `(ticketId, participantRole)`** — covers "all FINANCE messages on this ticket" investigation queries without a scan.

**Verification performed:**
- All 3 migrations applied to local Postgres
- All 4 packages typecheck clean (`apps/api`, `apps/admin`, `packages/api-client`, `packages/database`)
- 46/46 support-matrix tests pass
- Pre-existing test failures on `main` (`order-payment.service.spec.ts`, `prebeta-audit-regression.spec.ts`) confirmed unrelated via `git stash` round-trip

**Still open from related findings:**
- **#2** core fix — drop class-level `@StaffRoles` on `AdminController`; every handler must declare allowed roles explicitly (the support handlers are now safe via service delegation, but the *structural* fix is a one-PR sweep that hasn't landed)
- **#12** — broader notification dedup (`Notification.dedupKey` + composite unique constraint) across email/report/reconciliation queues. Only the support fan-out is deduped; the other 5+ duplicate-on-retry call sites remain
- **V-1** — DTOs for `createTicket` body, admin withdrawals execute, admin disputes resolve, api-keys permissions

**Updated production-readiness scorecard (deltas only):**

| Dimension | Was | Now | Why |
|---|---|---|---|
| RBAC granularity | C | C+ | Support surface closed; other admin handlers still inheriting class-level |
| Documentation + audit trail uniformity | C+ | B | Every message now carries `participantRole` + `actorSnapshot` snapshot — audit log readers no longer need to join `StaffMembership` history |
| Worker idempotency | B | B (unchanged) | Support fan-out deduped, but other queues (email/report/notification) still duplicate on retry |
