# Current Status

**Phase**: 5C — Website Integration Panel

## Recently Completed

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

**Phase 5C is complete.** Next milestone is Phase 5D (SEO Reporting).

## Explicit Phase Boundaries

> **Phase 5C** ends when a publisher can successfully connect Google Search Console, link a property, synchronize it, and manage the integration. Displaying search analytics is explicitly deferred to Phase 5D.

> **Phase 5D** begins with implementing the GSC Search Analytics API ingestion pipeline (provider, sync worker, `WebsiteSearchDaily` writes) and builds the reporting API + SEO metrics UI (KPI cards, trend charts).

## Next Actions

1. **Phase 5D** — GSC Search Analytics ingestion + SEO metrics display
   - Implement real GSC Search Analytics API calls in provider
   - Pagination, date windows, UPSERT logic, deduplication, retries
   - Historical data imports
   - Reporting API endpoints (`GET /websites/:id/metrics`)
   - SEO Metrics KPI cards (impressions, clicks, CTR, position) + trend charts
2. **Phase 6** — Admin/Operations UI for platform-owned websites
3. **Additional providers** — GA4, Bing Webmaster Tools

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

None.
