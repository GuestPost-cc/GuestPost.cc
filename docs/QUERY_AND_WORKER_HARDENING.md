# Query and worker hardening

## Contract

High-cardinality request and worker paths must remain bounded, deterministic,
tenant-scoped, and fair across repeated runs. Apply eligibility filters before
`take`, use a stable tie-breaker in every ordered page, aggregate or batch
related rows instead of querying inside loops, and recheck live authority in
the same transaction as a consequential write.

RLS remains the database boundary. Explicit selectors and response projections
remain necessary because RLS controls rows, not columns.

## Request-path changes

- Customer reports use explicit selects and the customer order projection.
  Private event types are filtered in PostgreSQL before the 100-event cap;
  `eventsTruncated` tells callers when more public events exist.
- Campaign reports and report listings accept `take=1..100` and
  `skip=0..1000000`, return pagination metadata, and obtain page rows plus
  aggregates through bounded database transactions. Stored legacy report
  JSON is reduced to a scalar allowlist before it leaves the API.
- The marketplace search page fetches approved review count/average with one
  grouped query instead of loading every review row. Top-category metadata is
  fetched in one batch.
- The force-approval report resolves all referenced listings in one batch.
  Verification bulk retry deduplicates identifiers, fetches eligible websites
  once, and enqueues a batch. The review center is paginated at 1–100 rows with
  deterministic `(updatedAt, id)` ordering; its CSV control exports and labels
  only the loaded page.

## Scheduled sweep behavior

| Sweep | Selection and progress | Duplicate/authority boundary |
|---|---|---|
| Review reminders | Eligible day buckets exclude existing `REVIEW_REMINDER` markers before the 200-row cap; ordered by `(autoAcceptAt, id)` | Durable order-event and communication dedup keys prevent repeat delivery |
| Cancellation stalls | Batches up to 100 rows, scans at most 1,000 per run by default, ordered by `(updatedAt, id)`; a validated Redis cursor continues for up to 30 days and clears at end | Existing day-bucket events are fetched once per batch; currently unbanned Operations/Finance/Super Admin recipients are resolved inside the write transaction |
| Website reverification | Due DNS rows and expired/missing Super Admin overrides are selected before the cap, ordered by `id`; a validated Redis cursor continues for up to 30 days and clears at end | Live overrides are excluded; optimistic verification versions prevent stale mutation; one DNS failure is isolated so later sites continue |

Cursor storage is a fairness optimization, not authority. Invalid/unavailable
cursor state fails back to a fresh bounded scan; database predicates,
optimistic versions, event markers, and transactional checks remain the safety
controls.

## Report queue compatibility

New report jobs use the explicit PDF and CSV names and include
`organizationId`. The worker temporarily accepts the legacy `generate-report`
and export job names so a rolling deployment can drain already-persisted Redis
jobs. It still requires organization scope, resolves only PDF/CSV, rejects
unknown names, selects an allowlisted order shape, and upserts by
`generated:<orderId>:<format>`.

Remove legacy compatibility only after every environment proves the old report
queue is empty and no older API image can enqueue the retired name.

## Database support

The additive migration records an API-key creator and report dedup key, stages
then validates the API-key creator foreign key, exposes the public-listing RLS
predicate to the planner, and adds ten online indexes for API-key authority,
report deduplication, bounded sweeps, audit lookups, listing lookup, and review
aggregation.

Each index is a single-statement `CREATE [UNIQUE] INDEX CONCURRENTLY` migration.
`IF NOT EXISTS` is deliberately omitted: an interrupted invalid index must not
be mistaken for a completed migration. Follow the exact valid/invalid/absent
inspection and recovery procedure in `docs/PRODUCTION_RUNBOOK.md`; do not edit
migration history or continue a release past a failed migration gate.

## Review checklist

- Bound caller-controlled page sizes and offsets.
- Filter in SQL before limiting; never repeatedly select an ineligible prefix.
- Order by a stable unique tie-breaker.
- Replace per-row queries with `in`, `groupBy`, or a bounded relation select.
- Select and project only fields approved for the caller.
- Carry tenant identity into queued jobs and reapply it in worker queries.
- Revalidate live roles at the mutation boundary.
- Add the matching query-shape index and migration-contract test.
- Cover empty, over-cap, duplicate, legacy, invalid-cursor, transient-failure,
  cross-tenant, and revoked-authority cases.

See `docs/WORKER_ARCHITECTURE.md`, `docs/TESTING.md`, and
`docs/API_KEY_SECURITY.md` for the runtime, verification, and credential
boundaries.
