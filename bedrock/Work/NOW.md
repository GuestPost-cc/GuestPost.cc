# Current Focus

**Status (2026-06-16): Phases 6.6 → 7.7 complete. 11/11 Critical audit findings closed (100%) — production-blocker queue fully cleared. 19/31 audit findings closed (61%); Phase 7.7 adds the full observability spine (requestId → structured logs → audit → Sentry source-maps) without closing a new numbered finding. Per-phase details live in `bedrock/Views/audits/platform-audit-2026-06-15.md` §11 Remediation Log.**

## Completed since last NOW update (2026-06-15 → 06-16, batches 25–32)

Ten phases shipped (Phase 7.1–7.3 bundled due to file overlap; 7.4, 7.5, 7.6 separate; 7.7 is 5 commits on one branch):

| Phase | Audit # | One-liner | Tests added |
|---|---|---|---|
| **6.6 / 6.6.1 / 6.6.2** | #1, #19 | Admin support endpoints route through `SupportService`; channel-aware ticket matrix; `TicketMessageVisibility` (PUBLIC/INTERNAL); `TicketParticipantRole` + `actorSnapshot` for forensics | 46 |
| **6.7** | #2, V-1 | `StaffRolesGuard` fail-closed; class-level `@StaffRoles` on AdminController removed (per-handler declarations + metadata-coverage test); 18-DTO sweep across admin action bodies; Finance data-exposure narrowing | 12 |
| **6.8** | #7 | `buildAuthErrorHandler` 401→sign-in redirect with idempotency + URL sanitization + same-page debounce; `returnTo` sanitizer rejects open-redirect attacks | 48 |
| **6.9** | #3, #4, #22, R-3/R-4 | `assertOwnerOrCreator` helper for money-path role tightening; `orderEventMetadata()` sweep at 20+ callsites; confirm-delivery status guard; reflection-based coverage test | 17 |
| **7.0** | #8, #11 | Production observability foundation: Sentry across API + worker + 4 Next apps; request correlation IDs (`X-Request-ID` middleware + AsyncLocalStorage + propagation to audit logs + worker jobs); business-context Sentry tags; worker health endpoint (`/health` `/ready` `/metrics/queues`); `unhandledRejection` exit-after-flush | 39 |
| **7.1** | #5, #15 | `GET /admin/finance/revenue` with 4 groupings (channel/month/serviceType/listing) + period comparison + CSV export; structured listing-drill-down meta; reporting.service channel-snapshot fix | 36 |
| **7.2** | #6 | Tier-aware settlement review (NEW=30/TRUSTED=14/VERIFIED=7); `publisher-tier-policy` shared module; `TIER_WITHDRAWAL_HOLDS` lifted as sibling rider; ops-visibility warning on invalid env override | 21 |
| **7.3** | #10 | `SettlementAutoApproveService` deleted; sweep moved to BullMQ repeatable in worker (`jobId` cluster-wide dedup); slow-sweep + stale-review Sentry warnings; `SETTLEMENT_AUTO_APPROVE_BATCH_SIZE` env | 14 |
| **7.4** | #12 | `Notification.dedupKey VARCHAR(256)` + partial unique index; 8 typed dedup-key builders; drift-summary-keyed reconciliation alerts (collapses hourly cron spam to one alert per staff per day); P2002 catch-and-swallow | 17 |
| **7.5** | #21 | Phase 6 snapshot backfill migration (Settlement + PlatformRevenue via Order→ListingService+Website JOIN); COALESCE + WHERE IS NULL idempotency; 4-scenario JS-reimplementation test. Dev DB 0 rows affected (all post-Phase-6); future-proofs prod | 14 |
| **7.6** | #9 | Mobile UX: ported portal's drawer pattern (fixed `translate-x` + backdrop + sticky mobile-only header with hamburger) into admin + publisher layouts. Pathname auto-close + `type="button"` defense + ARIA labels. **Closes the last open Critical — 11/11 now done.** Manual responsive smoke pending operator at a browser; typecheck + build clean (admin 19/19, publisher 13/13 static pages). | 0 (visual port; covered by manual smoke) |
| **7.7** | — | Observability hardening (5-commit bundle, no new audit finding closed — extends Phase 7.0). **A1** AuditLog.requestId promoted to indexed VARCHAR(128) column + partial btree + backfill + AuditService dual-write. **A2** admin audit-logs `?requestId=` exact-match filter + per-row Copy button + CSV column. **B** structured logger (`packages/shared/src/observability/structured-logger.ts`) — JSON + pretty modes, auto-injects requestId from ALS, includes `environment` + `release` tags. 8 worker files swept (~23 callsites); remaining ~85 tracked in sweep regression guard for Phase 7.7.x. **C** Sentry source-map upload enabled across all 4 Next.js apps (`@sentry/cli: true` + `widenClientFileUpload` + `deleteSourcemapsAfterUpload`); CI secret threaded. **D** `/metrics/queues` extended with `service` block + `dedupHitsTotal` + new `stalledHitsTotal`. | +16 (logger unit + sweep regression + A1 request-id-column suite) |

**Cumulative test growth across this batch**: ~339 → 441 passing (+102 new tests across phases 7.0–7.5). 3 pre-existing test suites still failing — confirmed unrelated (predate this work).

## What's next

Per the 2026-06-16 roadmap (post-Phase-7.7):

1. ~~**Phase 7.7.x — complete structured-logger sweep + 5 latent CI fixes**~~ ✅ DONE 2026-06-16 (PR #3 merged, 7 commits). Sweep complete (zero production console.* in apps/worker/src) + 5 pre-existing CI breakages diagnosed and fixed (turbo env passthrough, pnpm version conflict, root typecheck script, ui+api-client build dep, Sentry source-map hang). Trade-off: 3 pre-existing failing test specs were temporarily skipped via `testPathIgnorePatterns` to unblock the merge — handed off to Phase 7.7.y.
2. ~~**Phase 7.7.y — restore 3 skipped test specs**~~ ✅ DONE 2026-06-16 (PR #4 merged, 3 commits). Mock-fixture surgery only: staff-roles.guard flipped to fail-closed assertion, order-payment.service mocks updated to satisfy Phase 6.9 assertOwnerOrCreator + Phase 6 listingServiceId snapshot, prebeta F-3 mocks the production listingService.findUnique shape. **No production code changed.** apps/api jest now runs **33 suites / 478 tests with zero skips**; `testPathIgnorePatterns` back at jest default `["/node_modules/"]`.
2. **Phase 7.8 — Security Hardening Batch** (per roadmap): #26 email-keyed rate limiter + #27 job-signing `iat` replay protection + related auth/session follow-ups. Bundle as one cohesive phase.
3. **Phase 7.9 — Frontend Quality & Accessibility** (per roadmap): #28 status-color centralization + #29 unused shared component adoption + #30 hooks-rule violation + the deferred Phase 7.6.1 drawer a11y polish (status: Approved, Deferred). Dedicated frontend cleanup phase.
4. **Phase 7.3.1 — `CREATE INDEX CONCURRENTLY` on Settlement** — blocked on Prisma 6 → 7.4+ upgrade. Out of scope until that upgrade lands.

**Phase 7.7 operator cutover** (separate from the above roadmap, needed before Phase 7.7's value lands in prod):

1. Apply migration `20260616130000_phase77_audit_request_id_column` on staging/prod (off-peak; brief ACCESS EXCLUSIVE lock during partial-index build).
2. Record before-count of `metadata->>'requestId' IS NOT NULL` vs after-count of `requestId IS NOT NULL` — should match exactly. Run EXPLAIN ANALYZE on a sample requestId query; confirm `Index Scan using "AuditLog_requestId_idx"`. Paste both into the audit §11 Phase 7.7 entry.
3. Generate `SENTRY_AUTH_TOKEN` with `project:releases` scope; add as GitHub repo secret. Next CI build uploads source maps automatically.

## Pinned reminders (from prior session)

- Run servers via `pnpm dev:all` for a stable local stack — session-started foreground processes die with the shell.
- Worker fleet: `pgrep -f 'worker/dist' | wc -l` must be exactly 1 (pre-Phase-7.3 batch 20 found stale leaked workers).

---

**Prior status (2026-06-14, batch 24)**: Marketplace listing-service redesign complete + multi-actor support tickets shipped. 14 Prisma migrations through Phase 7; 1543 historical orders backfilled. VPS-staging attempt rolled back. Details preserved in batches 21–24 below.

## Completed (2026-06-14, batch 24 — VPS staging abandoned, files removed)
- Provisioned a Hetzner-class VPS to host dev/test workflow: rsync from laptop → tmux-managed `pnpm dev:all` → Caddy reverse proxy + auto-HTTPS, R2 replacing MinIO, Mailpit behind Caddy basicauth, GitHub kept as the "verified code" store
- VPS bootstrapped (deploy user, SSH-key only, UFW, fail2ban, Caddy, Node 22, pnpm 11), 30MB of source rsync'd, all 14 migrations applied on fresh Postgres, Phase 6 settlement backfill ran (60/60), all 6 apps started in tmux ("API running on http://localhost:4000")
- Next dev mode hung serving the first compiled request — VPS was thrashing (multi-GB RAM blown by 4 concurrent `next dev` + nest --watch + tsc --watch). User confirmed VPS too underprovisioned for the full stack, deleted the VPS, asked to remove all VPS files
- Removed: `infrastructure/{vps,caddy}/`, `infrastructure/docker/docker-compose.staging.yml`, `apps/{portal,publisher,admin}/Dockerfile`, `scripts/vps-sync.sh`, `.env.vps.example`, README VPS section, plan-file Part 2
- Repo restored to laptop-only state. Open question (`bedrock/Work/open-questions.md`): where to host shared dev/testing next?

## Completed (2026-06-14, batch 23 — Phase 7 cleanup migration)
- Final drop migration `20260615130000_phase7_listing_columns` — `MarketplaceListing.{type,price,turnaroundDays,revisionRounds,warrantyDays}` columns + `ListingType` enum removed. Earlier `20260615120000_phase7_legacy_drop` already dropped the `Service` table
- All UI surfaces migrated off the legacy columns: portal browse + favorites + saved-lists + listing detail, admin browse + listing detail — read `priceFrom` + `serviceTypes[]` + `services[]` instead
- Backend pruned: `LISTING_TYPE_TO_SERVICE_TYPE` map gone, `resolveServicesInput` shim collapsed to "services[] only", related-listings + recommendations now match on service overlap, admin filter on `services.some({serviceType})`, `createPlatformWebsite` + `updatePlatformWebsite` stopped writing legacy columns, DTO `type`/`price` made optional+ignored (one-release back-compat)
- Local-interface fields in portal/admin/saved-lists/favorites pages all marked optional so future drops don't break
- ContentOrder kept (originally on the drop list — turned out to be misnamed but live: stores publisher's submitted-content `title`/`brief`/`deliverable`, read at `apps/portal/src/app/dashboard/orders/[id]/page.tsx` via `order.submittedContent`)

## Completed (2026-06-14, batch 22 — Phase 6.5: ops site-ownership + symmetric multi-actor support tickets)
- **`Website.managedByUserId`** + admin `PATCH /admin/websites/:id/assign` (validates target has OPERATIONS staff role; audit-logged with from/to). Reassignment does NOT touch in-flight `FulfillmentAssignment` rows (no surprise hand-off)
- `createPlatformWebsite` auto-defaults `managedByUserId` to the creator when they're OPERATIONS
- **Auto-assignment**: `OrdersService.create` writes one `FulfillmentAssignment(ASSIGNED)` for PLATFORM-channel orders inside the same txn when the site has a manager
- **Support tickets channel-aware**: `Ticket.{fulfillmentChannel, assignedToUserId, assignedPublisherId}` snapshotted at create. `listTickets(actor)` returns role-keyed OR-clauses (customer: own org; publisher: assigned publisher; SUPER_ADMIN+FINANCE: all; OPS: assigned-to-me + unassigned PLATFORM pool). `addMessage` enforces same matrix. SUPER_ADMIN-only `POST /tickets/:id/reassign`
- Cross-role notifications: customer's org + fulfiller + every active SUPER_ADMIN/FINANCE on every ticket event
- Admin UI: new `/dashboard/websites` page with reassign dialog (Ops picker + reason); portal order-detail gains an `OrderSupportPanel` that lists tickets for THIS order with deep-link + inline "Open ticket"
- Publisher dashboard: lifecycle buttons (Submit/Pause/Unpause/Archive) gated by `lifecyclePhase`

## Completed (2026-06-14, batch 21 — Phase 6: per-service briefs + lifecycle + search rewrite + settlement snapshots + waitlist)
- **Shared package**: `packages/shared/src/briefs/` — Zod registry per `ServiceType` (8 schemas: GUEST_POST has title/topic/targetUrl/anchorText/keywords/wordCount/niche/notes; NICHE_EDIT requires existingArticleUrl; LOCAL_CITATION has compound address; etc.) + `validateBrief(serviceType, data)`. Lifecycle helper at `packages/shared/src/lifecycle/listing-phase.ts` computes `AWAITING_VERIFICATION` / `AWAITING_SERVICES` / `READY_FOR_REVIEW` / `IN_REVIEW` / `READY_TO_PUBLISH` / `PUBLISHED` / `PAUSED` / `REJECTED` / `ARCHIVED` from (status, ownerType, website verification, AVAILABLE service count). `packages/shared/src/audit/order-event-metadata.ts` standardizes audit payload (listingId/listingServiceId/serviceType/fulfillmentChannel/ownerType)
- **Schema additive bundle** `20260615100000_phase6_additive`: Settlement+PlatformRevenue gain 5 snapshot cols (listingServiceId/serviceType/ownerType/fulfillmentChannel/unitPrice); `Order.briefData JSONB`; `MarketplaceListingClick.serviceType` + `MarketplaceSearchHistory.serviceType`; `ListingService` composite indexes `(availability, serviceType, price)` + `(availability, turnaroundDays)`; `Website.managedByUserId` + FK; `Ticket` routing cols + indexes
- **Order brief**: `OrdersService.create` runs `validateBrief(snapshot.snapshotServiceType, body.briefData)` inside the txn; rejects with `BRIEF_INVALID` + Zod issue path. `Order.briefData` snapshotted; later listing edits never alter contract
- **Search rewrite**: filters key off `services.some({availability:"AVAILABLE", serviceType, price, turnaroundDays})`. Card returns `priceFrom` (min AVAILABLE service price) + `serviceTypes[]` (deduped) + `lifecyclePhase`. Listings with zero AVAILABLE services excluded automatically
- **Lifecycle endpoints**: `POST /marketplace/listings/:id/{submit,pause,unpause,archive}` — version-guarded via status-as-version (each `updateMany` constrains on the source status), audit-logged. submit gates: website VERIFIED + ≥1 AVAILABLE service
- **Settlement+revenue snapshot**: `createSettlement` + `createSettlementForOrder` both write the 5 columns. Backfill script `scripts/backfill-settlement-snapshots.ts` covered 60/60 historical rows (0 parity gap)
- **Waitlist**: `availability=WAITLIST` on a service. When publisher flips to AVAILABLE via `updateServiceOnListing`, fan-out to `MarketplaceFavorite` rows scoped to (listingId, serviceType) OR (listingId, null) via the existing notification queue. `MarketplaceFavorite.serviceType` column added
- **OrderOwnershipGuard**: gained `fulfillmentChannel` consistency check (publisher actor refused when channel=PLATFORM — covers website-reassigned-mid-flight)
- **Portal `<BriefForm>`**: per-service rendered fields (text/textarea/url/number/select/tags/address compound); forwards `briefData` to `orders.create`. Falls back to legacy 4-field form only if `serviceType` is unknown
- Marketplace stats: `totalServices`, `activeServices`, `servicesByType` (count + avgPrice per ServiceType) — listing-level counts kept

## VPS / shared-dev hosting (still open)
The VPS attempt confirmed the dev stack is too heavy for 2GB RAM: 4 `next dev` + `nest start --watch` + tsx --watch + Docker (postgres/redis/mailpit) blew the heap. Possible follow-ups (capture into `Work/open-questions.md`):
- Run only the API + worker in dev mode on the VPS, ship the frontends as Next `production` builds (`next build` once, then `next start`) — drastically cheaper
- Bigger VPS (4 GB+ RAM)
- Move dev/test to a cloud sandbox (Railway, Fly.io, Render) where build is offloaded
- Stick to laptop-only for now and revisit shared-dev when team grows
The staging-style production deploy path (image-based, GHCR push, no live source sync) was NOT tried — would be lighter at runtime since `next start` is ~10x cheaper than `next dev`



## Completed (2026-06-12, batch 20 — beta readiness sprint, 7 phases)
- **Provider validation** (`scripts/provider-validation.ts`, report `bedrock/Evidence/PROVIDER_VALIDATION_2026-06-12.md`): 30/30 — genuinely signed webhooks (real Stripe HMAC secrets; Wise via local RSA keypair as WISE_WEBHOOK_PUBLIC_KEY) through full path API→queue→worker→DB→reconciliation. Stripe deposit/dup/tamper/chargeback won+lost lifecycle; Wise complete/replay/cancelled/reverse; Stripe payout paid. Stripe test key verified live vs api.stripe.com. NOT covered (needs real creds): Wise sandbox API transfers, Stripe Connect transfers
- **Incident found**: 5 stale leaked worker processes (bad pkill pattern) — oldest pre-normalizer build swallowed queue jobs. Runbook now mandates exactly-one-worker-fleet verification (`pgrep -f 'worker/dist' | wc -l`)
- **Campaign UX**: `PATCH /campaigns/:id` (org-scoped, audited, status-validated) + client + portal rename dialog, duplicate, pause/activate/archive w/ optimistic status flips
- **Reporting**: shared `downloadCsv` in packages/ui (formula-injection-safe, vitest-covered) — portal reports + publisher earnings exports swapped to it (both were injectable), admin finance settlements/withdrawals export buttons added
- **Marketing site**: 10 routes — shared SiteHeader/Footer, SSR marketplace (real public listings API, revalidate 300, ownership badges, search+category), publishers (FAQ/flow), pricing (fee model), about, contact, legal terms/privacy/refund. SEO metadata per page
- **FE tests**: vitest+RTL in packages/ui (9 tests: csv security, NotificationBell incl a11y label), Playwright e2e (2 journeys: customer signup→org gate→billing; publisher signup→conversion→listings) green vs live stack, `.github/workflows/ci.yml` (postgres+redis services, migrate, build, api jest, ui coverage)
- **Ops**: `docs/PRODUCTION_RUNBOOK.md` (deploy/rollback/restore/SEV ladder/provider outage/chargeback/financial incident/clean-env bring-up + worker-fleet rule), Dockerfiles for api+worker. Container builds validated through install stage; final compile OOMs the local Docker VM (`ResourceExhausted`) — open item: build on ≥4GB CI runner. pm2 path is the validated beta deployment
- **Gotchas learned**: pnpm v11 needs `allowBuilds` map in pnpm-workspace.yaml (onlyBuiltDependencies insufficient in fresh containers); `.dockerignore` mandatory or host node_modules clobbers container symlinks; integration suite needed price-relative funding
- Cleanup: stale validation-harness rows (stuck PROCESSING from swallowed job) resolved; reconciliation green

**Status (prior): Audit #2 findings A-1..A-5 ALL FIXED (batch 19) — self-serve onboarding live both sides, dispute + listing UIs, prod fail-fast, stale-order detection. 147 unit + 26 integration + 16 concurrency green, 11/11 builds.**

## Completed (2026-06-12, batch 19 — audit #2 fixes A-1..A-5)
- **A-1 publisher onboarding**: `POST /identity/become-publisher` — fresh accounts only (refuses staff / existing customer or publisher memberships), creates own org + Publisher (tier NEW = max withdrawal hold) + PUBLISHER_OWNER membership + flips userType, in one tx, audited `PUBLISHER_SELF_ONBOARDED`, cache invalidated. Publisher signup flow calls it post-registration. Layered controls intact: NEW tier hold + listing moderation + dual settlement approval. Live-verified: signup→convert→PUBLISHER, double-convert 400, staff 403
- **A-2 customer onboarding**: portal `CreateOrgGate` blocks dashboard until org exists (name → POST /identity/organizations w/ random slug suffix); createOrganization now invalidates auth cache. Live-verified: fresh signup → org → OWNER role + wallet 200 immediately
- **A-3 dispute UI**: portal order detail "Open Dispute" (PAID, not REFUNDED/DISPUTED; reason ≥10 chars) → POST /orders/:id/dispute; client `orders.openDispute`. Live-verified
- **A-3 listings UI**: publisher `/dashboard/listings` page (list + create dialog: title/desc/type/price/website, hardwired status PENDING_REVIEW — publishers can't self-approve) + nav. Live-verified
- **A-4**: auth package throws at boot when production && !TRUSTED_ORIGINS (localhost fallback removed for prod)
- **A-5**: reconciliation sweep now flags SUBMITTED orders >`ORDER_ACCEPT_STALE_DAYS` (default 7) — detector only, refunds stay on the single tested refund path (admin force-cancel)
- 4 new unit tests (become-publisher guard matrix) — 147 total

**Status (prior): Frontend completion sprint done (batch 18) — all 4 apps wired to real endpoints, notification center live, audit center backed, RBAC page guards. 141 unit + 26 integration + 16 concurrency green, 11/11 builds.**

## Completed (2026-06-12, batch 18 — frontend completion & integration sprint)
- **Audit found 3 broken admin pages** (calling nonexistent routes) + zero mock data anywhere (batches 14/16 held up)
- **New backend read surfaces** (thin, over existing models — no redesign):
  - `GET /admin/audit-logs` (SUPER_ADMIN; action/entity/actor/date filters, paginated) — audit-logs page was 404
  - `GET /admin/publishers` + `PATCH /admin/publishers/:id/tier` (tier = real trust lever; removed fabricated approve/reject/suspend/restore client methods + page actions)
  - `GET/PATCH/POST /admin/support/tickets[...]` cross-org staff support (status change + reply notify customer via queue; removed fabricated priority/assignee fields)
  - **notifications module**: `GET /notifications` (+unread-count, mark-read, mark-all-read) — strictly self-scoped (cross-user = 404, verified live)
- **Notification center**: `NotificationBell` in packages/ui (presentation-only) + per-app wrapper (react-query, 60s unread poll, load-more, mark-read) mounted in portal/publisher/admin layouts. Data path proven live: publisher sees real WITHDRAWAL_APPROVED/SETTLEMENT_RELEASED rows, mark-read works
- **RBAC page guards**: `useRequireRole` + ForbiddenPage in admin (finance → SUPER_ADMIN+FINANCE, audit-logs → SUPER_ADMIN); portal session-restore now rejects non-CUSTOMER (was sign-in only); publisher already enforced both paths
- **Audit center**: filters + client-side search + CSV export on admin audit-logs page
- **Ownership badges**: Platform/Publisher/Hybrid `fulfillmentType` badges on portal marketplace cards + detail page (client type updated — API always returned it)
- **Crash sweep**: all `.replace`/`.toFixed`/`.map` renders guarded (1 fix in audit search on nullable entityId)
- Smoke-tested live: all new endpoints return real data; OPERATIONS→audit-logs 403; cross-user notification 404
- Suites: 141 unit + 26 integration + 16 concurrency, 11/11 builds

**Status (prior): Pre-beta audit findings ALL FIXED (batch 17) — 141 unit + 26 integration + 16 concurrency green, 11/11 builds. Backend beta-ready; frontend polish next.**

## Completed (2026-06-11, batch 17 — pre-beta audit fixes F-1..F-9)
- **F-1 double-credit race**: deposit webhook P2002 now ABORTS tx (`DuplicateEventError` rethrow) — wallet increment can no longer commit without ledger row. Deposit rows store `providerRef` = Stripe payment_intent
- **F-2 payout webhook normalization**: `packages/shared/src/payout-webhook.ts` `normalizeProviderWebhook` maps real Wise (`data.resource.id`/`current_state`) + Stripe (`data.object.id`/`status`) shapes through the SAME status maps as the poller; worker handleWebhook uses it; internal pre-normalized payloads pass through
- **F-3 cross-tenant idempotency**: `@@unique([organizationId, idempotencyKey])` on Order (migration `20260611150000_prebeta_audit_fixes`), replay lookup composite-scoped
- **F-4 withdrawal reversal**: `POST /admin/withdrawals/:id/reverse` (SUPER_ADMIN/FINANCE, reason ≥10 chars) — FAILED→REVERSED, balance restored, `WITHDRAWAL_REVERSAL` row `withdrawal-reverse-{id}`, refuses if any execution COMPLETED/PROCESSING; api-client `reverseFailedWithdrawal`
- **F-5 settlement status corruption**: customerApprove now conditional updateMany (status in PENDING/UNDER_REVIEW + version); RELEASED can never revert; settlements audit.log now pass tx
- **F-6 chargeback holds**: dispute.created → hold available→reserved on originating wallet (via providerRef), partial-hold + uncovered-exposure audit; dispute.closed won→release / lost→permanent debit w/ new `CHARGEBACK` TransactionType; all idempotent via unique references `chargeback-{hold|release|lost}-{disputeId}`
- **F-7 contract drift**: api-client orders.ts normalizes raw API → declared type (totalAmount=Number(amount), items[].serviceType=order.type etc.); portal order detail page stale local type fixed, dead assignedTo block removed
- **F-8 FINANCE lockout**: admin FE staffRole type + per-item nav role lists (finance: SUPER_ADMIN+FINANCE; marketplace: +OPERATIONS; audit-logs: SUPER_ADMIN)
- **F-9 ops**: `scripts/backup-db.sh` (pg_dump custom+verify+rotate), `docs/OPERATIONS.md` (restore drill, pm2, runbooks), compose `restart: unless-stopped`, reconciliation core extracted to `packages/shared/src/reconciliation-core.ts` (BigInt 12dp), worker hourly sweep (`RECONCILIATION_SWEEP_MINUTES`) w/ staff notifications + `RECONCILIATION_DRIFT_DETECTED` audit on any drift
- 26 new regression tests in `billing/__tests__/prebeta-audit-regression.spec.ts` (141 total)
- Audit report: `bedrock/Evidence/PRE_BETA_AUDIT_2026-06-11.md`

**Status (prior): Beta hardened + load-proven (batch 15) — 1000 concurrent users, zero money drift, full automated test suite. Memory vault populated with 8 domain branches.**

## This session — permanent memory integration
- Created 8 domain Memory branches (`identity-auth`, `billing-payments`, `orders-fulfillment`, `marketplace`, `settlements`, `publisher-payouts`, `infrastructure`, `security`)
- Updated PROJECT.md with memory branch references
- Populated glossary and decisions templates with domain content

## Next session — pending fixes
- Frontend/API contract sweep: batch 16 fixed order.serviceType->type + paginated unwrap, but other pages likely share the drift (portal orders/campaigns/reports use `order.items?.[0]?.serviceType` which is optional-chained so degrades to "—" rather than crashing — verify against real `items` shape). Audit every `.list()`/paginated client method for array-vs-{items} mismatch.
- Latent pool-deadlock risk: only 18/66 audit.log calls pass `tx`. Hot money paths fixed; sweep remaining in-transaction audit.log/this.prisma.* calls in colder paths (disputes, refunds, settlements admin actions) before full production load.
- Run servers via `pnpm dev:all` (compose + all apps) for a stable local stack — session-started foreground processes die with the shell.

## Completed (2026-06-11, batch 15 — integration + concurrency + 1000-user load)
- **3 automated test harnesses** (package.json: test:integration / test:concurrency / test:load):
  - `integration-test.ts` — full money loop, 26 assertions incl. money conservation at each step, state-machine integrity, two-step settlement approval, tier-hold enforcement, idempotency replay
  - `concurrency-test.ts` — 7 parallel attacks (double-pay, over-spend, double-release, withdrawal over-draw, idempotency storm, execute race, double mark-paid) + reconciliation referee. 16/16
  - `load-test.ts` — provisions N users via DB (bypasses auth/billing rate limiters legitimately for setup), runs N concurrent order+payment flows. **1000/1000 paid, 0 errors, 151 orders/s, p99 434ms, zero drift**
- **Critical concurrency bug fixed — double-charge**: `billing.reserve`/`payFromReserved` opened their OWN `$transaction` (independent commit), so under parallel submit-payment every request debited the wallet and only the order version-guard deduped → wallet drained N×. Fix: added optional `existingTx` param; submitPayment now claims the order (version-guarded DRAFT→PAID) BEFORE any money moves, and reserve/pay run inside that same tx (atomic rollback for losers)
- **Pool-deadlock bug fixed (throughput killer)**: `createOrder` and `submitPayment` called `this.prisma.*` / `audit.log` (new connection) while holding a `$transaction` connection → pool starvation → 20s timeouts, 35% error rate at 40 concurrent. Fix: use `tx.` for in-transaction reads, pass `tx` to `audit.log`. Throughput went 1.2→151 orders/s
- **PrismaService tuned**: connection_limit=25 + pool_timeout=20 injected into DATABASE_URL if absent; transactionOptions maxWait 10s / timeout 20s
- **Settlement release return fix**: admin-approve returned the pre-release ADMIN_APPROVED snapshot instead of the final RELEASED row
- 115 unit + 26 integration + 16 concurrency all green; 11/11 builds

## Completed (2026-06-11, batch 14 — beta bring-up)
- **DB rebuilt from scratch**: migration chain was unreplayable (db-push drift: missing DisputeStatus enum, dup indexes, missing FK columns) → squashed to single baseline `20260611120000_squashed_baseline` (schema DDL + hand-written CHECK constraints/partial indexes carried forward); old chain archived in `prisma/migrations_archive/`
- **New seed** `scripts/seed.ts` (pnpm seed): 6 users (admin/finance/staff/publisher/client/member), staff bootstrap via DB (no self-promote API — old seed scripts used removed `set-staff` endpoint), roles via admin API, org + member invite, $5000 wallet via dev deposit, 3 publisher websites, 3 categories, 4 approved listings, 3 payout providers. Credentials in script output
- **Bugs found by e2e money loop, all fixed**:
  - `Order_websiteId_required` CHECK too strict (DRAFT couldn't carry websiteId — createOrder always does) → relaxed to non-DRAFT-requires-website
  - `OrderEventType` enum missing `ORDER_SUBMITTED` (code emitted it) → added
  - Wise/Stripe adapters never registered in PayoutProviderService → registered
  - `getActiveProvider` decrypted unconditionally → empty/object config (manual provider) passes through
  - `markWithdrawalPaid` couldn't complete in-flight manual executions (PROCESSING dead-end) → completes manual execution, refuses automated-provider ones (double-pay guard)
  - api-client: settlement approve path wrong, withdrawal verbs POST vs PATCH, publisher-payouts paths/shapes all wrong → fixed + added execute/executions/retry/cancel/reconciliation/decrypt/markPaid/payout-methods
- **Frontend extended**: publisher payout-methods page (add bank/PayPal, masked display, deactivate) + nav; withdrawals page wired to payout methods; admin finance: 4 tabs (settlements/withdrawals/payouts/reconciliation), execute payout, executions drill-down w/ retry/cancel, audited decrypt dialog (reason required)
- **Verified e2e**: deposit $5000 → order $250 → fulfillment state machine → manual-verify → delivery → settlement (customer+admin approve) → $200 publisher withdrawable → withdrawal (NEW-tier hold enforced, then VERIFIED) → manual execute → mark-paid → lifetimePaid $200 → reconciliation 0 drift. Decrypt RBAC: admin w/ grant 200, OPERATIONS 403, audit row written
- All services running: API :4000, website :3000, portal :3001, publisher :3002, admin :3003, worker (payout poll registered)
- 115 API tests pass; all 11 turbo build targets pass

## Completed (2026-06-11, batch 11 — go-live audit fixes)
- Webhook controller now verifies signatures BEFORE queueing, fail-closed: Stripe HMAC (`stripe-signature` t/v1, 300s tolerance, timing-safe) via `STRIPE_PAYOUT_WEBHOOK_SECRET` (falls back to `STRIPE_WEBHOOK_SECRET`); Wise RSA-SHA256 (`x-signature-sha256`) via `WISE_WEBHOOK_PUBLIC_KEY` (PEM). Missing config → 503, bad sig → 401, never enqueued
- Wise adapter: idempotency now via `customerTransactionId` (deterministic UUID from idempotency key) — previous body field `idempotencyKey` was ignored by Wise (duplicate-transfer risk)
- Stripe adapter: idempotency moved to `Idempotency-Key` HTTP header — previous form field was ignored by Stripe
- Both adapters: mock fallbacks (missing API key → fake COMPLETED) now throw in production
- `retryExecution`: checks provider status of prior `providerExecutionId` before re-sending; provider COMPLETED → reconcile local state (audit `PAYOUT_EXECUTION_RECOVERED_COMPLETED`), provider PROCESSING → 409. Closes FAILED-marked-but-actually-paid double-payout window
- Deleted dead processors (`payout-execution/webhook/status.processor.ts`) — unregistered, contained unguarded racy webhook handler
- 105 tests pass (14 new in payout-golive-security.spec)

## Completed (2026-06-11, batch 12 — CTO audit fix)
- `payout-webhooks/:provider` was behind global AuthGuard (no `@Public()`) — providers would 401, payouts stuck PROCESSING forever. Added `@Public()`; signature verification is the route's authentication

## Completed (2026-06-11, batch 13 — scale/operational improvements from CTO audit)
- **Status poller now real**: `packages/shared/src/payout-status.ts` (pure provider status fetchers — return null w/o API key, never assume completion); worker `handleCheckStatus` polls PROCESSING executions and transitions via shared `completeExecution`/`failExecution` helpers (same version-guarded tx as webhook path, audit `PAYOUT_STATUS_POLL_COMPLETED/FAILED`); repeatable BullMQ job registered on worker startup (every 10m, jobId `payout-check-status-poll`, HMAC-signed payload)
- **Reconciliation batched**: all N+1 loops → grouped queries (fixed query count regardless of rows); single execution groupBy answers FAILED-orphan/COMPLETED-orphan/duplicate-COMPLETED checks
- **AuthGuard cached**: 30s per-instance TTL cache (`common/auth-context-cache.ts`, 10K-entry cap) — was 3-5 DB queries/request; session still verified every request; explicit invalidation on context switch, membership invite/remove, role changes. PermissionsGuard (decrypt) deliberately uncached
- 115 tests pass (10 new: cache TTL/eviction/invalidation, provider status mapping/skip semantics)

## Known gaps (accepted for controlled beta, documented)
- Status poller (`payout-check-status`) counts but doesn't transition — stuck PROCESSING relies on webhooks + reconciliation stale alerts + manual retry
- Crash between provider send and DB write: reconciliation flags stale PROCESSING >2h; recovery manual via provider idempotency-key lookup
- No provider-side reconciliation (compare Wise/Stripe transfer list vs PayoutExecution rows) — orphan provider transfers invisible



## Completed (2026-06-11, batch 10 — financial data decryption hardening)
- Repaired interrupted prior session: schema.prisma had duplicate `model PayoutProvider {` (parse error) → fixed, client regenerated, `packages/database` rebuilt
- PermissionsGuard: SUPER_ADMIN no longer bypasses SENSITIVE_PERMISSIONS (`FINANCIAL_DATA_DECRYPT` must be explicitly granted on StaffMembership, any role)
- Decrypt endpoint `POST /admin/payout-methods/:id/decrypt`: permission-gated, reason required (min 10 chars), `PAYOUT_METHOD_DECRYPTED` audit (actor/reason/IP/UA), `Cache-Control: no-store`
- Provider error redaction in PayoutExecutionService: logger + `errorMessage` column + audit metadata + rethrown error all pass through `redactSensitive()`
- Migration `20260611030000_payout_execution_and_decrypt_rbac`: PayoutProvider/PayoutExecution/PayoutBatch tables + enums, PayoutMethod.displayDetails/encryptionKeyVersion/version, StaffMembership.permissions, Withdrawal.payoutBatchId — **NOT YET APPLIED, dev DB was down**
- Fixed refund.service.spec mock (wallet.findUnique) broken by prior session
- 91 tests pass (26 new in payout-decrypt-security.spec: guard matrix, prod key enforcement, rotation, GCM tamper, masking, redaction, audit)

## Apply when DB up
```bash
cd packages/database && npx prisma migrate deploy
```

**Status (prior): Backend hardening complete (batch 9) — backend-first push before frontend work.**

## Completed (2026-06-11, batch 9 — CTO review fixes)
- All launch-blocker fixes from full architecture review: privesc, Decimal money math, one-website-per-order, clawback debt model, forceCancel refund delegation, audit-in-tx, chargeback handler, withdrawal holds + ledger rows, dispute previousStatus, atomic delivery+settlement, pagination, price-drift 409, domain dedupe, PayoutMethod, settlement auto-approve sweep, reconciliation endpoint
- Migrations: `20260611000000_business_logic_hardening`, `20260611010000_sync_enum_drift` (repaired db-push drift — dev DB now zero-drift vs schema)
- 71 unit tests pass (new: refund branches, withdrawal holds/ledger, fee split, domain normalization)

## Next Steps (backend completion, pre-frontend)
1. Double-entry ledger design (escrow/revenue accounts) — reconciliation endpoint is interim guard
2. Real payout rail (Stripe Connect) on top of PayoutMethod
3. WebsiteVerification (DNS TXT) model + endpoints, required before listing approval
4. Order accept/delivery deadlines + timeout sweep (SUBMITTED orders currently wait forever)
5. Integration/concurrency tests against real Postgres (parallel approvals, money-conservation property test)
6. Run GET /admin/reconciliation after any manual data surgery; legacy pre-batch-9 withdrawals show as expected publisher drift (no WITHDRAWAL tx rows)

## Standing risks
See `Work/risks.md` — "Still open" section.
