# Current Status

**Phase**: Post-July catch-up — integration and financial-security baseline shipped; the next product priority needs an owner decision.

**Reconciled through**: Git commit `8cd5f2b` (358 commits total). The catch-up covers the 93 commits after the previous 265-commit history boundary at `d907b3d`; see `History/timeline/2026-07-16-catchup.md`.

## Recently Completed

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

**Phase 5C is functionally complete.** DNS TXT verification is the website ownership gate; Google Search Console and GA4 are separate performance-data integrations. Search Analytics ingestion and reporting remain a future phase after production OAuth configuration is authorized.

The codebase also contains a July 14 operations-gap assessment. Its recommendation is to prioritise the existing admin fulfillment workflow before broad UX work; no such product phase has started.

## Explicit Phase Boundaries

> **Phase 5C** ends when a publisher can successfully connect Google Search Console, link a property, synchronize it, and manage the integration. Displaying search analytics is explicitly deferred to Phase 5D.

> **Phase 5D** begins with implementing the GSC Search Analytics API ingestion pipeline (provider, sync worker, `WebsiteSearchDaily` writes) and builds the reporting API + SEO metrics UI (KPI cards, trend charts).

## Next Actions

1. **Urgent deployment secret remediation** — rotate the database credential exposed in `render.yml`, remove inline database values from the blueprint, and configure them only in Render's secret environment. This requires deployment/database authority.
2. **OAuth configuration** — authorize the exact Google redirect URI used by the API, e.g. `http://localhost:4000/api/v1/integrations/GOOGLE_SEARCH_CONSOLE/callback`, or set `API_BASE_URL` to the deployed API base and authorize that callback.
3. **Worker operations** — ensure the worker queue process is running in local/dev when testing DNS TXT verification, otherwise jobs remain queued.
4. **Choose the next product phase** — the committed operations-gap analysis recommends the admin fulfillment workflow as the first priority; Phase 5D remains the reporting alternative.
5. **Phase 5D** — GSC Search Analytics ingestion + SEO metrics display
   - Implement real GSC Search Analytics API calls in provider
   - Pagination, date windows, UPSERT logic, deduplication, retries
   - Historical data imports
   - Reporting API endpoints (`GET /websites/:id/metrics`)
   - SEO Metrics KPI cards (impressions, clicks, CTR, position) + trend charts
6. **Phase 6** — Admin/Operations UI for platform-owned websites
7. **Additional providers** — GA4, Bing Webmaster Tools

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
