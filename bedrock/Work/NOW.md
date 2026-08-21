---
note_type: now
project: guestpost-platform
updated: 2026-08-21
---

# Current focus

The 2026-08-21 marketplace trust-boundary hardening is implemented and locally
verified, pending PR review and deployment. It separates moderation authority
from listing lifecycle, keeps website availability independent, makes buyer
metric provenance authoritative-only, and applies one active+verified+approved
catalog predicate from discovery through order locking.

The prior 2026-08-12 correctness/security release remains deployed at `main`
SHA `512b851`; Neon is fully migrated for that release and Render remains live
in finance-locked mode. The Northflank worker fleet remains intentionally
stopped until its protected environment and old deployment are replaced with
the matching locked release. `Work/backlog.md` owns open work and
`Work/risks.md` owns launch risks.

## Implemented in the active batch

- Added immutable `ModerationEvent` history plus current projections and
  optimistic versions for listings and websites. The migration conservatively
  backfills legacy holds without guessing their prior state.
- Replaced generic lifecycle mutations with explicit, locked staff/publisher
  policies. Operations is assignment-bounded, Finance is read-only, Super Admin
  owns exceptional reopen/archive authority, and publishers cannot clear staff
  holds unless resubmission is explicitly enabled.
- Made website pause/archive independent of listing status, and required
  APPROVED + active + VERIFIED across every buyer discovery path and checkout.
  Orderability is revalidated while locking Website, MarketplaceListing, then
  ListingService.
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

## Deliberately deferred

- Staff security and finance governance: phishing-resistant MFA, step-up,
  maker-checker for every human money/fee command, append-only staff audit
  evidence, and break-glass rehearsal.
- The worker deployment itself: the owner confirms it runs on Northflank outside
  this repository. Repository runtime contracts were still made behavioral.

## Required before paid production

- Provision and implement the chosen managed KMS/HSM adapter. The transitional
  static environment keyring is not equivalent to managed key protection.
- Keep Wise disabled until a complete quote/transfer/funding/recovery/returned-
  funds design passes real sandbox certification.
- Restore Northflank Redis capacity, re-authenticate protected settings, and
  deploy exact SHA `512b851` with the locked v2 keyring/runtime-role contract to
  the continuous `WORKER_MODE=realtime` service plus the on-demand and
  maintenance jobs. Prove each workload's SHA, mode, environment, and canary
  before scaling realtime above zero or resuming either schedule.
- Complete provider, backup/restore, paging, legal/entity, underwriting, and
  corridor-specific operational gates tracked in `Work/backlog.md`.

## Validation state

The marketplace batch passes all 1,693 API unit tests, all 459 shared tests,
all 90 API-client tests, API Nest build, Prisma format/validate/generate,
TypeScript checks for API/database/shared/API-client/admin/portal/publisher,
full ESLint for the three affected apps, Biome for every changed source file,
and `git diff --check`. The new migration has not been applied to a live
database; PR CI and a populated-clone migration rehearsal remain the next gates.

For the preceding production release, the frozen-lockfile install remained
clean. PR #100, PR #101, and final `main` push CI run `31729969759` passed
migration apply/status, the populated historical-data rehearsal,
integration-template migration, all database-backed financial suites, every
production build, UI coverage, and Chromium E2E. Neon production has all 75
pre-marketplace migrations; Render API readiness reports database and Redis
healthy on exact SHA `512b851`.

The final topology audit found the continuous Northflank `guestpost-worker`
still running one replica of incompatible SHA `0e68af7` after the migration.
It was immediately scaled to `0/0`; CI and CD are both disabled. Its last logs
show all four realtime queues failing closed on the exhausted Upstash request
quota. A least-privilege production audit then found no database activity in
the seven-second migration window or afterward, no old-image delivery snapshot
fingerprint, unchanged financial row counts, and zero lifecycle, settlement,
payout, constraint, or index anomalies. The temporary local DSN file and audit
script were destroyed. This clean containment evidence does not make the old
image safe to restart.

## Next actions

1. Review and merge the marketplace hardening PR only after CI passes. Rehearse
   `20260821120000_marketplace_moderation` on a populated clone, verify legacy
   PAUSED/ARCHIVED/inactive backfill counts and current-event pointers, hard-drain
   incompatible writers, deploy the migration before the matching API/apps, and
   monitor moderation conflicts/outbox delivery and unavailable-order rejection.
2. Restore/upgrade Upstash request capacity, then re-authenticate Northflank and
   configure the protected locked-mode environment for `guestpost-worker`,
   `guestpost-on-demand`, and `guestpost-maintenance-dispatch`. Deploy exact SHA
   `512b851`, verify each workload's SHA/mode/environment, canary realtime at one
   replica before scaling, and only then resume schedules one at a time.
3. Monitor Render readiness and Upstash usage; keep finance, payouts, and new
   deposits disabled until the operational/provider gates are explicitly met.
4. Keep staff governance and managed KMS/HSM as explicit follow-up gates rather
   than silently treating this schema/application cutover as paid-launch
   approval.
