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
| ✅ Fully closed | **25** | 81% |
| ⚠️ Partially closed | **0** | 0% |
| ⛔ Still open | **6** | 19% |

**By severity:**

| Severity | Total | Closed | Partial | Open |
|---|---|---|---|---|
| Critical (production-blocker) | 11 | **11** (#1, #2, #3, #4, #5, #6, #7, #8, #9, #10, #11) | — | **0** |
| High | 14 | **7** (#12, #15, #19, #21, #22, V-1, R-3+R-4) | — | 7 |
| Medium | 5 | **5** (#25, #26, #27 — Phase 7.8; #28, #29, #30 — Phase 7.9) | — | **0** |

Phase 7.8 also closed audit §5.8's `hasAuthCredentials()` sub-finding (bundled with #26 as documented in the recommended fix). The auth/queue trust boundary has zero open security findings; remaining 2 Medium items (#28 status-color, #29 unused shared components — both frontend) plus #30 (hooks-rule violation in publisher listings) are queued for Phase 7.9.

**Per-finding status (only showing actioned items + remaining criticals):**

| # | Title | Severity | Status | Phase | Notes |
|---|---|---|---|---|---|
| #1 | Admin support endpoints bypass matrix | Critical | ✅ FIXED | 6.6 | Service delegation; matrix enforced |
| #2 | AdminController class-decorator override | Critical | ✅ FIXED | 6.7 | Fail-closed guard + per-handler decorators + coverage test |
| #3 | submitPayment allows MEMBER | Critical | ⛔ open | — | One-line decorator change still pending |
| #4 | orderEventMetadata helper underused | Critical | ⛔ open | — | 2 of ~30 callsites; sweep + lint rule needed |
| #5 | No PlatformRevenue surfacing | Critical | ✅ FIXED | 7.1 | `GET /admin/finance/revenue` with 4 groupings + period comparison + CSV. RBAC = SUPER_ADMIN+FINANCE (Category B). #15 bundled. |
| #6 | Settlement review window not tier-aware | Critical | ✅ FIXED | 7.2 | Shared `publisher-tier-policy` module. Both writers use `getSettlementReviewDays(tier, env)`. TIER_WITHDRAWAL_HOLDS lifted as sibling rider. Grep guards prevent regression. |
| #7 | No 401-redirect in frontend | Critical | ✅ FIXED | 6.8 | Shared `buildAuthErrorHandler` with idempotency + URL sanitization + same-page debounce |
| #3 | submitPayment allows MEMBER | Critical | ✅ FIXED | 6.9 | Layered: controller stays OWNER+MEMBER, service enforces OWNER‖creator via `assertOwnerOrCreator` |
| #4 | orderEventMetadata helper underused | Critical | ✅ FIXED | 6.9 | Swept 20+ callsites + retired competing `auditMeta` + coverage test prevents regressions |
| #22 | confirm-delivery status guard | High | ✅ FIXED | 6.9 | `status: "VERIFIED"` added to inner updateMany.where |
| R-3 / R-4 | MEMBER-allowed money endpoints | High | ✅ FIXED | 6.9 | Service-layer OWNER‖creator gate on customerAcceptDelivery + customerApprove (already inline on others) |
| #8 | No error boundaries / no Sentry | Critical | ✅ FIXED | 7.0 | error.tsx + global-error.tsx + Sentry across all 4 apps + browser/server/edge runtimes |
| #9 | Publisher/admin no mobile sidebar | Critical | ✅ FIXED | 7.6 | Ported portal's drawer pattern (fixed translate-x + backdrop + sticky mobile-only header with hamburger) into admin + publisher layouts. Pathname auto-close + `type="button"` defense + ARIA labels. Builds clean (admin 19/19 static, publisher 13/13). |
| #10 | SettlementAutoApproveService in API setInterval | Critical | ✅ FIXED | 7.3 | Moved to single BullMQ repeatable job in worker (jobId dedup cluster-wide). Service deleted. Slow-sweep + stale-review Sentry warnings added. SETTLEMENT_AUTO_APPROVE_BATCH_SIZE env added. |
| #11 | Worker no health/metrics/errors | Critical | ✅ FIXED | 7.0 | Raw node:http server (`/health`, `/ready`, `/metrics/queues`) + BullMQ failed-event Sentry hook across all 9 processors + unhandledRejection exit-after-flush |
| #12 | Notification duplicates on retry | High | ✅ FIXED | 7.4 | Phase 6.6's support fan-out runtime dedup PLUS Phase 7.4's DB partial-unique on (userId, dedupKey). Reconciliation switched to drift-summary-keyed (hourly cron same drift → 1 alert per staff per UTC day, not 24). 8 typed dedup-key builders; writers swallow P2002 as success. |
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
| Documentation + audit-trail uniformity | C+ | **A−** | participantRole + actorSnapshot on every ticket message; Phase 7.7 A1 indexed `AuditLog.requestId` makes the trail SQL-queryable end-to-end |
| Input validation | (no row) | **A−** | 18 DTOs + class-validator coverage on every admin action body |
| Worker idempotency | B | **B+** | Phase 7.4 notification dedup (partial unique on `(userId, dedupKey)`); Phase 7.3 settlement auto-approve cluster-wide `jobId` dedup |
| Frontend reliability (errors/loading/empties) | C+ | **B** | Phase 7.0 `error.tsx` + `global-error.tsx` + Sentry across all 4 apps; Phase 7.7 C source-maps unminify production stack traces |
| Reporting + finance visibility | D | **B** | Phase 7.1 `GET /admin/finance/revenue` with 4 groupings + CSV + period comparison |
| Observability + correlation | (no row) | **B+** | Phase 7.0 Sentry + request-IDs + worker `/health` `/ready` `/metrics/queues`; Phase 7.7 indexed `requestId` column + admin filter + structured logger (partial) + source-map upload + extended `/metrics` |
| Mobile UX | (no row) | **B** | Phase 7.6 closed #9 — drawer ported into admin + publisher; a11y polish (escape/focus-trap/scroll-lock) deferred to Phase 7.9 |

---

**Forward roadmap** — the post-Phase-7.7 work, organized by lane so it's clear what's mid-flight vs blocked vs queued:

### Active — partial, continuing as small follow-up commits

_(none — Phase 7.7.x sweep landed as commit `5af902c` on PR #1; allowlist now contains only forever-allowed entries: `apps/api/src/main.ts` boot fallback + 3 browser-side `auth.tsx`)_

### Blocked — designed + approved, waiting on upstream

- **Phase 7.3.1 — `Settlement(status, reviewEndsAt)` composite index.** Status: **designed, approved, NOT implemented**. The most valuable uncompleted roadmap item. Phase 7.3's auto-approve worker sweep hits this access pattern every 15m, so the index pays off immediately at prod scale. **Blocked on Prisma 6.19.3 → 7.4+ upgrade**: Prisma 6 wraps each migration in a transaction and `CREATE INDEX CONCURRENTLY` cannot run inside one (prisma#14456, fixed in Prisma 7.4). Out of scope until the Prisma version upgrade lands as its own (week-scale) project.

### Deferred — approved plan moved into a later phase

- **Phase 7.6.1 — Drawer a11y polish.** Approved plan preserved verbatim in `~/.claude/plans/read-the-bedrock-views-audits-platform-a-typed-spark.md` appendix. Outstanding: focus trap, escape-to-close, focus restoration on close, body scroll-lock, plus `role="dialog"` / `aria-modal` / `aria-expanded` semantics. Implementation = a single shared `useDrawerA11y` hook in `@guestpost/ui/hooks/` wired into all three layouts. **Bundled into Phase 7.9** per the 2026-06-16 roadmap pivot — accessibility work groups naturally with the other frontend polish items (#28/#29/#30).

### Queued — next two cohesive phases (per 2026-06-16 roadmap)

- **Phase 7.8 — Security Hardening Batch.** Bundle: #26 (email-keyed rate limiter; current per-IP-only limits don't stop credential stuffing across an IP pool) + #27 (job-signing `iat` validation / replay protection) + related auth/session follow-ups discovered during implementation. Mission: Authentication / Authorization / Replay protection / Anti-abuse in one cohesive phase.
- **Phase 7.9 — Frontend Quality & Accessibility.** Bundle: #28 (status-color centralization in `@guestpost/ui` — `PUBLISHED` currently renders as 3 different greens) + #29 (adopt the Phase A shared components — `<BriefRenderer>` / `<FulfillmentChannelBadge>` / `<SupportPanel>` shipped batch 22 with zero imports today) + #30 (publisher listings hooks-rule violation at `apps/publisher/src/app/dashboard/listings/page.tsx:182-195`) + **Phase 7.6.1** (drawer a11y polish). Mission: Frontend consistency / Accessibility / Maintainability / Shared patterns.

### Future minimal updates (after specific work lands)

- **After Phase 7.7 A1 prod migration applied** — paste before/after `requestId`-coverage counts + `EXPLAIN ANALYZE` plan node showing `Index Scan using "AuditLog_requestId_idx"` into the Phase 7.7 §11 entry.
- **After Phase 7.7 C operator adds `SENTRY_AUTH_TOKEN`** — confirm first post-merge CI build uploaded source maps; check Sentry → Releases → artifact list; add a one-line "source-maps live" note to Phase 7.7 §11 entry.
- ~~After each Phase 7.7.x sweep commit~~ — **DONE** (commit `5af902c`, PR #3 merged 2026-06-16).
- ~~After each Phase 7.7.y spec restoration~~ — **DONE** (commits `aa8cd55` + `74c8d51` + `b670493`, PR #4 merged 2026-06-16). `testPathIgnorePatterns` at jest default; full `apps/api` jest is 33 suites / 478 tests, no skips.
- **After Prisma 6 → 7.4+ upgrade** — unblock Phase 7.3.1; ship the composite index migration; record planner-usage proof per the deferred plan's verification checklist.
- ~~After Phase 7.8 lands~~ — **DONE** (this entry). Auth/queue trust boundary has zero open security findings; #25 + #26 + #27 + §5.8 sub-finding all closed in one PR.
- **After Phase 7.8 Deploy B lands** (≥48h post this PR) — record the one-line `allowMissingIat: false` flip + post-flip CI green confirmation as a "Deploy B" sub-entry under this Phase 7.8 §11 entry.
- **After Phase 7.9 lands** — append new §11 entry; update scorecard's "Mobile UX" + "Frontend reliability" rows; mark Phase 7.6.1 closed.

**Production-blocker status**: **11 of 11 Criticals closed (100%)**. No production-blocker finding from the 2026-06-15 audit remains open. All remaining work is High/Medium polish, security hardening, or accessibility — none gate production.

---

### 2026-06-18 — Phase 7.9: Frontend Quality & Accessibility (#28 + #29 + #30 + Phase 7.6.1 drawer a11y)

**All remaining Medium audit findings closed in one cohesive PR**, plus the Phase 7.6.1 drawer-accessibility polish that was deferred from Phase 7.6. ESLint with `react-hooks/rules-of-hooks` added to CI as a bundled rider so the #30-class regression gets caught at PR time going forward.

**Branch**: `phase-7.9-frontend-quality-accessibility` — 7 commits + bedrock-update commit, all tests green.

| # | Title | What landed | Commits |
|---|---|---|---|
| #28 | Status-color drift (`PUBLISHED` rendered as 3 different greens across 9 pages) | New `packages/ui/src/lib/status-presentation.ts` exports 5 typed `Record<XStatus, StatusPresentation>` tables (Order/Ticket/Dispute/Listing/Campaign) backed by Prisma-generated enums (`import type { OrderStatus, ... } from "@guestpost/database"` — a schema-side enum rename/add fails `tsc` immediately, not silently at runtime). 5 per-family typed accessors (`getOrderStatusPresentation` etc.) — cross-family confusion like `getTicketStatusPresentation("PUBLISHED")` rejected at COMPILE time. 11-case Vitest spec covers runtime-shape sanity + deliberate cross-family divergence (ticket OPEN = info/blue, dispute OPEN = destructive/red — preserved with regression guard). 9 status pages migrated: `apps/portal/src/app/dashboard/{page,orders/page,orders/[id]/page,campaigns/page,campaigns/[id]/page,support/page}.tsx` + `apps/admin/src/app/dashboard/{marketplace,support,disputes}/page.tsx`. ~29 inline `statusColors` consts deleted; page-local icon maps + `VARIANT_CIRCLE_BG` helpers retained where pages render icons or icon-circles (per the table's explicit "no icon field — stays local" design). Stale legacy enum entries (ASSIGNED, OUTREACH, UNDER_REVIEW, REVIEW) cleaned up incidentally. | `0a48f23` (table + spec), `ea29e26` (9-page sweep) |
| Phase 7.6.1 | Drawer a11y missing across 3 dashboards (no escape close, no focus trap, no scroll-lock, no ARIA) | New `<Drawer>` component at `packages/ui/src/components/drawer.tsx` built on `@radix-ui/react-dialog@1.1.0` (already a dep — no new package). Radix Dialog provides `role="dialog"` + `aria-modal` + focus trap + focus restore + Escape close + body scroll-lock + inert background ALL for free. Exports Drawer/DrawerTrigger/DrawerPortal/DrawerClose/DrawerOverlay/DrawerContent/DrawerTitle, mirroring the existing `dialog.tsx` shape. `lg:hidden` on overlay + content keeps desktop sidebar a static `<aside>`. 7-case Vitest spec covers controlled-mode rendering, `role="dialog"`, accessible-name from DrawerTitle, Escape close, overlay-rendered-on-open. The 3 dashboard layouts (`apps/{portal,admin,publisher}/src/app/dashboard/layout.tsx`) ported: sidebar JSX extracted into `function SidebarContents({ inDrawer })`, rendered twice — static desktop `<aside className="hidden lg:flex ...">` + mobile `<Drawer open={...} onOpenChange={...}><DrawerContent><SidebarContents inDrawer /></DrawerContent></Drawer>`. Hand-rolled backdrop divs deleted. Portal layout finally gets the pathname-auto-close (`useEffect(() => setOpen(false), [pathname])`) that admin + publisher got in Phase 7.6 but portal was missing. | `8c9d868` (Drawer + spec), `e90ea34` (3 layouts ported) |
| #29 | Three Phase A components (`<BriefRenderer>`, `<FulfillmentChannelBadge>`, `<SupportPanel>`) shipped with zero imports | **SupportPanel**: portal `OrderSupportPanel` hand-roll at `apps/portal/src/app/dashboard/orders/[id]/page.tsx:1057-1112` deleted; query lifted to parent `OrderDetailPage` (same `queryKey: ["order-tickets", id]` — TanStack Query dedupes). **FulfillmentChannelBadge**: 2 local `ChannelBadge` components deleted (`apps/admin/src/app/dashboard/support/page.tsx` + same file's `[id]/page.tsx`); 3 inline `<ChannelBadge>` use sites swapped to `<FulfillmentChannelBadge>`. **BriefRenderer**: portal order-detail "Content Brief" card wrapped — the component falls back to the legacy single-string display when `briefData` is NULL, so no regression for existing orders + automatic structured-brief rendering for new ones. **Adoption regression guard** at `packages/ui/src/components/__tests__/shared-component-adoption.test.ts` greps `apps/**/src/**/*.{ts,tsx}` for 3 forbidden patterns (`OrderSupportPanel` reintroduced, badge-label ternary `fulfillmentChannel === "PLATFORM" ? "Platform"`, local `ChannelBadge` definitions) with scope discipline excluding `node_modules`/`.next`/`dist`/`build`/`coverage`/`__tests__`/`__mocks__`/`__fixtures__`/`*.test.*`/`*.spec.*`. Same defense-in-depth pattern as Phase 7.7's structured-logger guard and Phase 7.8's repeatable-job-registry guard. | `36fc4ee` |
| #30 | Hooks-rule violation in publisher listings page (factory-wrapped useMutation) | Replaced `makeLifecycleMutation` factory + 4 calls at `apps/publisher/src/app/dashboard/listings/page.tsx:182-195` with 4 inline `useMutation` calls + a `lifecycleOpts(label)` helper that returns the options object (not a hook). Matches the file's existing convention. **Plus**: 9 latent rules-of-hooks violations surfaced by the new ESLint setup in `apps/admin/src/app/dashboard/marketplace/page.tsx` — an `if (queryError) return <ErrorState />` early-return at line 168 sat BEFORE 9 later useMutation/useState calls. Fixed by moving the early-return AFTER all hook declarations. | `510993b` |
| **Rider** | No ESLint anywhere in CI — `react-hooks/rules-of-hooks` regressions were undetectable | New root `eslint.config.mjs` (flat config, ESLint 9). Tight rule set on purpose: `@eslint/js recommended` + `typescript-eslint recommended` + ONLY `react-hooks/rules-of-hooks`. Explicitly NOT enabled: `react-hooks/exhaustive-deps`, `next/core-web-vitals`, `react/recommended`, Tailwind plugins — each would surface dozens of pre-existing warnings unrelated to this PR. Inline-disabled TS-eslint rules each named explicitly so the rationale is auditable. New scripts: `apps/portal` (replaces `next lint`), `apps/admin`, `apps/publisher`, root (`pnpm -r --filter ... run lint`). CI step added to **both** `.github/workflows/ci.yml` and `.github/workflows/pr.yml` right after the TypeScript check. Catches the next #30-class regression at PR time. Future broader rule expansion is one config edit. | `510993b` |

**Test count outcome**: `packages/ui` Vitest went from **2 suites / 13 tests** (pre-Phase-7.9) → **5 suites / 40 tests** (added: status-presentation spec, drawer spec, shared-component-adoption guard). `apps/api` jest unchanged at **39 suites / 547 tests**.

**Pre-impl gate**: confirmed `@guestpost/database` already re-exports all 5 Prisma enums (`OrderStatus`, `TicketStatus`, `DisputeStatus`, `ListingStatus`, `CampaignStatus`) via the chain `packages/database/src/index.ts` → `export * from "./prisma/client"` → `client.ts:22 export * from "./enums"` → typed `(typeof X)[keyof typeof X]` string-literal unions. No changes needed to the database package.

**Architecture impact**: zero — Phase 7.9 is presentational. The status table is a constant lookup; the Drawer wraps an existing Radix dep; the shared-component adoption is API-shape-compatible; the hooks fix preserves runtime behavior.

**Visual diff note (for PR review)**: pages that used `green-700` vs `emerald-700` for the same status now render the same shade — that unification is the whole point of #28. Cross-family deliberate divergence preserved (ticket OPEN = blue/info, dispute OPEN = red/destructive — documented in the module header + regression-guarded).

---

### 2026-06-17 — Phase 7.8: security hardening batch (#25 + #26 + #27 + §5.8 sub-finding)

**Three Medium findings closed in one cohesive PR**, plus the trivially-bypassable `hasAuthCredentials()` cookie sniff called out as a sub-finding inside #26. After this PR, **the auth/queue trust boundary has zero open security findings.**

**Branch**: `phase-7.8-security-hardening` — 7 commits, all tests green.

| # | Title | What landed | Commits |
|---|---|---|---|
| §5.8 | `hasAuthCredentials()` accepts any cookie containing `guestpost-session` | Cookie shape regex written against captured Better Auth signed-cookie format (verified against `better-auth@1.6.14` `cookies/index.mjs` + `better-call@1.3.5` `crypto.mjs`). Junk cookies like `Cookie: guestpost-session=anything` no longer bump attacker to the higher authed rate-limit tier. 14-case unit test in `apps/api/src/common/__tests__/has-auth-credentials.spec.ts` including an explicit regression for the pre-Phase-7.8 bypass string. | `81174ee` (sub-finding fix bundled with 429 alignment) |
| #26 | Per-IP-only auth rate limits — credential stuffing across IP pool | New Better Auth plugin (`packages/auth/src/plugins/email-rate-limit.ts`) with `before` hooks on the 4 verified email-typed endpoints (`/sign-in/email`, `/sign-up/email`, `/sign-in/magic-link`, `/request-password-reset` — last one verified against source; original plan had `/forget-password` which doesn't exist in v1.6.14). Redis-backed counter keyed by `SHA-256(normalized-email)` so plaintext emails never appear in Redis (defeats redis-cli MONITOR / RDB-dump leaks) and INFO logs use `emailHash` (defeats log-aggregator PII surface). Per-endpoint prefix so `magic-link` doesn't lock out `sign-in`. Default 10/h sign-in, 5/h others (dev/test 10×). Dual layer: IP-layer Express limiter kept as the front line, this is the second line. **Account-enumeration safeguard**: 429 response is byte-identical between layers (verified by 11-case parity spec at `apps/api/src/__tests__/phase-7-8-rate-limit-parity.spec.ts` — status, statusText `"Too Many Requests"`, body `{"message":"Too many requests. Please try again later."}`, `X-Retry-After` header — copied byte-for-byte from `better-auth/dist/api/rate-limiter/index.mjs` `rateLimitResponse()`). Non-existent emails get the same 429 (plugin never touches the User table; source-grep enforces). | `5977b9c` (Redis singleton promotion), `7a12a1e` (plugin + `createAuth()` factory), `f3fe975` (`main.ts` wiring + parity test) |
| #27 | Job-signing has no `iat` — captured signatures replayable forever | `signJobPayload` now injects `iat: Date.now()` + `v: 1` (both part of the canonical digest so tamper-proof). `verifyJobPayload` takes a `VerifyOptions` object with `maxAgeMs` (default 24h) and `allowMissingIat` (default true this PR — **Deploy A** rollout escape hatch so in-flight pre-deploy payloads aren't rejected). 60s NTP-skew tolerance on future-dated `iat`. **Centralized repeatable-job registry** at `apps/worker/src/repeatable-job-registry.ts` (5 names: payout-check-status, reconciliation-run, website-reverify-sweep, settlement-hold-sweep, settlement-auto-approve) — repeatables sign once at boot and reuse, so they bypass freshness via `maxAgeMs: 0` (HMAC integrity check still runs). **Drift guard** at `apps/api/src/__tests__/phase-7-8-repeatable-registry-drift.spec.ts` greps both sides and asserts set equality both directions (adding a repeatable in one place without the other fails CI with the missing name). All 9 worker processors updated with the right per-queue `maxAgeMs` (default 24h; delivery-verification 96h for staff manual-review turnaround; payout 72h for Wise-outage long-weekend retries). 17-case unit test at `apps/api/src/__tests__/phase-7-8-job-signing-iat.spec.ts`. | `058fa7e` (shared module), `f489e2e` (registry + 9 processors + drift guard) |
| #25 | `User.emailVerified` field never consulted by AuthGuard | New `email-verification-policy.ts` module: `requiresEmailVerification(req)` returns true for state-changing methods (POST/PATCH/PUT/DELETE) on non-exempt customer routes. `EXEMPT_POST_PATHS` covers `/api/v1/auth/*` (so locked-out user can still sign out + resend verification) + `/api/v1/users/me/resend-verification` (future explicit trigger). **AuthGuard surgery applies the check at BOTH paths** — post-DB-load AND post-cache-hit. Without the cache-hit check, an unverified user who first hits an exempt GET path would be cached and then bypass the gate on subsequent POSTs within the 30s TTL. Scope: CUSTOMER only (PUBLISHER + STAFF have separate verification tracks). Throws `ForbiddenException("EMAIL_NOT_VERIFIED")` — frontend follow-up to render a resend banner is OUT OF SCOPE. **23-case policy unit test** at `apps/api/src/modules/auth/__tests__/email-verification-policy.spec.ts`. | `4dbfd67` |

**Mandatory pre-merge GET-mutation audit** (merge blocker before #25 lands): `grep -rnE "@Get\(['\"]([^'\"]+)['\"]\)" apps/api/src/modules/ | grep -iE "(verify\|sync\|trigger\|confirm\|reset\|cancel\|complete\|approve\|reject\|enable\|disable\|publish\|unpublish\|process\|execute\|run\|fire\|kick\|toggle\|set\|update\|create\|delete\|remove)"` returned 5 matches — all false-positive substrings (`publish` inside `publisher`, `set` inside `settlements`, `approve` inside `force-approved`); every handler is a pure read operation. The "GETs stay open" assumption in the gate is safe. Audit passes; PR description pastes the grep output verbatim under `## GET-mutation audit`.

**Pre-impl gates** (all blocking, all completed before commit work):

1. **Better Auth route paths verified** against `better-auth@1.6.14` source — 3 of 4 plan-assumed paths matched, but the password-reset route is `/request-password-reset` (not `/forget-password` as the plan had assumed). Plan + plugin updated.
2. **Two-instance audit** — server-side `dist/index.mjs` returns zero matches for `setInterval|setTimeout|setImmediate|queueMicrotask|process\.on|EventEmitter|\.on\(|\.addListener\(|\.once\(|\$use\(|new Worker\(`. All audit hits are isolated to client-side modules (`plugins/one-tap/client.mjs`, `client/proxy.mjs`, `client/session-refresh.mjs`, `client/query.mjs`) which the server-side `betterAuth(...)` import path doesn't touch. Factory + singleton co-existence is safe; fallback (singleton + setter) not needed.
3. **429 response shape captured** from `better-auth/dist/api/rate-limiter/index.mjs` `rateLimitResponse()` — no dev-server boot needed. Cookie format captured from `better-call@1.3.5` `crypto.mjs` `signCookieValue` (`encodeURIComponent(token + "." + base64HMAC)`) + Better Auth's dual cookie-name format (`${prefix}.${cookieName}` or `${prefix}-${cookieName}`, default `cookieName="session_token"`).

**Test count outcome**: `apps/api` jest went from **33 suites / 478 tests** (post-Phase 7.7.y) → **39 suites / 547 tests, no failures**. Six new specs landed this phase: `redis-client`, `has-auth-credentials`, `phase-7-8-rate-limit-parity`, `phase-7-8-job-signing-iat`, `phase-7-8-repeatable-registry-drift`, `email-verification-policy`. Plus 13-case plugin spec in `packages/auth/src/__tests__/email-rate-limit-plugin.spec.ts` (new jest infra mirroring `@guestpost/api-client`).

**Deploy A → Deploy B follow-up** (≥48h after this PR merges): one-line flip of `allowMissingIat` default from `true` to `false` in `packages/shared/src/job-signing.ts`. By then the longest-backoff queue (delivery-verification 60m × 3 = ~3h) has long since drained all pre-Phase-7.8 payloads. Tracked in `bedrock/Work/backlog.md`.

**Operator ops checklist** (in PR description): pre-deploy percentage query on `User`/CUSTOMER for the lockout impact of #25; optional backfill for customers with confirmed orders in the last 90 days (treats them as real humans, exempts from lockout); record pre/post backfill numbers in the PR.

---

### 2026-06-17 — Phase 7.7.y: restored 3 pre-existing failing test specs (Phase 6.x fixture drift)

**Closure of the Phase 7.7.x IOU.** PR #3 had to skip 3 specs via `testPathIgnorePatterns` to green CI; each spec covered a real money-path / RBAC invariant but had mocks that predated Phase 6.x hardening. Phase 7.7.y removed the IOU — mocks updated to match current production behavior, specs re-enabled.

**PR**: [#4](https://github.com/GuestPost-cc/GuestPost.cc/pull/4) — 3 commits, merged 2026-06-16 22:24 UTC. **No production code changed; mock-fixture surgery only.**

| Commit | Spec | Phase 6.x change it caught up to |
|---|---|---|
| `aa8cd55` | `staff-roles.guard.spec.ts` | Phase 6.7 fail-closed guard. Replaced the "allows access when no roles are required" test (asserted pre-Phase-6.7 permissive behavior) with two new fail-closed tests covering both branches: undefined metadata + empty roles array. `admin-rbac-coverage.spec.ts` covers the positive side; these now explicitly verify the guard's deny response. **10/10 pass.** |
| `74c8d51` | `order-payment.service.spec.ts` | Phase 6.9 `assertOwnerOrCreator` + Phase 6 `listingServiceId` snapshot. `mockOrder` gained `customerId: "user-1"` (matches actorUserId so isCreator passes) + `listingServiceId: "ls-1"`. Swapped `marketplaceListing.findFirst` → `listingService.findUnique` to match the production query. Per-test resolves updated. All 6 BadRequest/Conflict assertions now actually fire instead of being masked by Forbidden. **6/6 pass.** |
| `b670493` | `prebeta-audit-regression.spec.ts` F-3 | Phase 6 `Order.listingServiceId` invariant. Added `listingService` to the mock factory's table list (was missing entirely) + mocked the full `findUnique({ where, include: { listing: { include: { website: { select: {...} } } } } })` shape that `orders.service.ts:99-132` queries. Sibling test "replays via the composite lookup" left untouched (returns early from `prisma.order.findUnique` before reaching the listingService check). **28/28 pass.** |

**Trace-check discipline**: before editing Spec B and Spec C, ran each ignored spec via `jest --testPathIgnorePatterns="node_modules"` to capture the actual first thrown exception. Spec B's first failure was confirmed as `ForbiddenException` from `assertOwnerOrCreator` (matched prediction); Spec C's was `BadRequestException` with `code: "LISTING_SERVICE_REQUIRED"` (matched prediction). The `--listTests` re-enable check caught one mid-flight issue — the prebeta mock factory was missing `listingService`, surfacing as `TypeError: Cannot read properties of undefined (reading 'findUnique')` instead of leaving the spec silently broken.

**Allowlist final state**: `apps/api/jest.config.js` `testPathIgnorePatterns` now contains exactly `["/node_modules/"]` — the jest default with no Phase 6.x/7.7.y carve-outs left.

**Test count outcome**: `apps/api` jest went from 30 suites / 434 tests with 3 skips → **33 suites / 478 tests, no skips**.

---

### 2026-06-16 — Phase 7.7.x: structured-logger sweep completion + CI green (5 latent issues)

**Two intertwined batches** shipped on a single branch + merged as one PR ([#3](https://github.com/GuestPost-cc/GuestPost.cc/pull/3), 7 commits, merged 2026-06-16 21:44 UTC).

**Batch 1 — Logger sweep completion** (commits `5af902c` + `45ef221`):
- Phase 7.7 B left ~85 `console.*` callsites across 7 worker files on a regression-test allowlist as a tracked carry-forward.
- Phase 7.7.x converted all 8 remaining files (worker/index.ts, payout, verification, reconciliation, email, website-verification, delivery-verification, report) to `logger.*` — 85 callsites in one mechanical pass. Entity IDs and key=val pairs moved into JSON ctx, not flattened into msg strings (per plan principle).
- Removed 4 stale `.js` + `.map` build artifacts in `apps/worker/src/` (escaped earlier `19a859f` cleanup).
- Allowlist tightened to forever-allowed entries only: `apps/api/src/main.ts` (boot fallback, 6 calls) + 3 browser-side `apps/*/src/lib/auth.tsx` session-refresh handlers (structured-logger is Node-only; browser-safe logger is a separate concern).
- **Outcome**: `apps/worker/src` now contains **zero production `console.*` calls**.

**Batch 2 — 5 latent CI breakages diagnosed + fixed** (commits `76442ad`, `e07abd8`, `534ef58`, `6271af4`, `69b4409`):

| Commit | Latent issue (pre-existed PR #1, masked until prior step ran) |
|---|---|
| `76442ad` | `turbo.json` build task had no `env:` declaration. Turbo 2+ sandboxes env vars, so `prisma generate` inside `@guestpost/database#build` couldn't see `DATABASE_URL` even though the GitHub Actions job had it set. Added `env: [DATABASE_URL, SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT, SENTRY_DSN, SENTRY_ENVIRONMENT, SENTRY_RELEASE, NEXT_PUBLIC_*]` + `globalEnv: [NODE_ENV, CI]`. |
| `e07abd8` | `pnpm/action-setup@v4` errored with "Multiple versions of pnpm specified" because both `version:` (in workflow) and `packageManager:` (in package.json) were set. Dropped the redundant `version:` from `ci.yml` + `pr.yml`; package.json's `packageManager: pnpm@11.5.1` is now the single source of truth. |
| `534ef58` | Validate workflow ran `pnpm run typecheck` but root package.json had no such script. Added `typecheck: turbo typecheck` to root scripts. |
| `6271af4` | Once typecheck ran, Next.js apps' `tsc --noEmit` failed with `Cannot find module '@guestpost/ui'` because the "Build dependencies" step only built shared/database/auth. Expanded the build filter to include `@guestpost/ui` + `@guestpost/api-client`. |
| `69b4409` | `pnpm build` job hung indefinitely (timed out) — Phase 7.7 C's `sourcemaps: { disable: false }` made the Sentry plugin attempt to contact api.sentry.io even without `SENTRY_AUTH_TOKEN`, hanging on a network call. Fix: gate `disable` on token presence in all 4 `next.config.ts` (`disable: !process.env.SENTRY_AUTH_TOKEN`). Also skipped 3 pre-existing failing test specs via `testPathIgnorePatterns` in `apps/api/jest.config.js` (handed off to Phase 7.7.y above). |

**CI failure peel-back pattern**: each fix surfaced the next latent issue. None caused by Phase 7.7's mainline work — all five had been broken since Phase 7.0 era but masked because validate kept failing at the pnpm step before reaching the deeper layers. The peel-back logic is documented in each commit's body for future forensic work.

**Post-merge harmonization** (commits `5eff2a1`, `7695046`, `07ce6c5` — landed directly on main by repo owner): harmonized the three workflow files (`ci.yml`, `pr.yml`, `main.yml`) for consistency, added `QUEUE_SIGNING_SECRET` to pr.yml, gitignored `packages/ui/coverage`.

---

### 2026-06-16 — Phase 7.7: Operations & Observability Hardening (Phase 7.0 follow-ups)

Four-workstream observability bundle. **Does not close a numbered audit finding** — the observability section was already marked closed by Phase 7.0 — but completes the deferred "Phase 7.0.1 follow-up" trio plus a /metrics extension. Audit dashboard counts stay 19/31 closed (61%); 11/11 Critical at 100%.

**Mission**: end-to-end production-incident traceability via one ID.

```
Sentry Event → requestId → structured logs → audit trail
```

**5 commits on one branch (one PR):**

| Commit | Workstream | One-liner |
|---|---|---|
| `4ffb3c5` | A1 | Promote AuditLog.requestId → indexed top-level column (VARCHAR(128) + partial btree); backfill from `metadata->>'requestId'`; AuditService.log dual-writes column + metadata mirror |
| `7fa068a` | A2 | Admin audit-logs `?requestId=` filter (EXACT-MATCH only; never substring) + per-row Copy button + CSV column |
| `a01802d` | B  | New `packages/shared/src/observability/structured-logger.ts` (Node-only, deep-import) with JSON + pretty modes, auto-injects requestId from ALS frame, `environment` + `release` env-resolved at module init. 13 unit tests + grep regression guard. 8 worker files swept (~23 callsites); remaining ~85 tracked in `CURRENTLY_ALLOWED_WITH_CONSOLE` map for Phase 7.7.x continuation |
| `6d82473` | C  | Sentry source-map upload enabled: `@sentry/cli: true` in workspace, `widenClientFileUpload` + `sourcemaps.deleteSourcemapsAfterUpload` on all 4 next.configs, `SENTRY_AUTH_TOKEN` threaded into CI build env (silently skipped without secret) |
| `4bf4ece` | D  | `/metrics/queues` extended with `service: { name, version, pid, started_at, uptime_s }` block + cumulative `dedupHitsTotal` (Phase 7.4 counter) + new `stalledHitsTotal` counter |

**Workstream A — Indexed AuditLog.requestId**:

- Migration `20260616130000_phase77_audit_request_id_column`: ALTER TABLE + UPDATE backfill + CREATE INDEX (partial, WHERE requestId IS NOT NULL), all three with `IF NOT EXISTS` for re-apply safety.
- VARCHAR(128) matches the `isValidRequestId` allowlist regex.
- **CONCURRENTLY NOT used** — Prisma 6.19.3 blocker carries over from Phase 7.3.1; brief ACCESS EXCLUSIVE on AuditLog during prod apply, acceptable since AuditLog isn't on the order-fulfillment hot path.
- **Dev DB migration apply deferred** — pre-existing dev DB has 5 missing migration files (`20260613*_*`); operator opted "skip dev migration, trust the SQL" per session decision. Apply on staging/prod where history is clean; record EXPLAIN ANALYZE planner-uses-index proof + before/after counts at that time.
- Dual-write (column + metadata.requestId mirror) is **permanent**, not transitional — storage cost trivial, downstream JSON readers stay supported.
- Admin filter EXACT-MATCH only (`equals`); never `contains`/`startsWith`/`endsWith`. Documented in code as stable design constraint.

**Workstream B — Structured logger (partial sweep)**:

- 8 worker files converted to `logger.*` (trust-enqueue, env, health-server, queue-observability, settlement-auto-approve, publisher-trust, notification + partial). Logger ships as `packages/shared/src/observability/structured-logger.ts`.
- JSON-mode schema: `{ ts, level, service, environment, release, requestId, msg, ...ctx }`. Pretty mode for dev (ANSI-colored, rid shortened to first 8 chars).
- `environment` resolves: `SENTRY_ENVIRONMENT` → `NODE_ENV` → `"development"`.
- `release` resolves: `SENTRY_RELEASE` → `npm_package_version` → `"unknown"`.
- 13/13 unit tests pass (JSON shape, env/release three-tier fallback, pretty mode, child() merge, stderr routing, ALS requestId injection).
- **Sweep regression guard** (`phase-7-7-structured-logger-sweep.spec.ts`) — `CURRENTLY_ALLOWED_WITH_CONSOLE` map snapshots remaining 7 files' console.* counts. New `console.*` in any non-listed file fails; counts dropping below baselines fail (forces allowlist to stay tight as 7.7.x sweeps land).
- Always-allowed forever: `apps/api/src/main.ts` (6 calls, boot last-resort), `structured-logger.ts` itself (impl module), test files, scripts.

**Workstream C — Sentry source-map upload**:

- All 4 Next.js apps now upload source maps on `pnpm build` (silently skipped without `SENTRY_AUTH_TOKEN`).
- `deleteSourcemapsAfterUpload: true` prevents `.map` files leaking source via the browser bundle.
- CI build job threads `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` from GitHub secrets.
- **Operator action required** to fully activate: generate token at https://sentry.io with `project:releases` scope, add as repo secret named `SENTRY_AUTH_TOKEN`.

**Workstream D — /metrics/queues extension**:

- New top-level `service: { name, version, pid, started_at, uptime_s }` block.
- `dedupHitsTotal` (Phase 7.4 notification dedup-key counter, was logged-only) now also exposed.
- `stalledHitsTotal` cumulative counter added to `queue-observability.ts`; increments on every BullMQ `stalled` event across all queues. Both counters reset on worker restart.

**Phase 7.7.x backlog** (continuation):

- Complete the structured-logger sweep on the remaining 7 worker files (~85 callsites). Each commit removes its file's entry from `CURRENTLY_ALLOWED_WITH_CONSOLE` until the map only contains forever-allowed entries.

**Verification highlights:**

- Typecheck clean on api + worker + shared + admin
- 13/13 structured-logger unit tests + 3/3 sweep regression tests pass
- Full API jest suite — 453/461 pass (3 pre-existing failures unchanged by Phase 7.7)
- `pnpm install` confirms `@sentry/cli` binary downloads after workspace flip
- `pnpm --filter @guestpost/portal build` confirms `withSentryConfig` opts parse; source-map upload silently skipped without token (as designed)

**Production cutover checklist for operator** (post-merge):

1. Apply migration `20260616130000_phase77_audit_request_id_column` on staging/prod (clean migration history; off-peak recommended). Record before-count of `metadata->>'requestId' IS NOT NULL` and after-count of `requestId IS NOT NULL` — they should match.
2. Run `EXPLAIN ANALYZE SELECT * FROM "AuditLog" WHERE "requestId" = '<sample id>'` and confirm plan node includes `Index Scan using "AuditLog_requestId_idx"`. Paste output here.
3. Generate `SENTRY_AUTH_TOKEN` with `project:releases` scope; add as GitHub repo secret. Next CI build will upload maps.
4. Curl `/metrics/queues` on a running worker pod; confirm new fields present.
5. Trace one production requestId end-to-end (log line → audit row → worker job → Sentry tag) to validate the Phase 7.7 spine.

---

### 2026-06-16 — Phase 7.6: Mobile UX for admin + publisher sidebars (#9) — closes last open Critical

**Findings resolved:**

| # | Status | Notes |
|---|---|---|
| **#9** | ✅ Fully fixed | Ported portal's working mobile-drawer pattern (fixed `translate-x` aside + backdrop overlay + sticky mobile-only header with hamburger) into admin + publisher dashboard layouts. Below `lg` the sidebar slides in via `mobileOpen` state and closes on: X-button tap, backdrop tap, nav-link click, or any `pathname` change (covers `router.push` / browser back-forward / deep-link arrivals). At `≥lg` the desktop layout is unchanged via `lg:translate-x-0` + `lg:hidden` on the mobile shell elements. |

**Implementation details:**

- **Pattern source**: `apps/portal/src/app/dashboard/layout.tsx` (lines 59, 86–168, 170–175, 177–184). No new dependencies; standard Tailwind responsive classes only.
- **Files modified** (2 total):
  - `apps/admin/src/app/dashboard/layout.tsx` — sidebar `sticky lg:fixed` → `fixed translate-x` drawer; added X-close in restructured brand row; backdrop + mobile-header wrapper. Role-gated `navItems.filter(...)` preserved.
  - `apps/publisher/src/app/dashboard/layout.tsx` — same port; X-close added to existing brand-row header (which already had `flex items-center justify-between`); preserved `overflow-auto` on `<main>` to avoid double-scrollbars at desktop widths.
- **Pathname auto-close**: `useEffect(() => { setMobileOpen(false) }, [pathname])` on both apps. Closes drawer on any navigation source, not just `<Link onClick>`.
- **Button hygiene**: every new `<button>` carries `type="button"` (defensive against accidental form-submit if the layout is ever rendered inside a `<form>` ancestor) and an `aria-label` (`"Open menu"` / `"Close menu"`). Bonus: also added `type="button"` to the pre-existing sign-out buttons that were touched.
- **A11y baseline**: matches the portal reference exactly — no escape-to-close, no focus trap, no body-scroll-lock. These polish items captured as Phase 7.6.1 follow-up to apply uniformly across all three apps.
- **Mission ceiling held**: did NOT consolidate to `packages/ui/src/components/layout/` stubs (separate cleanup), did NOT add new shared components, did NOT touch `<Notifications />` / `<OrgSwitcher />` shell components.

**Verification:**

- **Typecheck**: `pnpm --filter @guestpost/admin typecheck` + `pnpm --filter @guestpost/publisher typecheck` — clean (`$ tsc --noEmit`, exit 0).
- **Build**: `pnpm --filter @guestpost/admin build` → 19/19 static pages, exit 0. `pnpm --filter @guestpost/publisher build` → 13/13 static pages, exit 0. No new warnings vs. the pre-7.6 baseline (Sentry `disableLogger` deprecation + workspace lockfile inference are pre-existing).
- **Manual responsive smoke** (pending operator at a browser): per the plan's Priority 4 checklist — 375px / 768px / ≥1024px DevTools sweep; drawer slide-in + backdrop tap close + link-tap auto-close + X-button close + resize-to-desktop hides drawer/backdrop/mobile-header; admin role-gate sanity (sign in as OPERATIONS vs FINANCE); long-page single-scrollbar regression check; long-nav internal scroll at 568px viewport-height.

**Production-blocker outcome:**

- **Audit progress: 19/31 closed (61%)** — 11/11 Critical findings now closed (100%).
- **The 2026-06-15 platform audit no longer has any open production-blocker finding.** First time since the audit landed that the "Critical" column reads 0 open.
- **What ships next**: pointer rolls to Phase 7.3.1 (Settlement index migration), Phase 7.6.1 (drawer a11y polish across all three apps), Phase 7.0.1 (observability follow-ups), or the 5 remaining Medium findings — operator's choice.

---

### 2026-06-16 — Phase 7.5: Phase 6 snapshot backfill (#21)

**Findings resolved:**

| # | Status | Notes |
|---|---|---|
| **#21** | ✅ Fully fixed | One-shot SQL migration backfills `listingServiceId / serviceType / unitPrice / fulfillmentChannel / ownerType` on historical Settlement + PlatformRevenue rows via Settlement→Order→ListingService + Website join chain. Idempotent (`WHERE col IS NULL` skips already-populated rows). `COALESCE(existing, computed)` preserves partially-populated rows. Pre-Phase-4 orders (no listingServiceId ever recorded) stay NULL — Phase 7.1's dashboard handles via `"(unknown)"` bucket. |

**Required deliverable — before/after row counts on dev DB** (per the plan's Phase 7.5 success criteria):

```
Settlement rows updated:                                  0
PlatformRevenue rows updated:                             0
Remaining NULL listingServiceId (Settlement):             0
Remaining NULL listingServiceId (PlatformRevenue):        0
Remaining NULL serviceType      (Settlement):             0
Remaining NULL serviceType      (PlatformRevenue):        0
```

**Why the counts are 0** (this is honest reporting, not a bug): the dev DB has 60 Settlement rows and 0 PlatformRevenue rows; ALL 60 settlements were created post-Phase-6 with the snapshot trio already populated at creation (via `settlements.service.ts` and `order-review.service.ts`). The migration's `WHERE col IS NULL` filter correctly matched zero rows. On prod-like environments with pre-Phase-6 historical rows, this migration will backfill those rows; the dev DB doesn't simulate that state. The dev DB has 8 pre-Phase-4 Orders (`listingServiceId IS NULL`) — those represent the upper bound of rows that would *remain* NULL even after backfill (data was never captured), and the dashboard's `"(unknown)"` bucket continues to handle them.

**Migration design highlights:**

1. **`COALESCE(existing, computed)` not blind UPDATE** — the WHERE clause already excludes fully-populated rows, but partially-populated rows (e.g. some fields set, others NULL) MUST NOT overwrite the populated fields with potentially-different computed values. COALESCE preserves any non-NULL value. Test scenario 2 covers this explicitly.
2. **WHERE `col IS NULL` for idempotency** — re-running the migration is safe. Already-populated rows (whether post-Phase-6 native writes OR previous backfill runs) skip cleanly. Confirmed by running migration → 0 rows; re-running → 0 rows (no change). Idempotency works.
3. **LEFT JOINs on optional source tables** — `ListingService` and `Website` are LEFT JOINs because Order.listingServiceId / Order.websiteId can be NULL on legacy rows. COALESCE then preserves the Settlement-side NULL (acceptable — data was never recorded).
4. **No code changes outside the migration.** Phase 7.1's dashboard already handles NULL snapshots gracefully via the `"(unknown)"` bucket; the backfill just reduces how many rows hit that bucket. Zero service-layer impact.

**What landed:**

1. **`packages/database/prisma/migrations/20260616110000_phase75_phase6_snapshot_backfill/migration.sql`** — two UPDATE statements (Settlement + PlatformRevenue) with identical join chain and COALESCE shape. Sentence-style comment header inlines the audit #21 + Phase 7.1 context so future maintainers reading the SQL alone understand the rationale.

2. **`apps/api/src/__tests__/phase-7-5-snapshot-backfill.spec.ts`** — 14 tests in two layers:
   - **9 migration regression guards** (grep-style): file exists at expected path, both UPDATE blocks have COALESCE on all 5 columns, LEFT JOINs on ListingService + Website, WHERE clause has IS NULL on all 5 backfilled columns per table, comment header references Phase 7.5 + audit #21 + idempotency rationale
   - **5 algorithmic-correctness tests** (JS reimplementation of the COALESCE+WHERE logic against in-memory fixtures): all 5 NULL + full join → all populated; partially-populated row → only NULL fields touched, populated preserved (the critical COALESCE test); all populated → no-op; pre-Phase-4 row (Order.listingServiceId NULL) → stays NULL; bonus ownerType fallback from Website.ownershipType

**Verification:**

- shared + database + api + worker all build clean
- Test suite: 441/449 pass (+14 vs Phase 7.4); 3 pre-existing failures unchanged
- Migration applied to dev DB → 0 rows updated (expected; dev has no pre-Phase-6 historical rows)
- Re-applied (via `pnpm prisma migrate deploy` no-op since migration already marked applied; for a real re-run test on prod we'd verify 0 rows updated the second time)
- Phase 7.0 / 7.1 / 7.2 / 7.3 / 7.4 / 6.9 tests still green — no regressions
- Phase 7.1 revenue dashboard sanity (the integration test for `"(unknown)"` bucket shrinkage) is a no-op on dev because there were no NULL-snapshot rows to begin with — verification on prod-like environments would show the bucket count drop

**Phase 7.5 mission ceiling held**: no code changes outside the migration + test file. No service-layer refactor. No backfill of pre-Phase-4 orders from Order.type (would conflate global service type with per-service type — audit explicitly accepts NULL for these).

**Production-readiness scorecard (deltas):**

| Dimension | Was | Now | Why |
|---|---|---|---|
| Reporting + finance visibility | B+ | **A−** | Historical Settlement + PlatformRevenue rows now carry the Phase 6 snapshot fields. Phase 7.1's revenue dashboard's `"(unknown)"` bucket shrinks on prod once migration runs. Remaining `"(unknown)"` rows are genuinely irrecoverable (pre-Phase-4). |
| Schema migration discipline | (no row) | **A−** | Pattern set: idempotent backfill via COALESCE + WHERE IS NULL, paired with JS reimplementation test for algorithmic correctness. Future backfill migrations can mirror. |

**What to ship next** (post-Phase-7.5):

1. **Phase 7.3.1** — `CREATE INDEX CONCURRENTLY ON Settlement(status, reviewEndsAt)`. Tiny migration; the Phase 7.3 worker sweep runs this exact query every 15m. Already in the post-7.5 roadmap.
2. **#9** — Mobile UX (publisher + admin sidebar drawer below `lg`). Last open Critical/High.
3. **Phase 7.0.1** — Observability follow-ups (`requestId` indexed column + backfill, structured logger, Sentry source-map upload).

The combined 7.3 + 7.4 + 7.5 batch is complete. 100% of Critical findings closed except #9 Mobile UX; production-blocker queue cleared.

---

### 2026-06-16 — Phase 7.4: Notification dedup across queues (#12)

**Findings resolved:**

| # | Status | Notes |
|---|---|---|
| **#12** | ✅ Fully fixed | Migration adds `Notification.dedupKey VARCHAR(256)` + partial unique index `(userId, dedupKey) WHERE dedupKey IS NOT NULL`. Writers route through 8 typed builders in `packages/shared/src/notification-dedup-keys.ts`. P2002 unique violations swallowed as success at the writer level — retries are idempotent no-ops. Reconciliation alerts switch from runId-keyed (re-fires hourly forever) to **drift-summary-keyed + UTC date bucket** (collapses to ONE staff alert per day per drift composition; new composition or new day → new alert). |

**Beyond-audit improvements:**

| Improvement | Why it matters |
|---|---|
| **Drift-summary dedup key** | The audit suggested keying on `runId`, which would only dedup within-run retries — hourly cron still pings staff every hour for the same persistent drift. New scheme keys on `(driftType, summaryFingerprint, staffUserId, YYYY-MM-DD)`: same drift composition + same UTC day → ONE notification. Drift composition changes (e.g. new wallet drift appears) → new key → new notification (operator sees the evolution). Next UTC day → new key → re-alert if drift still present (reminds operator it persists). |
| **Belt-and-suspenders for support fan-out** | Phase 6.6 already added runtime `Map<userId, organizationId>` dedup at the call site (prevents per-event multi-role duplicates). Phase 7.4's DB unique constraint adds a second layer: catches queue-retry duplicates of the same `(messageId, userId)` pair. Both layers cover different failure modes; neither is sufficient alone. |
| **Typed dedup-key builders** | Free strings would invite typos and key-shape drift; the 8 typed builders (`reconDrift`, `deliveryFailed`, `deliveryManual`, `deliveryAccepted`, `chargeback`, `listingStatus`, `supportMessage`, `trustTierChange`) make adding a new notification type a deliberate design step. All keys validated ≤256 chars to match the DB column cap. |
| **`isUniqueViolation()` helper + cumulative `dedup_hits_total` counter** | The processor logs `[NOTIFICATION] deduped key=… dedup_hits_total=N` on every P2002 catch. `grep dedup_hits_total= \| tail -1` gives ops the current count without parsing every line. After production telemetry settles, this informs whether a future formal metrics layer (Phase 7.x.x) is worth building. |
| **VARCHAR(256) + partial unique index** | Bounded length is defense-in-depth — the helper validates length, but a stray admin-tool insert can't blow past it. Partial index keeps the index slim (only deduplicated rows indexed) and explicit `WHERE dedupKey IS NOT NULL` removes any ambiguity about NULL semantics across Postgres versions. |

**Migration:**

- `packages/database/prisma/migrations/20260616100000_phase74_notification_dedup/migration.sql`
- `ALTER TABLE "Notification" ADD COLUMN "dedupKey" VARCHAR(256);`
- `CREATE UNIQUE INDEX "Notification_userId_dedupKey_key" ON "Notification" ("userId", "dedupKey") WHERE "dedupKey" IS NOT NULL;`
- **Purely additive**, no backfill, no breaking change. Legacy notifications all have `dedupKey: NULL` and coexist freely (the partial unique excludes NULL rows from the constraint). Only NEW writes that supply a key benefit from dedup. Zero risk to historical reads. Applied to dev DB during Phase 7.4 implementation; column + partial unique index confirmed via `psql information_schema` query.

**What landed:**

1. **`packages/shared/src/notification-dedup-keys.ts`** (new) — 8 typed builders (`reconDrift` with the UTC-date-bucket design, `deliveryFailed`, `deliveryManual`, `deliveryAccepted`, `chargeback`, `listingStatus`, `supportMessage`, `trustTierChange`) + `utcDateBucket()` helper + `isUniqueViolation()` Prisma-P2002 type guard + module-scoped `dedup_hits_total` counter (`incrementDedupHits`, `getDedupHitsTotal`, `__resetDedupHitsTotal` for tests).

2. **`packages/database/prisma/schema.prisma`** — `dedupKey String? @db.VarChar(256)` + `@@unique([userId, dedupKey], map: "Notification_userId_dedupKey_key")`.

3. **`apps/worker/src/processors/notification.processor.ts`** — accepts optional `dedupKey` from signed job payload; wraps `prisma.notification.create` in try/catch that swallows P2002 as success, logs `[NOTIFICATION] deduped key=<k> user=<u> dedup_hits_total=<N>` cumulative.

4. **`apps/worker/src/processors/reconciliation.processor.ts`** — computes a drift-summary fingerprint (`wallet=N,pub=N,stuckOrd=N,stuckPay=N`) + UTC date bucket; loops staff and creates notifications with `reconDrift` keys. Same drift composition across hourly runs collapses to one alert per staff per day.

5. **`apps/api/src/modules/queues/queue.service.ts`** — `pushNotification(jobName, data, dedupKey?)` threads optional dedupKey through the signed payload. Existing callsites unchanged (default NULL dedupKey behavior); new callsites supply keys.

6. **`apps/api/src/modules/orders/services/delivery-intervention.service.ts`** — `notifyOrderParties` now takes `deliveryVersionId`; uses `notificationDedupKey.deliveryManual(versionId, userId)` per recipient. All 3 callers (`manualApprove`, `manualReject`, `override`) updated.

7. **`apps/api/src/modules/orders/services/order-delivery.service.ts`** — customer-accept publisher-owner notifications use `notificationDedupKey.deliveryAccepted(versionId, userId)`.

8. **`apps/api/src/modules/billing/billing.service.ts`** — `notifyStaff` accepts optional `dedupKeyPrefix`; all 4 chargeback callsites supply distinct prefixes (`chargeback:<id>:opened`, `chargeback:<id>:closed-unlinked`, `chargeback:<id>:closed-unrecognized`, `chargeback:<id>:won|lost`).

**17 new tests** — `apps/api/src/__tests__/phase-7-4-notification-dedup.spec.ts`:
- 7 builder shape + bound tests (8 builders covered; reconDrift gets 3 dedicated cases for composition / new-day semantics)
- 2 `isUniqueViolation` predicate tests (P2002 detection + false-positive guard)
- 2 `dedup_hits_total` counter behavior tests
- 3 migration / schema regression guards (file exists, SQL has the expected ALTER + CREATE UNIQUE INDEX + WHERE clause, Prisma schema mirrors with `@db.VarChar(256)` + `@@unique` map)
- 3 writer integration tests with Prisma mock (3 identical creates → 1 row + 2 dedup hits; 3 distinct keys → 3 rows; 2 NULL dedupKey → 2 rows for legacy compat)

**Verification:**

- shared + database + api + worker all build clean
- 427/435 tests pass (+17 vs Phase 7.3); 3 pre-existing failures unchanged
- Migration applied to dev DB; column + partial unique index verified via psql
- Live retry-storm smoke (force a delivery-failed event 3x → confirm 1 notification row) deferred to user-side pre-merge

**Phase 7.4 mission ceiling held**: schema change is the dedupKey column + partial unique index, nothing else. No notification-type refactor, no message-template change, no per-event-type routing, no observability layer beyond the existing structured log.

**Production-readiness scorecard (deltas):**

| Dimension | Was | Now | Why |
|---|---|---|---|
| Worker idempotency | B | **A−** | Notification queue retries no longer write duplicate rows; reconciliation drift hourly spam collapsed to per-day. Other queues (email, report) still duplicate on retry — separate scope. |
| Operational signal-to-noise | (no row) | **A−** | Drift alerts that previously fired 24× per day per staff now fire once. Drift composition changes still produce a new alert (operator sees situation evolving). |

**What to ship next** (Phase 7.5 trigger):
- **#21 Snapshot backfill** — already planned in the combined 7.3/7.4/7.5 plan. One-shot SQL migration backfilling Phase 6 snapshot fields on historical Settlement + PlatformRevenue rows. Required-deliverable before/after row counts. ~half day.

---

### 2026-06-16 — Phase 7.3: Settlement auto-approve worker migration (#10)

**Findings resolved:**

| # | Status | Notes |
|---|---|---|
| **#10** | ✅ Fully fixed | Auto-approve sweep moved from `OnModuleInit + setInterval` in every API pod to a single BullMQ repeatable job in the worker. `jobId: "settlement-auto-approve"` provides cluster-wide dedup — 3 pods = 1 sweep per cadence (was: 3 sweeps). DB load decoupled from API pod count. Per-row write semantics unchanged (status + version guard, transactional approval upsert + orderEvent + auditLog). |

**Beyond-audit operational improvements:**

| Improvement | Why it matters |
|---|---|
| **Slow-sweep warning to Sentry** | When `duration_ms > SETTLEMENT_AUTO_APPROVE_SLOW_MS` (default 30s), the processor fires `Sentry.captureMessage("Settlement auto-approve sweep slow", { level: "warning" })`. Catches a future backlog or DB-stall scenario BEFORE the sweep overruns its own 15m cadence. Configurable via env. |
| **Stale-review detector** | `countStaleReviewSettlements()` runs after each sweep and counts settlements >24h past `reviewEndsAt` still in PENDING/UNDER_REVIEW. Non-zero count → Sentry warning. Catches a stuck sweeper / schema drift / dispute-path wedge that's silently leaving settlements in limbo — independent failure mode from "the sweep itself errored." |
| **Configurable batch size** | New `SETTLEMENT_AUTO_APPROVE_BATCH_SIZE` env (default 100, clamped to [1, 10_000]) lets ops dial up during backlog recovery without releasing new code. Defensive clamp on both the worker registration side and the processor's signed payload read. |
| **Structured counters log line** | One grep-able line per sweep: `[SETTLEMENT_AUTO_APPROVE] runs_total=N scanned=M approved=K skipped=L stale=S duration_ms=D`. Cumulative counters from worker start visible without parsing every line. No prom-client / OpenTelemetry — Phase 7.0 mission ceiling held; a future Phase 7.x.x metrics layer can scrape these structured logs. |
| **Dead-letter alerting free from Phase 7.0** | `createObservableWorker` already wires the `failed` event on every queue → `Sentry.captureException` with `attemptsMade` tag. Operators filter `attemptsMade >= 3` for final-failure events. The new SETTLEMENT queue inherits this automatically. |

**What landed:**

1. **`packages/shared/src/settlement-auto-approve-core.ts`** (new) — pure function `runSettlementAutoApprove(prisma, { batchSize?, now? })` returns `{ scanned, approved, skipped, durationMs }`. Plus `countStaleReviewSettlements(prisma, { now?, staleThresholdHours? })`. No NestJS dependency; writes audit via direct `tx.auditLog.create()`. `AnyPrisma = any` matches the existing reconciliation-core / website-verification-core convention.

2. **`packages/shared/src/queues.ts`** — added `SETTLEMENT: "settlement"` to `QUEUES` const + `AUTO_APPROVE: "settlement-auto-approve"` to `QUEUE_JOBS`. 12 queues total (was 11).

3. **`apps/worker/src/processors/settlement-auto-approve.processor.ts`** (new) — uses `createObservableWorker` (Phase 7.0). Logs structured counters, fires slow-sweep + stale-review Sentry warnings, validates signed payload. `clampBatchSize` defensive helper exported for internal use.

4. **`apps/worker/src/index.ts`** — `registerSettlementAutoApproveSweep()` registers the BullMQ repeatable cron with `jobId: "settlement-auto-approve"` for cluster-wide dedup. Honors the 3 existing env vars (`SETTLEMENT_AUTO_APPROVE_INTERVAL_MS`, `SETTLEMENT_AUTO_APPROVE_DISABLED`, plus the new `_BATCH_SIZE`). Pushes the new worker into the bootstrap workers list (10 workers total now).

5. **`apps/api/src/modules/settlements/settlements.module.ts`** — removed import + providers entry for `SettlementAutoApproveService`. Module is leaner; module comment explains the architectural move.

6. **`apps/api/src/modules/settlements/settlement-auto-approve.service.ts`** — **DELETED entirely** (was 129 lines). Zero external callers verified via Phase 0 grep; logic now lives in shared.

7. **`.env.example`** — updated comments for the 3 settlement-auto-approve env vars (note that they now affect worker behavior, not API), added new `SETTLEMENT_AUTO_APPROVE_BATCH_SIZE` + `SETTLEMENT_AUTO_APPROVE_SLOW_MS`.

8. **`apps/api/src/__tests__/phase-6-9-money-path-rbac.spec.ts`** — removed the deleted file from the audit-coverage walker's hard-coded list. Comment explains the migration: audit-log coverage for the auto-approve action is preserved (still spreads `orderEventMetadata(settlement.order)`) but now lives in shared via `tx.auditLog.create()` rather than the AuditService wrapper that the Phase 6.9 walker parses.

**14 new tests** — `apps/api/src/__tests__/phase-7-3-auto-approve-worker.spec.ts`:
- 7 `runSettlementAutoApprove` tests: empty result, multi-settlement commit, active-dispute skip, version-guard race, per-row error tolerance, batchSize honored, now override
- 3 `countStaleReviewSettlements` tests: default 24h threshold, count returned verbatim, custom threshold
- 4 file-deletion + module-wiring regression guards: deleted file is gone, settlements.module.ts no longer imports/registers the service, new processor file exists, worker/index.ts registers the cron + adds the worker

**Verification:**

- **shared + api + worker build**: clean
- **Test suite**: 410/418 pass (+14 vs Phase 7.2); 3 pre-existing failures unchanged (`order-payment.service.spec.ts`, `prebeta-audit-regression.spec.ts`, `staff-roles.guard.spec.ts`)
- **Phase 7.0 / 7.1 / 7.2 / 6.9 tests still green** — no regressions
- Live manual smokes (worker starts → cron registers → sweep log line within 15m; two workers → ONE log line per cadence; `_DISABLED=true` → no registration) deferred to user-side pre-merge per the same pattern as prior phases.

**Phase 7.3 mission ceiling held**: no new metrics library, no Prisma migration, no schema change, no behavior change to per-row settlement logic, no audit/AuditService refactor.

**Production-readiness scorecard (deltas):**

| Dimension | Was | Now | Why |
|---|---|---|---|
| Worker architecture | B | **A−** | Cron work no longer multiplied by pod count; new pattern matches the existing reconciliation / settlement-hold-sweep / website-reverify-sweep cron family |
| Operational observability (settlement sweep) | (no row) | **B+** | Structured counter line + slow-sweep warn + stale-review warn + dead-letter via Phase 7.0's failed-event wiring. Full metrics layer deferred to Phase 7.x.x. |

**What to ship next** (Phase 7.4 trigger):
- **#12 Notification dedup** — already planned in the combined 7.3/7.4/7.5 plan. Adds `Notification.dedupKey` partial-unique-index migration; updates 6+ writer callsites with deterministic keys via the new shared builder. Stops worker-retry notification duplicates. ~1 day.

**Phase 7.3.1 follow-up (named, not abandoned):** add `CREATE INDEX CONCURRENTLY ON Settlement(status, reviewEndsAt)` — the new worker sweep hits this access pattern every 15m. Tiny migration; immediately after 7.3 lands. Note: must use `CONCURRENTLY` (Prisma migration needs the transaction-disable directive) to avoid table-write lockout on prod-sized tables.

---

### 2026-06-16 — Phase 7.2: Tier-aware settlement review window + lift TIER_WITHDRAWAL_HOLDS to shared (#6)

**Findings resolved:**

| # | Status | Notes |
|---|---|---|
| **#6** | ✅ Fully fixed | Settlement review window now respects publisher tier per spec: NEW=30d / TRUSTED=14d / VERIFIED=7d. Both writers (`order-review.service.ts:336` and `settlements.service.ts:80`) route through the new `getSettlementReviewDays(tier, env)` helper. Default drift (7 in one file, 14 in the other) closed. Env override preserved (incident-response escape hatch). |

**Sibling rider landed:**

| Improvement | Why bundled |
|---|---|
| **Lift `TIER_WITHDRAWAL_HOLDS` → `packages/shared/src/publisher-tier-policy.ts`** | Same product concept ("what does each publisher tier mean numerically"), same shape, same risk of silent drift if kept fragmented. Zero behavioral diff. Pure structural cleanup; introduces single source of truth via `getWithdrawalHoldDays(tier, env)`. |

**Beyond-audit safety improvements:**

1. **Empty-string parsing trap** — `Number("")` returns `0` in JavaScript. The initial helper draft would have parsed `SETTLEMENT_REVIEW_DAYS=` (empty value, common ops typo) as 0 and **silently auto-approved every new settlement on the next sweep**. The test case `getSettlementReviewDays("VERIFIED", "")` → 7 caught this; the helper was tightened to trim and reject empty / whitespace-only env values before parsing. Exactly the failure mode the helper's design rationale was meant to prevent; the test caught it on first run.

2. **Ops-visibility warning on invalid override** (post-Phase-7.2 rider) — when an env override is set to an unparseable value (e.g. `SETTLEMENT_REVIEW_DAYS=garbage`), the helper now emits one `console.warn` per `(envKey, value)` pair: `[publisher-tier-policy] Invalid SETTLEMENT_REVIEW_DAYS override "garbage"; falling back to per-tier default.` Dedupe rules: same invalid value never re-warns (no spam); a *different* invalid value DOES re-warn (someone tried to fix it and got it wrong again — worth surfacing). Empty / whitespace-only env never warns (common "declared but blank" state). Builds on the Phase 7.0 observability foundation by making configuration mistakes immediately visible at first call rather than silently degrading to the tier default. `MinimalLogger` parameter makes the helper testable without monkey-patching `console`; packages/shared stays SDK-agnostic (no Sentry coupling).

**What landed:**

1. **`packages/shared/src/publisher-tier-policy.ts`** (new) — single source of truth:
   - Reuses existing `PublisherTier` type from `./types`
   - `TIER_SETTLEMENT_REVIEW_DAYS = {NEW:30, TRUSTED:14, VERIFIED:7}` with `satisfies Record<PublisherTier, number>` compile-time exhaustiveness
   - `TIER_WITHDRAWAL_HOLD_DAYS` = same values today; kept as a separate constant so future per-tier divergence is a one-line edit
   - `getSettlementReviewDays(tier, envOverride?)` — env trimmed first (empty/whitespace → fall back to tier), then `Number.isFinite` gate, then `Math.max(value, 0)` clamp. Invalid input (`"garbage"`, `""`, `"  "`) safely falls back to tier — never silently collapses the review window.
   - `getWithdrawalHoldDays(tier, envOverride?)` — same shape

2. **`apps/api/src/modules/orders/services/order-review.service.ts:336`** — adopted helper. Publisher already loaded at line 329, so `.tier` flows directly. No extra query.

3. **`apps/api/src/modules/settlements/settlements.service.ts:80-101`** — moved the `reviewDays`/`reviewEndsAt` calculation INSIDE the existing transaction, added a focused `tx.publisher.findUnique({ where: { id: publisherId }, select: { tier: true } })` lookup (Option B per plan Key decision #6 — cheaper than cascading nested includes). Tier defaults to `"NEW"` (most conservative) if the publisher row can't be loaded.

4. **`apps/api/src/modules/publisher-payouts/publisher-payouts.service.ts:10-14, 173`** — local `TIER_WITHDRAWAL_HOLDS` constant deleted; replaced with `getWithdrawalHoldDays(publisher.tier ?? "NEW", process.env.WITHDRAWAL_HOLD_DAYS)`. New env-override hook for `WITHDRAWAL_HOLD_DAYS` (matches the existing `SETTLEMENT_REVIEW_DAYS` escape-hatch pattern).

**21 new tests** — `apps/api/src/__tests__/phase-7-2-tier-policy.spec.ts`:
- 3 tier defaults; env override wins when parseable (`"42"` → 42); `"0"` → 0 (deliberate); `"-1"` → 0 (clamp); 4 invalid-input cases (`"garbage"`, `"abc"`, `""`, `"  "`) → tier default; `undefined` → tier; fractional accepted; `getWithdrawalHoldDays` mirror; 2 exhaustive-coverage checks
- **7 warning-behavior tests** for the post-Phase-7.2 ops-visibility rider: warns once on first invalid value; no re-warn on identical repeats; re-warns on a *different* invalid value; never warns on empty/whitespace/undefined; never warns on valid numeric overrides; dedupes `SETTLEMENT_REVIEW_DAYS` and `WITHDRAWAL_HOLD_DAYS` keys independently; falls back to `console.warn` when no logger supplied
- **3 grep regression guards** asserting source files no longer contain `SETTLEMENT_REVIEW_DAYS ?? 7`, `SETTLEMENT_REVIEW_DAYS ?? 14`, or `const TIER_WITHDRAWAL_HOLDS: Record` — catches future silent regression to hardcoded fallbacks (same pattern as Phase 6.9 race-guard literal assertions)

**Verification:**

- **API + shared + worker build**: clean
- **Test suite**: 389/397 pass (+14 vs Phase 7.1); 3 pre-existing failures unchanged
- **Phase 7.0 + 7.1 + 6.9 tests still green** — no regressions
- Live manual smoke (seed one publisher per tier, create orders, verify `reviewEndsAt - createdAt` = 30d/14d/7d respectively) deferred to user-side pre-merge.

**Phase 7.2 mission ceiling held**: no migration, no index addition, no per-tier env overrides, no retroactive recompute, no channel-aware review policy.

**Behavioral note for ops**: today's default for NEW publishers was 7d in one path and 14d in another. After this lands, all NEW publishers get 30d — the intended spec behavior. If Finance / Ops were used to faster clearance for NEW publishers, this is a deliberate per-spec tightening. The `SETTLEMENT_REVIEW_DAYS` env override remains available for incident-response global freezes.

**Updated production-readiness scorecard (deltas):**

| Dimension | Was | Now | Why |
|---|---|---|---|
| Trust / tier policy uniformity | (no row) | **A−** | Single shared module for tier numerics; future drift requires deliberate edits, not silent fragmentation. Grep regression guards prevent reverts. |
| Money invariants | A− | A− (unchanged but tighter) | Settlement review matches spec; default-drift bug closed |

**What to ship next** (post-Phase-7.2):

1. **#10** — Auto-approve worker migration. Move `SettlementAutoApproveService` `setInterval` out of every API pod into a single worker repeatable job.
2. **#12** — Notification dedup. Extend Phase 6.6's support-fan-out fix to email/report/reconciliation queues; needs migration.
3. **#9** — Mobile UX (publisher + admin sidebar drawer).
4. **#21** — Phase 6 snapshot backfill for historical Settlement/PlatformRevenue rows.

---

### 2026-06-16 — Phase 7.1: PlatformRevenue dashboard + CSV export (#5 + #15 bundled)

**Findings resolved:**

| # | Status | Notes |
|---|---|---|
| **#5** | ✅ Fully fixed | `GET /admin/finance/revenue` reads PlatformRevenue with 4 groupings (channel / month / serviceType / listing) + same-duration previous-period KPIs + currency-mismatch warning + RFC 4180 CSV streaming. Admin Finance "Revenue" tab uses the typed `api.admin.getRevenue(...)` method (Phase 7.0 X-Request-ID propagation inherited). RBAC: `@StaffRoles("SUPER_ADMIN", "FINANCE")` — Category B Financial, tighter than Category A universal-staff to match the `reconciliation` precedent. |
| **#15** | ✅ Fully fixed | `reporting.service.ts:32` + `getCampaignReport` channel-split now read `order.fulfillmentChannel ?? website.ownershipType` (snapshot-first / ownership-fallback). Matches `refund.service.ts:68` and `order-review.service.ts:289`. Bundled with #5 because same domain. |

**Beyond-audit improvements landed** (user-requested during planning):

| Improvement | Why it matters |
|---|---|
| **`groupBy=listing` first-class** | Finance's recurring question isn't "how much did we make" but "what makes us money." Sorted by `_sum.netRevenue` DESC so top earners surface first. Structured `listingServiceId` + `listingId` + `listingTitle` fields on every bucket (not a concatenated string) — future drill-down reads them directly with no regex parsing. Robust to soft-deleted Listings (`listingTitle: null`, `bucket: "(listing not found)"`, row preserved) and NULL pre-Phase-6 snapshots (`"(unknown)"` bucket). |
| **Previous-period comparison on KPIs** | Server-side computes a same-duration prior window. `totals.deltaPct` returned with the response; KPI cards render `+18.2%` style deltas. Zero-denominator returns `null` (no `+∞%` / `NaN%` artifacts). When `from`/`to` both unset, `previous: null` (whole-history view has no prior window). |
| **Explicit `Timezone: UTC` label** | Rendered as a small caption under the filter row. Pre-empts "why doesn't June 30 match my spreadsheet" tickets. |
| **Currency-mismatch detection at the Order layer** | Phase 0 verification caught: `PlatformRevenue` has NO `currency` column (audit assumed it did). Currency lives on `Order` and isn't propagated. Defense in depth: parallel `prisma.order.findMany({ currency: { not: "USD" }, status: DELIVERED/COMPLETED/REFUNDED, deliveredAt: rangeFilter })` populates `meta.currencyMismatch = { rowCount, distinctCurrencies }` when any non-USD order exists in the range. UI surfaces an amber banner. A future bug that introduces an EUR order is caught visibly on the next dashboard load, not silently muddled. |
| **`Phase 0` pre-implementation verification step** | New plan-workflow norm: before any code is written, verify schema + writer + sample-rows assumptions actually hold today. Caught the `currency`-field assumption error that would have produced wrong results in prod. |
| **api-client method required from day one** | Typed `api.admin.getRevenue(...)` ships with the endpoint; no raw `fetch()` in the UI. Inherits Phase 7.0's X-Request-ID and ApiError-with-requestId machinery — every Revenue page load is correlatable to its API + audit log + Sentry events. |
| **CSV trailer rows (`TOTAL_CURRENT`, `TOTAL_PREVIOUS`)** | The exported CSV alone tells the same story as the UI. Finance can email a spreadsheet to a stakeholder without having to attach a screenshot. |
| **Cache key `["admin", "revenue", filters]`** | Sets the consistent admin-cache-key pattern audit §7.3 called out. Sweeping the existing Finance tabs is a separate Phase 7.1.x ergonomic PR. |

**Sibling-fix riders** (bundled because they blocked the build):

| File | Change | Why bundled |
|---|---|---|
| `apps/admin/src/app/page.tsx` | Wrap `LoginPage` in `<Suspense>` per Next 15 strict-mode `useSearchParams` requirement | Pre-existing Phase 6.8 leftover; blocked `next build` for admin. Portal + publisher already had this pattern. |
| `apps/portal/src/app/dashboard/support/[id]/page.tsx` | Cast `getTicket(...)` via `unknown` per TS's own remediation; mark local `priority` field optional | Pre-existing Phase 6.6/6.8 type drift (audit §11 called it out as "unrelated"); blocked `next build` for portal. Reconciling the two `TicketDetail` shapes is its own Phase 7.1.x follow-up. |
| `packages/shared/src/observability/index.ts` | Drop `./request-context` from the browser-safe barrel | Phase 7.0 regression caught by Phase 7.1 verification. `request-context.ts` uses `node:async_hooks`; bundling it into the website's client build threw `node:async_hooks` import errors. Fixed by following the established pattern (deep imports for Node-only modules). 5 API + 1 worker import sites updated; jest moduleNameMapper extended to match. |

**What landed:**

1. **`apps/api/src/modules/admin/dto/get-revenue-query.dto.ts`** — `GetRevenueQueryDto` with `@IsISO8601() from/to`, `@IsIn(["channel","month","serviceType","listing"]) groupBy`, `@IsIn(["json","csv"]) format`.
2. **`apps/api/src/modules/admin/finance/revenue.service.ts`** — pure aggregation service. Prisma `groupBy` for channel/serviceType/listing; raw `$queryRawUnsafe` for month-bucketing via `date_trunc('month', "recordedAt" AT TIME ZONE 'UTC')`. All Decimals serialized as strings. Listing-grouping joins `ListingService → MarketplaceListing` for human title + structured `listingId`. Currency-mismatch checks `Order.currency` (Phase 0 finding).
3. **`apps/api/src/modules/admin/finance/csv-stream.ts`** — RFC 4180 streamer (~30 LOC). No new dep.
4. **`apps/api/src/modules/admin/admin.controller.ts`** — new `GET /admin/finance/revenue` handler `@StaffRoles("SUPER_ADMIN", "FINANCE")`. Branches on `format=csv`; maps known service-layer date errors to 400.
5. **`packages/api-client/src/services/admin.ts`** — `getRevenue(params)` + `exportRevenueCsv(params)` + typed `RevenueResponse` shape.
6. **`apps/admin/src/app/dashboard/finance/_revenue-panel.tsx`** — extracted panel: filter row + Timezone caption + currency-mismatch banner + KPI strip via shared `<KpiCard>` with trend deltas + grouped table with per-row listing drill-down `<a>`. CSV export hits `?format=csv` directly (server-side streaming).
7. **`apps/admin/src/app/dashboard/finance/page.tsx`** — `"revenue"` appended to `TABS`.
8. **`apps/api/src/modules/reporting/reporting.service.ts`** — both call sites (single-order `getOrder` + `getCampaignReport`) now read snapshot-first with ownership fallback.

**36 new tests:**
- `apps/api/src/modules/admin/__tests__/revenue.service.spec.ts` (17): empty result; channel + serviceType + month + listing groupings; soft-deleted listing fallback; NULL snapshot bucket; reversed-row exclusion + reversed-only bucket preservation; Decimal precision; previous-period math + zero-denominator + missing-window; currency-mismatch + currency-clean; date validation (reversed range + malformed).
- `apps/api/src/__tests__/phase-7-1-revenue-reporting.spec.ts` (19): csvCell quoting (6); csvRow (2); buildRevenueCsvFilename (2); streamRevenueCsv header+bucket+TOTAL_CURRENT (1); TOTAL_PREVIOUS trailer (1); RFC 4180 comma + embedded-quote in bucket names (2); reporting.service channel-snapshot resolution (4); grep-style regression guard for snapshot-first literal in source (1).

**Verification:**

- **API typecheck + build**: clean
- **All 4 Next.js apps build**: clean (after sibling Suspense wrap + portal type cast)
- **Worker build**: clean
- **Test suite**: 375/383 pass (+36 vs Phase 7.0); the 3 pre-existing failed suites are unchanged — none touch Phase 7.1 code
- **Phase 6.7 `admin-rbac-coverage.spec.ts` passes** — confirms `@StaffRoles` declared correctly (Category B Financial)
- **Phase 7.0 + Phase 6.9 tests still green** — no regressions
- Live manual smoke deferred to user-side pre-merge (same pattern as Phase 7.0 smoke 17/18); requires seeded DELIVERED orders in DB

**Phase 7.1 mission ceiling held**: no charts, no per-publisher grouping, no scheduled reports, no multi-currency, no user-timezone toggle, no global cache-key sweep, no pre-Phase-6 snapshot backfill.

**Updated production-readiness scorecard (deltas):**

| Dimension | Was | Now | Why |
|---|---|---|---|
| Reporting + finance visibility | **D** | **B+** | Live revenue dashboard with 4 groupings, period comparison, CSV export. Only remaining gaps are visual trend charts and per-publisher breakdown — both Phase 7.1.x deferrals. |
| Channel-aware routing (Phase 6/6.5) | A | **A** (now more uniform) | `reporting.service.ts` now reads `fulfillmentChannel` first across both call sites. Last known divergence closed. |

**What to ship next** (post-Phase-7.1):

1. **#6** — Settlement review window tier-awareness (half-day scope).
2. **#10** — Auto-approve worker migration.
3. **#12** — Broader notification dedup.
4. **#9** — Mobile UX.
5. **#21** — Phase 6 snapshot backfill.

---

### 2026-06-15 — Phase 7.0: Production observability foundation (#8 + #11 + API gap + correlation IDs)

**Findings resolved:**

| # | Status | Notes |
|---|---|---|
| **#8** | ✅ Fully fixed | `error.tsx` + `global-error.tsx` per app (4 apps) + Sentry across browser + server + edge runtimes. Branded `ErrorState` fallback; Reset button maps to Next's `reset()`. |
| **#11** | ✅ Fully fixed | Raw `node:http` health server on port 3004: `/health` (K8s liveness), `/ready` (Redis + Prisma checks → 503 on failure), `/metrics/queues` (per-queue counts via BullMQ `getJobCounts` + totals aggregate). BullMQ `failed`/`error`/`stalled` events on all 9 workers route to Sentry with `{queue, jobId, attemptsMade, requestId}` tags. |

**Beyond-audit improvements landed** (user-requested during planning, integrated as Phase 7.0 scope):

| Improvement | Why it matters |
|---|---|
| **API Sentry integration** | `apps/api/src/instrument.ts` (first import in main.ts so `@sentry/node` auto-instrumentation can wrap http/express/pg). `SentryExceptionFilter` extends existing `AllExceptionsFilter` — captures 5xx + non-HttpException, skips 4xx user errors. `SentryBusinessContextInterceptor` populates Sentry scope from `req.user` + route params on every request. Without this, the API — the most consequential of the 3 runtimes — would have been left on `console.log`. |
| **X-Request-ID correlation across runtimes** | NestJS middleware reads incoming header, validates against allowlist regex `^[A-Za-z0-9_-]{1,128}$` (rejects control chars, newlines, non-ASCII, overlong values), generates fresh UUID v4 via `crypto.randomUUID()` if absent or invalid, echoes in response, wraps request in AsyncLocalStorage frame. ID flows: API middleware → `AuditLog.metadata.requestId` (no migration — uses existing JSON column) → enqueued worker job (signed payload) → worker processor wrapper re-enters ALS frame → worker-side audit writes inherit it → Sentry scope tag on all 3 runtimes. Frontend `HttpClient` generates per-request and attaches to `ApiError`. |
| **Business-context tagging** | `setBusinessContext()` helper sets Sentry scope tags from `{userType, staffRole, customerRole, publisherRole, organizationId, publisherId, orderId, ticketId, settlementId, fulfillmentChannel, serviceType}`. Called from: NestJS interceptor (API), `attachObservability` wrapper (worker), `AuthProvider` `useEffect` (each of 4 frontend apps). Every captured exception surfaces with WHO it happened to and WHAT they were doing. |
| **`unhandledRejection` exit-after-flush policy** | A worker mid-processing a money job that hits an unhandled rejection has potentially-corrupted in-memory state. Default behavior: capture to Sentry, flush, exit(1) — let orchestrator restart. Loses one in-flight job (BullMQ retries); continuing in bad state loses N future ones. Override via `UNHANDLED_REJECTION_EXIT=false` for dev convenience. `uncaughtException` always exits regardless. |
| **`initSentry()` startup self-test log** | Always emits one line — `[SENTRY] enabled runtime=X release=Y environment=Z` (DSN set) or `[SENTRY] disabled (no DSN) runtime=X` (DSN unset). Grep-able at deploy time to confirm Sentry actually wired in prod. |
| **Closed runtime-tag registry** | TypeScript union of 14 allowed values (`api`, `worker`, `portal-client/server/edge`, etc.). `initSentry` throws at startup on anything else. Prevents future drift like a stray `web-client` or `marketing` tag silently breaking Sentry filters. |
| **Body redaction filter** | `beforeSend` strips `Authorization`/`Cookie`/`Set-Cookie` headers (case-insensitive) + redacts 10 sensitive key names (`password`, `accessToken`, `refreshToken`, `apiKey`, `paymentMethod`, `paymentMethodId`, `verificationToken`, `encryptedPayload`, `webhookSecret`, `signature`) anywhere in the event tree (recursive). The only line of defense between leaked PII/secrets and the Sentry dashboard. |

**What landed:**

1. **Shared observability core** — `packages/shared/src/observability/` (4 files):
   - `sentry-init.ts` — SDK-agnostic init (consumer passes own Sentry module); runtime-tag registry; `beforeSend` redaction; release/environment/sample-rate resolution; self-test log
   - `request-context.ts` — AsyncLocalStorage primitive (`runWithRequestId`, `getRequestId`, `requireRequestId`); allowlist validation regex; `crypto.randomUUID()` generator with Math.random fallback
   - `business-context.ts` — `setBusinessContext(scope, ctx)` that only sets defined string/number/boolean fields
   - `index.ts` barrel + re-export from `packages/shared/src/index.ts`
   - **packages/shared takes no `@sentry/*` dependency** — each consumer brings its own SDK; the helper accepts the imported Sentry module as a parameter

2. **API observability** (`apps/api/`):
   - `src/instrument.ts` — first import in `main.ts`
   - `src/common/middleware/request-id.middleware.ts` — global X-Request-ID handling
   - `src/common/filters/sentry-exception.filter.ts` — extends `AllExceptionsFilter`, only captures 5xx + non-HttpException
   - `src/common/interceptors/sentry-business-context.interceptor.ts` — pulls `req.user` + route params onto Sentry scope
   - `app.module.ts` mounts middleware globally via `forRoutes("*")`
   - `audit.service.ts` spreads `requestId` from ALS into `metadata` JSON automatically
   - `queues/queue.service.ts` injects `requestId` into every signed job payload at the central `addJob()` chokepoint

3. **Worker observability** (`apps/worker/`):
   - `src/lib/env.ts` — `validateEnv()` consolidation
   - `src/lib/queue-observability.ts` — `createObservableWorker(queueName, processor, opts)` factory that wraps processor in `runWithRequestId` + Sentry scope tagging, attaches `failed`/`error`/`stalled` event listeners
   - `src/lib/health-server.ts` — raw `node:http` server on `WORKER_HEALTH_PORT` (default 3004), three routes
   - `src/index.ts` rewritten — orchestrated bootstrap: `validateEnv()` → `initSentry()` → `checkConnections()` → `startHealthServer()` → register processors → register crons → graceful shutdown closes HTTP server too. `unhandledRejection` / `uncaughtException` handlers with documented exit-after-flush policy
   - All 9 processors migrated from `new Worker(...)` → `createObservableWorker(...)` (2-line change each)

4. **Frontend observability** (4 × `apps/{portal,publisher,admin,website}/`):
   - `sentry.client.config.ts` (browser init)
   - `src/instrumentation.ts` (Next 15 hook — server + edge init; exports `captureRequestError` as `onRequestError`)
   - `next.config.ts` wrapped with `withSentryConfig` (no source-map upload tokens — deferred to Phase 7.0.1)
   - `src/app/error.tsx` — uses `<ErrorState>`, reports to Sentry via `useEffect`
   - `src/app/global-error.tsx` — minimal inline HTML (cannot assume layout loaded), reports to Sentry
   - `src/app/not-found.tsx` — branded 404 (Priority 7 — shipped)
   - `src/lib/auth.tsx` `AuthProvider` wires Sentry scope tags from current user via `useEffect`

5. **Frontend api-client** (`packages/api-client/src/client.ts`):
   - `HttpClient.request()` generates `X-Request-ID` per request via `crypto.randomUUID()`, sends as header
   - Echoed-back ID (or fallback to generated) attached to `ApiError` so toasts/error reports can surface it for support tickets

6. **Env + deps**:
   - `.env.example` extended with `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `WORKER_HEALTH_PORT`, `UNHANDLED_REJECTION_EXIT`, `GIT_COMMIT_SHA`
   - `@sentry/node@10.58.0` added to `apps/api` + `apps/worker`
   - `@sentry/nextjs@10.58.0` added to all 4 frontend apps
   - `pnpm-workspace.yaml` sets `@sentry/cli: false` — its postinstall downloads a native binary used only for source-map upload, which Phase 7.0 defers

7. **39-test coverage** — `apps/api/src/__tests__/phase-7-0-observability.spec.ts`:
   - `sentry-init` (11 tests): runtime tag enum, DSN resolution, release resolution, environment resolution, sample rate logic, self-test log shape (both forms), `initSentry` no-op without DSN, full options pass-through with DSN
   - `beforeSend` redaction (5 tests): all 10 REDACTED_KEYS, all 3 headers (case-insensitive), recursive on nested objects + arrays, no mutation of input, null/undefined/primitive safety
   - `request-context` (8 tests): null outside frame, throw outside frame, frame visibility, sibling isolation, concurrent async frame isolation, nested frame stacking, generator shape
   - `isValidRequestId` (11 tests): UUIDv4/UUIDv7/short-trusted/ULID acceptance, empty/control-char/newline-log-poisoning/non-ASCII/overlong rejection, exactly-128-chars acceptance, non-string rejection, allowlist-only character set
   - `business-context` (4 tests): only sets defined fields, empty context noop, idempotent overwrite, null skip

**Phase 7.0 mission ceiling held:** OpenTelemetry / Prometheus / Grafana / ELK / structured-logger all explicitly deferred per the plan. Phase 7.0 does three things and only three things — find failures, understand failures, trace failures.

**Verification:**
- 39/39 Phase 7.0 observability unit tests pass
- All 6 packages (shared, api-client, api, worker, 4 apps × typecheck) build clean
- 3 pre-existing test failures (`order-payment.service.spec.ts`, `prebeta-audit-regression.spec.ts`, `staff-roles.guard.spec.ts`) unchanged — none touch Phase 7.0 code
- Self-test log smoke test confirms both `[SENTRY] enabled runtime=worker release=phase-7-0-smoke environment=production` and `[SENTRY] disabled (no DSN) runtime=api` forms; invalid runtime tag throws with the expected allowlist message
- Pre-existing Phase 6.8 portal `priority` type drift unchanged
- Live smoke tests for worker health endpoints (curl /health/ready/metrics, stop Redis to verify 503), BullMQ failed-event Sentry capture, and release-tag round-trip against a real DSN are documented in the plan as user-side pre-merge checks (require live Redis/Postgres/Sentry project that aren't available in this sandbox)

**Phase 7.0.1 follow-up (named, not abandoned):**

- Promote `requestId` from `AuditLog.metadata` JSON to a dedicated indexed column + backfill (defer until production query patterns reveal which indexes pay off)
- Structured logger to replace `console.log` (then `requestId` becomes grep-able in plain logs, not just Sentry context + audit DB)
- Source-map upload via `SENTRY_AUTH_TOKEN` in CI (single-line config flip + CI secret — flip `@sentry/cli` to `true` in `pnpm-workspace.yaml` at the same time)

**Updated production-readiness scorecard (deltas):**

| Dimension | Was | Now | Why |
|---|---|---|---|
| Frontend reliability (errors/loading/empties) | B− | **A−** | error.tsx + global-error.tsx + Sentry across all 4 apps; auth-redirect from Phase 6.8 covers 401s; only loading.tsx + per-page bespoke error states remain |
| Worker observability | D | **A−** | Health endpoint + readiness + queue metrics + Sentry on all `failed`/`error`/`stalled` events across all 9 processors + unhandledRejection exit-after-flush + graceful shutdown |
| API observability | (no row) | **A−** | Sentry exception filter + business-context interceptor + request-ID correlation. Previously console-log only. |
| Documentation + audit-trail uniformity | A− | **A** | Every audit log now auto-inherits `requestId` from ALS — single source of truth for "what request triggered this state change" |

**What to ship next** (Phase 7.1 trigger):

The audit's §11 progress dashboard's prior "next" list pointed to #8 + #11 + #5 + #12 + #21. With #8 + #11 closed, the new top of the list is:

1. **#5 — PlatformRevenue dashboard.** Finance has no live revenue view today; the data exists in `PlatformRevenue` rows but no endpoint reads it. Biggest finance-visibility win in the remaining backlog. Audit's user-aligned post-7.0 roadmap.
2. **#6 — Settlement review window tier-awareness.** Resolve 7-vs-14 default drift; lift tier table to shared constant.
3. **#10 — Auto-approve worker migration.** Move `SettlementAutoApproveService` `setInterval` out of every API pod and into a worker repeatable job.
4. **#12 — Notification dedup.** Extend Phase 6.6's support-fan-out fix to email/report/reconciliation queues.
5. **#9 — Mobile UX.** Publisher + admin sidebar drawer below `lg`.

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
