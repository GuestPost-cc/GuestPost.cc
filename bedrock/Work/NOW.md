---
note_type: now
project: guestpost-platform
updated: 2026-08-23
---

# Current focus

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

1. Push the final review-fix commit to PR #105 and merge only after every
   required GitHub check succeeds and the review-thread gate is clear.
2. Keep production writers drained for any later production cutover; rehearse
   on a populated clone, take the required recovery marker, deploy migrations
   before the matching images, and use forward-fix/PITR rather than removing
   evidence guards.
3. Keep the worker, finance, payout, managed-KMS, and legal/provider gates
   explicit instead of treating a green PR or staging database as launch
   approval.
