# Current Status

**Phase**: Operations fulfillment, staff monitoring, and RBAC realignment are implemented and verified locally; staging lifecycle verification remains.

**Reconciled through**: Git commit `8cd5f2b` (358 commits total). The catch-up covers the 93 commits after the previous 265-commit history boundary at `d907b3d`; see `History/timeline/2026-07-16-catchup.md`.

## Recently Completed

### GitHub CI/CD Consolidation And Security Gate

- Replaced the overlapping `CI`, `Main`, and `PR` workflows with one authoritative `CI / build-and-test` gate for PRs, `main` pushes, and manual runs; Render still deploys only after checks pass.
- Added least-privilege permissions, immutable action and service-image pins, non-persistent checkout credentials, superseded-run cancellation, a 60-minute timeout, migration status checks, all package tests, and a complete production build.
- Added a moderate-or-higher production dependency audit and patched the discovered Multer, Hono server, and PostCSS advisories; the audit now reports no known production vulnerabilities.
- Fixed the integration queue circular dependency, deterministic webhook timestamp-boundary coverage, test-only Google OAuth bootstrap, and the Operations claim-race fixture exposed by the restored full gate.
- Validation: dependency graph has zero errors, 833 API unit tests pass, 16 database-backed integration tests pass, package/UI tests pass, and all 12 production targets build.

### Render Staging 500 Recovery

- Recovered deployed customer, publisher, and admin dashboard API 500s by applying the three pending Neon staging migrations through `20260716120000_order_cancellation_workflow`.
- Verified deployed API readiness plus authenticated customer `orders`/`billing`, publisher `orders`, and admin orders/fulfillment/cancellation/marketplace endpoints return HTTP 200.
- Fixed the secondary Render Redis issue where integration queue producers fell back to `localhost:6379` instead of Upstash `REDIS_URL`; deployed API commit `19c7024` is live.
- Confirmed Render free tier blocks Shell and One-Off Jobs, so staging migrations still need a local/direct Neon run until Render is upgraded.

### Admin Verification Navigation And Queue Recovery

- Renamed the DNS ownership surface to Domain Verification while retaining
  Delivery Verification for order-delivery intervention.
- Made sidebar selection choose the most specific visible route, so Delivery
  Verification no longer highlights its Domain Verification parent.
- Aligned the delivery queue UI and typed API client with the server payload,
  including website/source, publisher context, evidence, and `orderId`-based
  actions. Removed order-detail queue links for non-actionable delivery states.
- Replaced the dashboard's signed-out `null` render with a reliable sign-in
  redirect and visible transition state.
- Validation: targeted queue contract test, API/admin builds, admin typecheck
  and lint, API-client build, Biome, and signed-in browser verification pass.

### Admin Staff RBAC Realignment

- Restricted global Users and customer Organizations to Super Admin; Finance
  retains the Publisher directory while Operations has no global Publisher or
  Operations-staff roster access.
- Scoped Operations platform-site reads and mutations to assigned sites. A
  site enlisted by Operations is always assigned to its creator; only Super
  Admin can reassign ownership across staff.
- Scoped platform fulfillment to self-assigned and unassigned claimable work,
  made cross-staff assignment Super Admin-only, validated active Operations
  targets, and fixed claim so it cannot cancel or steal an existing assignment.
- Removed Operations access to settlement list/detail and Finance access to
  admin marketplace/platform-site inventory. Preserved contextual identity
  snippets inside authorized work items.
- Aligned admin navigation, deep-link guards, action visibility, Finance
  settlement approval, support copy, and overview KPIs. Fixed the marketplace
  Platform/Publisher/All filter query-key bug and removed unsupported
  Organization create/edit/delete controls.
- Added `docs/ADMIN_RBAC.md`, RBAC/scoping regression tests, and updated the
  existing fulfillment race guard. Validation: all 830 API unit tests, API
  build, admin production build/typecheck/lint, Biome, and diff checks pass.

### Operations Fulfillment And Staff Monitoring

- Added the Operations dashboard and Fulfillment workbench for assigned and
  self-claimed platform orders: accept, draft/save, customer review, revision,
  publish, verification, and structured cancellation.
- Added five-second and focus refresh for active and claimable orders. Claims
  remain per-order and race-safe through the active-assignment unique index;
  stale assignment writes are rejected transactionally.
- Added Operations production metrics for assigned, claimed, completed, and
  delivered sales, plus Super Admin staff monitoring with role-specific Finance
  activity and Publisher/Customer read-only account views.
- Redesigned Users & Staff around staff monitoring and added Super Admin-only
  credential creation for Super Admin, Operations, and Finance. Customers and
  Publishers remain signup-only.
- Added protections against staff conversion, self-demotion/suspension, removal
  of the final active Super Admin, and orphaning active Operations work.

### Structured Order Cancellation and Refunds

- Replaced generic cancellation with a shared, code-backed policy across customer, publisher, and platform fulfillment channels.
- Added structured cancellation cases, response deadlines, Operations review, Finance approval, Super Admin break-glass controls, responsibility attribution, and optimistic concurrency guards.
- Unified captured-payment refunds into one atomic wallet/ledger/order/assignment/settlement-or-revenue transaction; only publisher-responsible refunds affect publisher trust.
- Completed platform-owned orders into recognized platform revenue, hardened post-publication disputes, and added acceptance/cancellation timeout sweeps.
- Added Customer, Publisher, Operations, Finance, and Super Admin interfaces plus policy/service/refund regression coverage and deployment documentation.
- Validation is green across all 805 API unit tests, all 72 shared tests, affected application/package builds, frontend lint, Biome, and diff whitespace checks. Database-backed integration tests still require a local `psql` executable and isolated test database.
- Applied the three pending local migrations through `20260716120000_order_cancellation_workflow`; all 34 migrations now report current. This fixed the reported customer portal 500 responses, and authenticated wallet, transaction, and order requests each return HTTP 200.
- Aligned publisher-owned and platform-owned fulfillment with cancellation authorization: publisher actions resolve through ownership, platform actions require the active Operations assignment or a Super Admin override, and all deadline/warranty decisions come from the shared server policy.
- Removed the generic admin refund bypass. Cancellation and dispute refunds now require a final responsibility value and use the shared atomic refund path for wallet, transaction, assignment, settlement/platform-revenue, event, and audit updates.

### Platform Website Ownership Reassignment

- Fixed the missing Operations roster caused by the static `/admin/users/ops` endpoint being shadowed by the earlier dynamic `/admin/users/:id` route.
- Moved the roster to `/admin/staff/operations`, restricted results to active non-banned Operations staff, and added a route-regression test.
- Redesigned the admin ownership view and reassignment dialog with an always-visible owner roster, shared-queue option, loading/error/empty states, no-op prevention, and optional audit-reason validation.
- Verified the reported site in the signed-in admin browser: the seeded Operations member is visible and selectable without mutating the current assignment.

### Completed Admin Order Detail Recovery

- Fixed the completed-order detail crash caused by treating `SettlementApproval.approvedBy` as a user object and formatting the nonexistent `createdAt` field instead of `approvedAt`.
- Added a typed admin order-detail API contract, server-side human-approver enrichment, explicit system-actor labels, and defensive timestamp formatting.
- Aligned the same detail view with the actual order, publisher-profile, and delivery-evidence fields; verified the reported completed-order eye action and a delivered-order control in the signed-in admin browser.

### Admin Route Recovery and Settlement Queue Isolation

- Fixed valid admin app-router pages appearing as 404s under the long-running development stack by clearing only generated `.next/dev` outputs during `pnpm dev:all`; production build artifacts remain available.
- Isolated settlement auto-release onto its own BullMQ queue and clean up legacy repeatable registrations so auto-approve and auto-release workers cannot consume and skip each other's jobs.
- Verified all reported admin pages in a signed-in browser, including the exact order detail route, and observed both settlement sweeps complete on their intended workers without the prior unexpected-job warning.

### Authenticated Marketplace Access

- Removed the anonymous marketplace page plus its marketing-site header and footer links.
- Protected every marketplace discovery endpoint with the API's global session guard; anonymous requests now return HTTP 401.
- Added controller metadata coverage for all eight discovery handlers and verified the old marketing URL renders the not-found page while portal marketplace access remains available after login.

### Portal Billing Build Type Alignment

- Removed the stale page-local transaction interface from the buyer billing page so callbacks inherit the API client's `TransactionResponse` type.
- Preserved numeric conversion at arithmetic/display boundaries because serialized transaction amounts can be `string | number`.
- Verified the complete `pnpm dev:all` workflow: all 12 workspace builds passed and website, portal, publisher, admin, worker, and API returned HTTP 200.

### Auth Form Validation Hardening

- Fixed the shared auth forms so portal, publisher, and admin login/forgot-password flows reject empty and whitespace-only inputs with inline field errors.
- Added required Terms of Service acceptance to customer and publisher email signup; the acceptance flag is also enforced at the Better Auth request boundary.
- Upgraded only the shared UI resolver to the Zod 4-compatible release, preserving app-local resolver behavior outside the auth scope.
- Added schema, request-boundary, and UI regression coverage for empty submissions, normalization, Terms gating, and accessible server-error announcements.

### July 3–16 Code-Backed Catch-up

- Hardened worker, queue, logging, Prisma pool, encryption-verification, and test-template operations; CI now covers the integration database template path.
- Completed Integration Management v1 with encrypted OAuth state, ownership resolution, discovery/sync jobs, GSC and GA4 providers, publisher integration views, and website-level integration management.
- Shipped the enterprise delivery and settlement controls: auto-accept/release sweeps, delivery verification intervention, review-window visibility, and reasoned manual settlement approval.
- Added platform listing management and Ops scoping, permanent first-deposit URL reveal in the buyer portal, and the one-listing-per-website constraint.
- Moved wallet funding to Stripe Checkout with a webhook-only credit path; added financial transaction and withdrawal-approval hardening.
- Tightened mutation authentication: mandatory session secret, origin validation, all-actor verification gates, and atomic session rotation.

### Portal Marketplace Redesign

- Redesigned marketplace browsing page with cleaner cards (rounded corners, subtle shadows, better typography, reduced visual noise).
- Simplified filter/search bar: removed redundant type filter and view-mode toggle, consolidated into a cleaner layout.
- Improved pagination with page number buttons.
- Redesigned listing detail page with deposit-gated URL visibility: customers who have never deposited see a blurred/blocker overlay on "Visit Website" with a "Deposit to reveal" tooltip.
- Added wallet/deposit check hook to determine URL visibility.
- Build verified: portal passes with no TS errors.

### Publisher Listings UI Modernization

- Replaced dense table-based listing view with modern cards showing site, service summary, lifecycle guidance, and contextual primary action buttons (submit/pause/unpause/archive).
- Redesigned create-listing dialog with a two-column layout: listing basics + optional first service, plus a checklist sidebar.
- Modernized edit-listing dialog with a bordered form panel and char-count hints.
- Replaced the services table with card-based service management: each service is a compact card with inline editing, availability dropdown, and a dedicated add-service form below.
- Kept service-dialog state fresh after add/update mutations by updating the open dialog directly (no reopen or full-page refresh required).
- Added presentation helpers (`serviceLabel`, `formatMoney`, `phaseCopy`) for consistent UI copy and reduced duplication.
- Added lifecycle phase copy map with user-facing guidance for every listing state.
- Upgraded new-website form (`/dashboard/websites/new`) to use shared `Select`/`Textarea` UI primitives via react-hook-form `Controller`.
- Removed unused `Clock` import.

### Integration UI Build Stabilization

- Fixed Next.js/Turbopack workspace-root resolution for all four Next apps by setting each app's `turbopack.root` to the monorepo root.
- Kept browser-facing integration imports on `@guestpost/integrations/client` so UI/API-client bundles do not pull worker/server dependencies transitively.
- Restored `SyncHistoryTable` compatibility with publisher page usage (`rows`, pagination, `onPageChange`) while preserving the richer progress/error UI.
- Made auth session rotation idempotent with `deleteMany()` to avoid noisy Prisma "record not found" warnings under concurrent/duplicate requests.
- Validation: `pnpm build` passes for all 12 workspace packages/apps.

### Phase 5C — Website Integration Panel

Built the website detail `/dashboard/websites/[id]` page that completes the integration management workflow for publishers:

**Backend:**
- `GET /publishers/:publisherId/websites/:id` endpoint (`websites.controller.ts` + `websites.service.ts`)
- Returns website data + `websiteIntegrations[]` + computed `seoIntegration` summary + `gscIntegration` reference + `gscAccountExists`
- Distinguishes last successful sync from last attempted sync

**API Client:**
- `publishers.getWebsite(publisherId, websiteId)` method

**Hooks:**
- `useWebsite(websiteId)` query hook in `apps/publisher/src/lib/hooks/websites.ts`

**Page UX States:**

| State | Primary Action |
|---|---|
| No GSC account | [Connect Google Search Console] → navigates to integrations page |
| GSC exists, no property linked | [Link a Property] → opens resource picker with confirm step |
| Property linked, idle | [Sync Now] [Unlink Property] — health summary with last sync times |
| Sync running | Animated progress bar |
| Token expired | ReconnectBanner |
| Error | Error display + retry/disconnect |

**Page Features:**
- Integration health summary (property, permission, last sync attempt, last successful sync)
- Link Property dialog with resource picker + confirm step (prevents accidental mappings)
- Disconnect dialog disabled during discovery/sync (prevents race conditions)
- SEO metrics placeholder with intentional onboarding copy (Phase 5D boundary)
- Sync history table (reuses `SyncHistoryTable` from `@guestpost/ui`)

**Navigation:**
- Website list rows are now clickable → navigate to `/dashboard/websites/[id]`
- Action buttons (verify, submit, edit, archive) use `e.stopPropagation()`
- Keyboard accessible (tabIndex, Enter/Space)

**Post-Disconnect invalidation:** website list + website detail queries both invalidated.

### Prior Completions

- Phase 3: React hooks (queries, mutations, polling)
- Phase 7.5: Generalized ownership model (`OwnerContext`)
- Phase 4: Shared UI components
- Phase 5A/5B: Publisher integration list + detail pages
- Phase 7: Async discovery, sync locking, Redis coordination

## Current Focus

The cancellation and Operations fulfillment implementations are code-complete,
and the local development database is current. The next in-scope action is a
staging lifecycle pass covering claim contention, content review, publication,
verification, cancellation, staff monitoring, and the related money records.

**Phase 5C remains functionally complete.** DNS TXT verification is the website ownership gate; Google Search Console and GA4 are separate performance-data integrations. Search Analytics ingestion and reporting remain a future phase after production OAuth configuration is authorized.

The July 14 Operations fulfillment gap is now implemented locally. Staging
validation should cover claim contention, customer review, publication,
verification, cancellation, and staff performance totals using production-like
data.

## Explicit Phase Boundaries

> **Phase 5C** ends when a publisher can successfully connect Google Search Console, link a property, synchronize it, and manage the integration. Displaying search analytics is explicitly deferred to Phase 5D.

> **Phase 5D** begins with implementing the GSC Search Analytics API ingestion pipeline (provider, sync worker, `WebsiteSearchDaily` writes) and builds the reporting API + SEO metrics UI (KPI cards, trend charts).

## Next Actions

1. **Staging lifecycle verification** — Render staging is live on `guestpost.pro.bd` with API readiness green and schema current. Run the claim contention, customer review, publication, verification, cancellation, staff monitoring, and money-record lifecycle pass against production-like staging data.
2. **Migration release gate** — Until Render is upgraded for pre-deploy/one-off migration jobs, run `prisma migrate status` and `prisma migrate deploy` against Neon before deploying API/worker changes that read new schema.
3. **Auth IP warning follow-up** — Render logs now show Better Auth falling back to a shared per-path rate-limit bucket when no trusted client IP header is resolved; configure Better Auth trusted proxy/IP headers before production hardening.
4. **Worker operations** — the worker is not deployed on Render yet; run it locally when testing DNS TXT verification, GSC sync, cancellation/settlement sweeps, or other queue-backed flows.
5. **OAuth configuration** — authorize the deployed Google redirect URI `https://api.guestpost.pro.bd/api/v1/integrations/GOOGLE_SEARCH_CONSOLE/callback` plus any localhost callback still needed for development.
6. **Historical credential containment** — the exposed Neon password was rotated, but the old value remains in git history. Assess whether repository history/access containment is needed before production.
7. **Phase 5D** — GSC Search Analytics ingestion + SEO metrics display
   - Implement real GSC Search Analytics API calls in provider
   - Pagination, date windows, UPSERT logic, deduplication, retries
   - Historical data imports
   - Reporting API endpoints (`GET /websites/:id/metrics`)
   - SEO Metrics KPI cards (impressions, clicks, CTR, position) + trend charts
8. **Phase 6** — Admin/Operations UI for platform-owned websites
9. **Additional providers** — GA4, Bing Webmaster Tools

## Backlog (Future Cleanup)

- Align Zod schema optionality with UI contracts (remove temporary `as` casts and bridge interfaces)
- Website detail API should return nested `integration` and `metrics` objects (currently composed client-side from `useIntegrations()`)
- Replace inline `Website` interface in list page with shared type

## Pre-Production Validation (Open Questions)

- OAuth refresh token lifecycle with real Google credentials
- Google API quota exhaustion handling
- Worker retry/backoff behavior
- Worker recovery after service restart
- Large-account discovery performance (hundreds of GSC properties)
- Concurrent sync request handling
- Audit event coverage for every integration action
- End-to-end reconnect flow
- Load testing with many linked websites

## Blockers

- Database-secret rotation and Render environment remediation require operator access to the deployed database and Render project.
- Cancellation staging validation requires a database migration/deployment window; the migration is schema-validated and applied locally, but not yet verified in staging.
- Local database integration tests are not runnable in the current environment because `psql` is not installed; unit coverage and compile-time validation are green.
