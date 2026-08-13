---
note_type: now
project: guestpost-platform
updated: 2026-08-13
---

# Current focus

The active branch contains the 2026-08-12 correctness and security hardening
batch. It has not been deployed. `Work/backlog.md` owns open work;
`Work/risks.md` owns launch risks. Historical PR and rollout diaries were moved
to `History/NOW-through-2026-08-11.md`.

## Implemented in the active batch

- Removed phantom `OrderStatus.SETTLED`; `COMPLETED` is the sole successful
  terminal order status. Settlement approval, return-to-review, and release now
  have distinct relationally bound events.
- Added server-computed settlement eligibility for Finance and aligned release
  ordering and Decimal-only balance invariants.
- Made emergency cancellation serializable and order-locked. Unpaid reservation
  release now writes exact ledger evidence and reconciliation checks it.
- Post-publication publisher refunds require an explicit compensation
  disposition, including `NONE`, with immutable ledger/event evidence and debt
  netting.
- Added authenticated Stripe deposit recovery with fenced leases, append-only
  bounded evidence, and the same serializable finalizer as signed webhooks.
- Added payout-encryption v2 envelopes with immutable-context AAD, key identity,
  legacy decrypt-only reads, resumable CAS rotation, verification, and a
  deployment runbook.
- Made the 30-second auth projection presentation-only. Every protected request
  resolves durable tenant, membership, role, and permission authority; money
  mutations recheck relevant membership inside their locked transaction.
- Quarantined Wise completely from runtime registration and legacy polling.
- Replaced duplicated order-transition writers with one mandatory status/version
  CAS and modeled payment capture/submission as one externally visible command.
- Replaced worker source-string contracts with typed runtime plans and
  dependency-injected behavioral boot/shutdown tests.
- Added strict shared browser API-origin resolution and a self-starting,
  CI-gated Chromium onboarding harness. Existing financial API integration
  suites remain the money-invariant system tests.
- Added missing CSRF compatibility-path tests; the reported missing-Origin
  bypass was not present because the primary middleware already rejects missing
  Origin and Referer for unsafe cookie-authenticated requests.

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
- Run the full populated PostgreSQL migration rehearsal and all CI gates against
  this exact change set; no persistent database has been migrated by this task.
- Complete provider, backup/restore, paging, legal/entity, underwriting, and
  corridor-specific operational gates tracked in `Work/backlog.md`.

## Validation state

The frozen-lockfile install is clean and does not change `pnpm-lock.yaml`.
Repository type, format, lint, dependency-policy, health, API, worker, shared,
auth, integrations, API-client, and UI gates pass locally. PR #100's GitHub CI
also passes migration apply/status, the populated historical-data rehearsal,
the integration-template migration, all database-backed financial suites, all
production builds, Ubuntu/Poppler worker coverage, UI coverage, and the
self-starting Chromium onboarding journeys. No persistent production database
has been migrated by this task.

## Next actions

1. Review PR #100 against `main`; keep staff governance and managed KMS/HSM as
   explicit follow-up gates rather than silently widening this batch.
2. Rehearse the hard-drain schema-before-code rollout on a recent Neon branch
   using a direct connection, then record a production restore/PITR point.
3. Confirm every API, Northflank worker, scheduler, webhook, reconciliation,
   and recovery writer is drained before `prisma migrate deploy`; deploy the
   matching application images before writers resume.
