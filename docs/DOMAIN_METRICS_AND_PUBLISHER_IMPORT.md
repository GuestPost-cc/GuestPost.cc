# Domain Metrics and Publisher Website Import

This document describes the source-aware domain metric model, Google metric
visibility rules, and the Super Admin publisher inventory import workflow.

Platform-owned inventory uses the same metric contract. Platform website
creation requires current staff-supplied Ahrefs organic traffic and Moz DA,
stores them with `STAFF_MANUAL` provenance, and queues Ahrefs Free DR plus
OpenPageRank after the site/listing transaction commits. This keeps manual
sources replaceable by later paid APIs without changing the marketplace read
shape.

## Metric sources

`WebsiteMetric` is the canonical current value for a metric. A unique
`(websiteId, key)` constraint prevents ambiguous current values, while
`WebsiteMetricRevision` retains the previous value and provenance whenever a
metric is replaced.

| Metric | Current source | Collection | Freshness |
| --- | --- | --- | --- |
| Ahrefs Domain Rating | `AHREFS_FREE_API` | Worker | 30 days |
| Open PageRank, global rank, and referring domains | `OPEN_PAGE_RANK_API` | Worker | 30 days |
| Ahrefs organic traffic | `PUBLISHER_MANUAL` or `ADMIN_IMPORT` | Publisher/Admin | 90 days |
| Moz Domain Authority | `PUBLISHER_MANUAL` or `ADMIN_IMPORT` | Publisher/Admin | 90 days |
| GSC clicks/impressions | Linked Google Search Console property | Existing integration worker | 30-day summary |
| GA4 sessions/users/pageviews | Linked Google Analytics property | Existing integration worker | 30-day summary |

Publisher listings cannot be submitted for review until both manual metrics
exist and are no more than 90 days old. Values imported by an administrator can
be replaced by publisher input; the prior import value remains in revision
history.

The publisher enlistment form requires Ahrefs organic traffic, Moz Domain
Authority, and a fresh measurement date for each. The website, draft listing,
compatibility values, source-aware metric rows, and metric audit event are
written in one transaction. Ahrefs Domain Rating and OpenPageRank values are
never entered by the publisher; a server-side worker job is queued after the
transaction commits.

The legacy listing `domainRating`, `domainAuthority`, and `traffic` columns are
compatibility read fields only. Provider/source truth lives in
`WebsiteMetric`.

### Google visibility contract

GSC and GA4 values are absent from the public listing response unless all of
the following are true for that provider:

1. a `WebsiteIntegration` is linked to the website;
2. its parent integration is `ACTIVE`;
3. the website link is `CONNECTED`, `SYNCING`, or `OUT_OF_SYNC`; and
4. the link has completed at least one successful sync (`syncedAt` exists).

Disconnecting, disabling, removing, or losing access to a property therefore
hides its public Google metric group. Stored historical rows are not deleted.
Domain metrics remain independently visible with their source and freshness.

## Provider security and migration path

Only the worker receives these secrets:

```dotenv
AHREFS_API_KEY=
OPENPAGERANK_API_KEY=
```

Never expose either value through a `NEXT_PUBLIC_*` variable. Provider calls
use fixed HTTPS hosts, reject redirects, cap response bodies, enforce timeouts,
validate every normalized value, and never persist raw provider responses or
include secrets in logs.

The worker uses Ahrefs' bearer-authenticated
`GET https://api.ahrefs.com/v3/public/domain-rating-free` endpoint and
OpenPageRank's bearer-authenticated
`POST https://openpagerank.keywordseverywhere.com/v1/domains/bulk` endpoint
(maximum 100 domains, with history disabled). It refreshes metrics when a
website is created or imported and via the monthly scheduled sweep. Provider
failures do not roll back website creation and are retried by later refreshes.

Paid Ahrefs and Moz adapters can be introduced without changing marketplace
contracts: normalize the paid response to the existing metric keys and write it
with `AHREFS_PAID_API` or `MOZ_PAID_API`. The same upsert/revision path preserves
history across the source transition.

Public UI attribution is required for provider data. Keep the Ahrefs and Open
PageRank attribution links whenever their metrics are displayed.

## Super Admin CSV workflow

The Admin route is **Publisher Import** at
`/dashboard/websites/import`. Operations and Finance cannot access the page or
its API routes.

1. Download the current template.
2. Select exactly one publisher account with an active owner.
3. Upload a `.csv` file (maximum 2 MB and 500 rows).
4. Review normalized row-level errors and warnings.
5. Commit ready/warning rows. Error rows are skipped.
6. The publisher completes missing listing details, policies, services, manual
   metrics, and optional Google connections.

Every imported website and its single listing are created transactionally. The
website begins `PENDING_VERIFICATION`; the listing begins `DRAFT`. Import never
publishes a listing and never implies DNS ownership. The raw CSV is not stored:
the database retains a SHA-256 file hash, safe filename, normalized rows, result
status, assignment, and audit records.

The import page keeps the upload workflow compact while exposing the accepted
values for all 26 columns, active category slugs, and supported languages in
expandable references. Preview and history use responsive cards on narrow
screens and constrained tables on larger screens. The parser requires the
exact downloaded header order, RFC 4180 quoting, and a fixed column count. It
rejects NUL/control ambiguity, duplicate headers, unclosed or misplaced quotes,
and oversized cells before preview.

Value handling is deliberately fault-tolerant without weakening website
identity checks:

- an invalid website URL, a duplicate domain within the file, or a domain
  already registered anywhere on the platform skips the entire row;
- an unsupported optional value is normalized to blank and recorded as a row
  warning while the remaining valid row stays importable;
- unknown, duplicate, inactive, and excess category slugs are skipped
  individually (maximum seven retained categories);
- incomplete or invalid Ahrefs/Moz value-date pairs are skipped as a pair;
- an invalid required service value skips the initial service group, while an
  invalid optional revision/warranty value uses the safe default or blank; and
- rows with warnings remain drafts and require publisher completion before
  marketplace review.

Commit uses an actor-bound idempotency key, rechecks domain and category state,
and handles each valid row transactionally. A rejected row cannot roll back a
successful sibling row, so a mixed batch completes as `PARTIAL` with accurate
imported/skipped/failed counts. Legacy stored `www.` domain identities are also
normalized during the preview duplicate check. Concurrent duplicate
registration is stopped by the database uniqueness boundary.

## Temporary verification override

After an import, a Super Admin may separately apply temporary verification to
the websites created by that batch. This is a break-glass action:

- it requires a 20–1,000 character audit reason;
- it expires in 1–90 days (the UI defaults to 30);
- it records `SUPER_ADMIN_OVERRIDE`, actor, reason, prior status, and expiry;
- it clears no listing review requirements and never approves a listing; and
- the daily re-verification governance sweep revokes it within 24 hours after
  expiry and pauses affected listings (normal DNS checks remain on a 30-day
  cadence).

The publisher can publish the normal DNS TXT record at any time. A successful
check replaces the override with `DNS_TXT` provenance and clears the override
fields. A failed voluntary TXT attempt does not remove an override that is
still within its expiry.

## API surface

Super Admin only:

- `GET /admin/websites/import/template`
- `POST /admin/websites/import/preview`
- `POST /admin/websites/import/:batchId/commit`
- `GET /admin/websites/import/:batchId`
- `GET /admin/websites/imports/history`
- `POST /admin/websites/force-verify`

Publisher owner in the active publisher context:

- `PUT /publishers/:publisherId/websites/:id/metrics/manual`

## Local verification

1. Add worker-only provider keys to the ignored `.env.development` file.
2. Generate Prisma client code and apply the migration
   `20260722110000_domain_metrics_and_publisher_import` to the local database.
3. Start the API, worker, Admin, Publisher, and Portal apps.
4. Import a small CSV into a test publisher and verify the rows remain drafts.
5. Run the domain metric job or wait for its creation/import wake-up.
6. Save publisher manual metrics and submit the listing for review.
7. Confirm GSC and GA4 groups appear only after linking and a successful sync,
   and disappear after unlink/disconnect.
8. Apply a short temporary override in local data and run the re-verification
   sweep after its expiry to confirm automatic revocation.
