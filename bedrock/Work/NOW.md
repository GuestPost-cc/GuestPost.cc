---
note_type: now
project: guestpost-platform
updated: 2026-09-10
---

# Current focus

## Security and query hardening follow-up

Branch `codex/security-query-hardening` is stacked on the exact PR #116 head so
the staged full-RLS PR remains unchanged. The follow-up closes the audit items
that are safe and valuable to address now: API-key authentication is explicit,
creator-bound, expiring, permission-scoped, tenant-fenced, and fail-closed;
report responses and generated artifacts use customer-safe allowlists; legacy
stored report payloads are redacted; sweeps and admin review paths are bounded;
and the confirmed website, marketplace, reminder, and cancellation N+1 query
paths are replaced with batch queries. Supporting indexes and an additive
migration accompany the query shapes.

The branch also removes three unused queue families and the obsolete generic
verification worker, makes repeatable registration failures visible, sanitizes
integration callback errors, validates verification configuration at startup,
and aligns the repository checks and operational documentation with the current
Node/TypeScript/Next/Nest toolchain. Existing API keys without creator evidence
remain stored but cannot authenticate; rotate them after the migration. No RLS
activation or hosted database change is part of this branch.

Local validation is green for repository policy/format/lint/type/docs/dependency
checks, Prisma validation and generation, all 1,854 API unit tests, all 480
shared tests, all 127 API-client tests, and the focused worker runtime/sweep
tests. Nest, worker, shared, database, API-client, and UI TypeScript build stages
pass. Full Next.js production bundling is deferred to GitHub CI because
Turbopack cannot bind its internal IPC port in the local execution sandbox.

PR #122's completed CodeRabbit and Codex reviews produced nine valid findings.
The follow-up excludes completed reminders before bounded selection; rotates
cancellation and website sweeps across runs; reauthorizes staff recipients at
the write boundary; preserves scoped legacy report jobs; filters public report
events before truncation; keeps API keys on the anonymous rate tier until
authentication; fences API-client keys to the configured origin; labels the
verification CSV as a current-page export; and moves new indexes/FK validation
to online, staged migrations. The review fixes have focused regression
coverage; the final combined GitHub CI rerun is the remaining merge gate.

## Full staged application RLS

PR #116 now contains an inert four-command policy surface for 98 Prisma models
plus a lockout-safe activation-time swap from the six live Phase 1 `ApiKey`
policies to four full-boundary policies, alongside context-aware API, Better
Auth, integrations, and worker clients.
Customer, publisher, and staff authority is rechecked from live PostgreSQL
rows; public/catalog, webhook, auth, and platform-worker workloads have
separate explicit boundaries. Better Auth uses a distinct runtime URL, and API
startup fails if enforcement is enabled without it.

The 11-role topology is non-superuser, `NOBYPASSRLS`, and leaves all
credentials `NOLOGIN`. Activation is a separate guarded transaction after code
and credentials are canaried while policies remain inert. A guarded emergency
disable preserves the Phase 1 `ApiKey` boundary. A real PostgreSQL 17
provision/ownership/activation test passed for all 99 forced tables, including
customer owner/member isolation, publisher private and routed-order access,
Operations/Finance/Super Admin, auth table denial, public filtering, worker
no-context denial, cross-tenant DML, role and telemetry spoofing, customer and
publisher self-promotion denial, safe invite acceptance, last-owner
preservation (including concurrent customer and publisher owner demotions),
append-only audit, display-safe review snapshots, public metric filtering,
delivery URL fencing, suspension, and live membership revocation. The same
destructive matrix now runs after an activation-time provisioning rerun in a
dedicated GitHub CI database, proving authorizer ACL reconciliation is safe.
The CI ownership rehearsal transfers tables before independently owned
sequences because PostgreSQL transfers `OWNED BY` sequences with their parent
table and rejects an attached sequence-first owner change; the corrected clean
database sequence passed again through activation and the full matrix.

## Prior marketplace context

PR #105 layers the marketplace trust-boundary hardening on current `main` SHA
`1d993e0`, which already includes the support-messaging and confirmed
delivery-fraud releases. Its base conflicts are resolved locally and migrations
`20260821120000_marketplace_moderation` and
`20260821130000_marketplace_moderation_legacy_message_correction` are applied to
the explicitly authorized Neon staging database. The remaining work is to land
the review fixes and run the complete repository CI matrix. A staging migration
is not a production deployment.

The last independently recorded production deployment remains SHA `512b851`
in finance-locked mode. A merge to `main` does not deploy Render because every
Blueprint service has manual deployment enabled. The Northflank worker fleet
remains under the recorded full hold; do not infer a matching running worker
from a GitHub merge, CI pass, or staging migration.

## Marketplace hardening in PR #105

- Added immutable `ModerationEvent` history plus current projections and
  optimistic versions for listings and websites. The migration conservatively
  backfills legacy holds without guessing their prior state.
- Replaced generic lifecycle mutations with explicit, locked staff/publisher
  policies. Operations is assignment-bounded, Finance is read-only, Super Admin
  owns exceptional reopen/archive authority, and publishers cannot clear staff
  holds unless resubmission is explicitly enabled.
- Made website pause/archive independent of listing status and required an
  APPROVED listing with an active, VERIFIED website across every buyer
  discovery path and checkout. Orderability is revalidated while locking
  Website, MarketplaceListing, then ListingService.
- Restricted buyer metrics to current exact provider/key/direct-source evidence.
  Manual, staff, import, stale, mismatched, and unknown values remain available
  to authorized internal workflows only.
- Replaced broad public spreads with explicit allowlist serializers, including
  reduced review/publisher/service shapes and deposit-gated URLs.
- Added typed moderation commands/projections and capability-driven admin and
  publisher UI with reasons, messages, version conflicts, confirmations, and
  publisher-safe history.
- Removed publisher create-time status/featured/verified injection and routed
  legacy archive paths through the same moderation authority.
- Operations offboarding now fails closed while platform Websites remain
  assigned. Platform Website creation/reassignment serializes against staff
  demotion and suspension, revalidates the active Operations owner under lock,
  and commits reassignment with its audit record atomically.

## Confirmed-fraud base release

- Current `main` records confirmed delivery fraud as immutable, same-order
  evidence, retains the fraud hold, and drives a separate full-refund review
  through Operations and Finance authority.
- Database backstops bind terminal Order outcomes to the canonical cancellation
  and refund evidence and make confirmed-fraud findings and approved refund
  evidence append-only.
- Audience-specific stakeholder timelines and transactional communications do
  not expose raw internal notes, audit text, support identifiers, provider data,
  or generic metadata.
- The delivery-fraud migration remains a mixed-writer cutover: old API/worker
  images cannot be started against the guarded schema.

## Explicitly unchanged

- Staff security and finance governance remains owner-deferred: phishing-
  resistant MFA, recent step-up authorization, universal human money-command
  maker-checker, append-only staff-security evidence, and break-glass rehearsal
  remain paid-launch gates.
- Managed KMS/HSM, provider certification, legal/entity, browser acceptance,
  Redis capacity, and worker rollout gates remain open. Neither a staging
  migration nor this correctness batch certifies paid production.

## Validation state

Before the base merge, the marketplace batch passed all 1,693 API unit tests,
all 459 shared tests, all 90 API-client tests, API Nest build, Prisma
format/validate/generate, TypeScript checks for API/database/shared/API-client/
admin/portal/publisher, full ESLint for the three affected apps, Biome, and
`git diff --check`.

After the base merge, all 1,787 API unit tests passed together, as did database
and API typechecks, the API-client's 127 tests, 84 focused metrics/provenance/
search/client tests, affected app typechecks and lint, Prisma format/validate/
generate, and `git diff --check`. The Neon staging target reports all 78
migrations current with no failed migration. Its one legacy paused-listing and
one inactive-website projections use the corrected Super Admin wording, the two
archived-listing projections remain unchanged, and all four immutable legacy
events retain their original evidence. Invalid event targets remain zero, both
append-only guards remain enabled, and all five moderation constraints remain
present. PR #105 must still pass the combined repository CI matrix; local and
staging results are not a substitute for that check.

The first post-merge GitHub run passed dependency, migration, static, and API
unit stages, then exposed a direct Prisma `DriverAdapterError` serialization
shape in the real support/offboarding race. The structured retry classifier now
recognizes that exact adapter shape without parsing messages or trusting
arbitrary nested causes. Focused shared/admin coverage and the API build pass;
the full GitHub rerun passed. Review findings have since produced a narrow
follow-up batch, so the next pushed head must pass the complete GitHub matrix
again before merge.

## Next actions

1. Commit and push `codex/security-query-hardening`, open it against
   `codex/staged-api-key-rls`, and require the complete GitHub matrix plus review
   resolution before merge. Retarget it to `main` only after PR #116 lands.
2. Keep PR #116 unchanged and keep hosted databases unchanged. After merge,
   rehearse the canonical
   lockout-safe sequence from `docs/RLS_ROLLOUT.md` on a current staging clone,
   including separate API/auth/worker credentials and pre-activation canaries.
3. Treat activation on staging or production as a separate approved operations
   change; repository CI and merge do not authorize or perform that cutover.
