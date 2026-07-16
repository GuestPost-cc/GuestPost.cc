---
note_type: domain-memory
domain: marketplace
project: guestpost-platform
updated: 2026-07-16
---

# Marketplace

## Listing → Service architecture (post-Phase-7)

A `MarketplaceListing` represents a **website** (or an INTERNAL_SERVICE bundle). It owns site-level fields only — title, slug, description, metrics (DR/traffic/RD), category/tags, country/language, `featured` / `verified`. The legacy listing-level `type` / `price` / `turnaroundDays` / `revisionRounds` / `warrantyDays` columns + the `ListingType` enum were **dropped in migration `20260615130000_phase7_listing_columns`** — every per-service attribute now lives on the child `ListingService` row.

`ListingService` is the orderable unit: `(listingId, serviceType, price, currency, turnaroundDays, revisionRounds, warrantyDays?, requirements?, fulfillmentSettings?, availability, version)`. One listing exposes N services; unique on `(listingId, serviceType)`. Availability: `AVAILABLE` (orderable), `PAUSED` (hidden from buyers, kept for historical order references), `WAITLIST` (visible, not orderable; favorites with matching serviceType get notified on flip to AVAILABLE).

Customer flow (locked after listing-detail pick):
1. Browse `GET /marketplace/listings` — search filters key off `services.some({availability:"AVAILABLE", serviceType?, price?, turnaroundDays?})`. Card returns `priceFrom` (min AVAILABLE price), `serviceTypes[]`, `lifecyclePhase`.
2. Open listing → service picker shows AVAILABLE + WAITLIST rows.
3. Pick a service → `listingServiceId` is locked. The order wizard collapses Service+Website into a read-only summary and cannot back-step.
4. `POST /orders` body carries `listingServiceId` + `briefData` (per-service Zod-validated payload). Server snapshots `serviceType`, `amount`, `turnaroundDays`, `fulfillmentChannel`, `listingId`, `listingServiceId`, `briefData` onto the order — later listing edits never alter an in-flight contract.

Marketplace discovery is authenticated. The marketing website has no `/marketplace` route or navigation link, and all marketplace browse endpoints (listings, detail, service picker, categories, tags, services, search, and stats) use the API's global session guard. Customer browsing remains at `/dashboard/marketplace` in the portal.

## Lifecycle phase (derived UI state)

`packages/shared/src/lifecycle/listing-phase.ts:computeListingPhase(status, ownerType, websiteVerificationStatus, availableServiceCount)` returns one of:
- PUBLISHER + DRAFT + website≠VERIFIED → `AWAITING_VERIFICATION`
- PUBLISHER + DRAFT + no AVAILABLE service → `AWAITING_SERVICES`
- PUBLISHER + DRAFT + verified + ≥1 AVAILABLE → `READY_FOR_REVIEW`
- PENDING_REVIEW → `IN_REVIEW`
- PLATFORM + DRAFT + ≥1 AVAILABLE → `READY_TO_PUBLISH`
- APPROVED → `PUBLISHED` ; PAUSED → `PAUSED` ; REJECTED → `REJECTED` ; ARCHIVED → `ARCHIVED`

Publisher lifecycle endpoints (all version-via-status-guarded, audit-logged):
`POST /marketplace/listings/:id/{submit,pause,unpause,archive}`. `submit` gates on website VERIFIED + ≥1 AVAILABLE service.
**2026-06-28: `submitListingForReview` now accepts REJECTED → PENDING_REVIEW** (resubmit flow), not just DRAFT.

## Per-service brief (Phase 6)

`packages/shared/src/briefs/index.ts` exports a Zod registry keyed on `ServiceType` (8 schemas: GUEST_POST / NICHE_EDIT / EDITORIAL_LINK / OUTREACH_LINK / LOCAL_CITATION / FOUNDATION_LINK / BLOG_ARTICLE / SEO_CONTENT). `validateBrief(serviceType, payload)` returns the parsed brief; throws `ZodError` (translated to 400 with field path) or `UnknownServiceTypeError`. Snapshotted onto `Order.briefData` (JSONB); legacy `Order.title` + `Order.instructions` remain as denormalized mirrors for older renderers.

Portal `<BriefForm serviceType={…}>` ([apps/portal/src/components/BriefForm.tsx](apps/portal/src/components/BriefForm.tsx)) renders per-service field configs (text/textarea/url/number/select/tags/address).

## Ownership attribution

`MarketplaceListing.ownerType` (`PUBLISHER` | `PLATFORM`) is authoritative. Public DTOs surface `attribution = {kind, label}`:
- PLATFORM → "Listed by GuestPost.cc"
- PUBLISHER → publisher display name

For PLATFORM sites, `Website.managedByUserId` points at the OPERATIONS staffer who owns the site. Set on `POST /admin/websites` when creator is OPERATIONS; mutable via `PATCH /admin/websites/:id/assign` (validates target role; audit-logs from/to). In-flight orders' `FulfillmentAssignment` rows are NOT migrated on reassignment — only new orders route to the new owner.

The July platform-management update makes this assignment an access boundary: OPERATIONS staff can list only websites and marketplace listings assigned to them, while only `SUPER_ADMIN` can reassign a website. Staff marketplace listing filters also support `ownerType`.

## Per-service endpoints

| Method | Path | Notes |
|---|---|---|
| POST | `/marketplace/listings/:id/services` | Publisher path. Add a ListingService. |
| PUT  | `/marketplace/listings/:id/services/:serviceId` | Version-guarded update. WAITLIST→AVAILABLE flip triggers favorite fan-out. |
| DELETE | `/marketplace/listings/:id/services/:serviceId` | Soft-disable (sets availability=PAUSED). Hard delete never offered — historical orders would orphan. |
| POST/PUT/DELETE | `/admin/marketplace/listings/:id/services[/:serviceId]` | Mirror endpoints for staff-managed PLATFORM listings. |
| GET | `/marketplace/listings/:slug/services` | Lightweight service-picker fetch. |

## Features

- Categories and tags for listing organization
- Reviews and favorites for social proof (favorites can now be scoped per-serviceType for waitlist notifications)
- Saved lists for user curation
- Per-service prices on `ListingService`. Listing-level price/range fields removed in Phase 7
- SEO metrics: domain rating (DR), traffic, referring domains, spam score
- AI-powered recommendations (`MarketplaceRecommendation`) — now match on AVAILABLE-service overlap, not the dropped listing-level `type`
- Fraud detection flags (`MarketplaceFlag`)
- Marketplace stats include `totalServices`, `activeServices`, `servicesByType` (per-`ServiceType` count + avg price)
- Analytics: `MarketplaceListingClick.serviceType` + `MarketplaceSearchHistory.serviceType` capture which service the user picked / filtered

## Publisher Portal UX (2026-06-28 — `apps/publisher/src/app/dashboard/listings/page.tsx`)

- **Create dialog**: Legacy `type` dropdown + `price` input removed (Phase 7 no-ops). Added "Add a service now" checkbox with inline service form (type, price, TAT, revisions, warrantyDays, currency). `POST /marketplace/listings` accepts optional `services[]` — listing created with first service in one step.
- **Edit listing modal** (NEW): Per-row "Edit" button opens modal for title/description via `PUT /marketplace/listings/:id`.
- **Services dialog redesign**: 
  - Inline "Edit" mode per service row — edits price, TAT, revisions, warrantyDays, currency (USD/EUR/GBP) with version-guarded PATCH
  - Removed duplicate "Pause" button (availability dropdown is single source of truth)
  - Added `warrantyDays` + `currency` columns to add-service form
  - `revisionRounds` column added to service table
- **Lifecycle**: REJECTED listings show "Resubmit for review" button (calls `submitListingForReview` which now accepts REJECTED → PENDING_REVIEW)

## Admin Portal UX (2026-06-28 — `apps/admin/src/app/dashboard/marketplace/page.tsx` + `[slug]/page.tsx`)

- **Critical fix**: Force-approve gate now checks `user.staffRole === "SUPER_ADMIN"` (was checking deprecated `user.role` from `UserRole` enum — never matched). Same fix applied to dispute resolution and settlement approval endpoints.
- **Admin listings endpoint** returns ALL services (AVAILABLE + PAUSED + WAITLIST) for Manage Services dialog; display fields (`priceFrom`, `serviceTypes`, `type`, `price`) computed from AVAILABLE-only subset.
- **Admin API client** (`packages/api-client/src/services/admin.ts`) added `add/update/pausePlatformListingService` methods; frontend calls `api.admin.*` instead of non-existent `api.marketplace.*`.
- **Manage Services dialog** reads directly from listing row data (included in listings response) — removed stale `servicesQuery` that read local table state.
- **Type filter cleanup**: Removed invalid "PUBLISHER_WEBSITE" option (website ownership type, not a ServiceType).
- **Field name fix**: Backend response uses `revisionRounds` (matches Prisma) — frontend type updated from `revisions`.

## Admin Preview Page (`apps/admin/src/app/dashboard/marketplace/[slug]/page.tsx`)

- Domain verification status badge added (VERIFIED/PENDING/FAILED/REVOKED)
- Approve action passes `force: true` for SUPER_ADMIN
- Status mutation signature: `{ status: string; force?: boolean }`

## Marketplace Order Page (Portal)

- Single-page order form at `/dashboard/marketplace/[slug]/order` bypasses 5-step wizard when coming from a listing. Listing summary card + BriefForm + campaign selector + Place Order → `POST /orders` → redirects to `/dashboard/orders/checkout/{id}`.

## Buyer URL Visibility (2026-07-13)

The buyer portal blurs a publisher website URL until the customer has made a successful deposit. A positive balance or any recorded `DEPOSIT` transaction unlocks it permanently; an order draft alone does not. This is a portal presentation rule, not a replacement for server-side authorization.

## One Listing per Website (2026-07-13)

The database enforces one marketplace listing per website. The publisher UI can search existing inventory and create/reorder the listing's services without creating a second listing for the same site.

## Features

- Categories and tags for listing organization
- Reviews and favorites for social proof (favorites can now be scoped per-serviceType for waitlist notifications)
- Saved lists for user curation
- Per-service prices on `ListingService`. Listing-level price/range fields removed in Phase 7
- SEO metrics: domain rating (DR), traffic, referring domains, spam score
- AI-powered recommendations (`MarketplaceRecommendation`) — now match on AVAILABLE-service overlap, not the dropped listing-level `type`
- Fraud detection flags (`MarketplaceFlag`)
- Marketplace stats include `totalServices`, `activeServices`, `servicesByType` (per-`ServiceType` count + avg price)
- Analytics: `MarketplaceListingClick.serviceType` + `MarketplaceSearchHistory.serviceType` capture which service the user picked / filtered

## Key Models

`MarketplaceCategory`, `MarketplaceTag`, `MarketplaceListing` (+ `ownerType`), **`ListingService`**, `MarketplaceListingTag`, `MarketplaceListingImage`, `MarketplaceReview`, `MarketplaceFavorite` (+ optional `serviceType` for waitlist scope), `MarketplaceSavedList`, `MarketplaceSavedListItem`, `MarketplaceListingView`, `MarketplaceListingClick` (+ `serviceType`), `MarketplaceSearchHistory` (+ `serviceType`), `MarketplaceRecommendation`, `MarketplaceFlag`, `ListingFulfillmentRule`, `PublisherProfile`. **Dropped**: `MarketplacePricingTier` (Phase 5), `Service` (Phase 7 part 1), `ListingType` enum + 5 listing columns (Phase 7 part 2).

## Key Files

- `apps/api/src/modules/marketplace/`
