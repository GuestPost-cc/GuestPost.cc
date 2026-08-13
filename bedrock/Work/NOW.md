---
note_type: now
project: guestpost-platform
updated: 2026-08-14
---

# Current focus

The 2026-08-12 correctness and security hardening batch is merged and deployed
at `main` SHA `512b851`. Neon production is fully migrated and the matching
Render API is live in finance-locked mode. The complete Northflank worker fleet
is intentionally stopped: the continuous realtime service is scaled to zero
and both jobs have inactive schedules. None may resume until its protected
environment and old deployment are replaced with the matching locked release.
`Work/backlog.md` owns open work; `Work/risks.md`
owns launch risks. Historical PR and rollout diaries were moved to
`History/NOW-through-2026-08-11.md`.

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
- Restore Northflank Redis capacity, re-authenticate protected settings, and
  deploy exact SHA `512b851` with the locked v2 keyring/runtime-role contract to
  the continuous `WORKER_MODE=realtime` service plus the on-demand and
  maintenance jobs. Prove each workload's SHA, mode, environment, and canary
  before scaling realtime above zero or resuming either schedule.
- Complete provider, backup/restore, paging, legal/entity, underwriting, and
  corridor-specific operational gates tracked in `Work/backlog.md`.

## Validation state

The frozen-lockfile install is clean and does not change `pnpm-lock.yaml`.
Repository type, format, lint, dependency-policy, health, API, worker, shared,
auth, integrations, API-client, and UI gates pass. PR #100, PR #101, and final
`main` push CI run `31729969759` passed migration apply/status, the populated
historical-data rehearsal, integration-template migration, all database-backed
financial suites, every production build, UI coverage, and Chromium E2E.
Neon production has all 75 migrations; the exact-clone and production
postflights matched with zero anomaly findings. Render API readiness reports
database and Redis healthy on exact SHA `512b851`.

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

1. Restore/upgrade Upstash request capacity, then re-authenticate Northflank and
   configure the protected locked-mode environment for `guestpost-worker`,
   `guestpost-on-demand`, and `guestpost-maintenance-dispatch`. Deploy exact SHA
   `512b851`, verify each workload's SHA/mode/environment, canary realtime at one
   replica before scaling, and only then resume schedules one at a time.
2. Monitor Render readiness and Upstash usage; keep finance, payouts, and new
   deposits disabled until the operational/provider gates are explicitly met.
3. Keep staff governance and managed KMS/HSM as explicit follow-up gates rather
   than silently treating this schema/application cutover as paid-launch
   approval.
