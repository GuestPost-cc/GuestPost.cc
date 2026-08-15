---
note_type: now
project: guestpost-platform
updated: 2026-08-15
---

# Current focus

The active branch `agent/fraud-case-workflow-20260815` is implementing the
confirmed delivery-fraud operational-to-financial handoff on top of
`origin/main` SHA `508b47e` (Support PR #103). Migration
`20260815120000_delivery_fraud_findings` and its matching application writers
are present only in this active change set at the time of this note. They have
not been represented as merged, applied to Neon, or deployed.

The last independently recorded production deployment remains SHA `512b851`
in finance-locked mode. A merge to `main` does not deploy Render because every
Blueprint service has manual deployment enabled. The Northflank worker fleet
also remains under the previously recorded full hold; do not infer a running
matching worker from an application build or GitHub merge.

## Implemented in the active fraud batch

- Operations or Super Admin can confirm one current delivery-fraud flag with
  expected Order/delivery versions, a bounded internal reason, and an
  actor-scoped UUID idempotency key. Confirmation is mutually exclusive with
  clearance, appends an immutable `CONFIRMED_FRAUD` finding, retains the exact
  `DeliveryFraudHold`, and moves no money.
- The same Order-locked transaction creates or escalates a structured,
  same-order `LEGAL_OR_SECURITY_EMERGENCY` cancellation review requesting
  `FULL_REFUND` before the finding is inserted. A reused `PENDING_FINANCE` case
  must already contain final responsibility, reviewer, and a bounded reason.
  The combined new command increments `Order.version` exactly once; exact
  replay increments it zero times and repairs only missing projections.
- A finding-linked cancellation can progress only through Operations/Super
  Admin full-refund review to `PENDING_FINANCE`, then a separate Finance/Super
  Admin canonical refund approval to `APPROVED`. Continue-order, dispute,
  rejection, withdrawal, deletion, repurposing, and terminal evidence rewrite
  fail closed.
- Force cancellation and dispute refund refuse a confirmed-fraud Order under
  the aggregate lock. A deferred Order constraint independently forbids
  `CANCELLED`/`COMPLETED` shortcuts and permits `REFUNDED` only when every
  linked case has complete approved full-refund evidence at commit.
- PostgreSQL independently enforces live staff authority, same-order linkage,
  permanent hold retention, full-refund state, exact canonical refund facts,
  append-only approved cancellation evidence, a restrictive refund foreign
  key, and update/delete/truncate denial for the linked approved REFUND ledger
  row.
- Customer, publisher, Operations, Finance, and Super Admin Order pages receive
  audience-specific timeline entries derived from immutable domain/ledger
  facts. Confirmation, clearance, refund, and publisher-compensation events use
  transactional outbox rows with stable decision-bound dedup keys. External
  projections never consume raw staff notes, `OrderEvent.message`, audit text,
  provider details, support IDs, or generic metadata.
- The dedicated production runbook now covers a populated-clone rehearsal,
  rotated direct deploy credential, exact identifier-safe runtime grants,
  API/all-worker hard drain, migration status and integrity postflight,
  `recovery_only` canaries, intentional server-only return to `normal`, payout
  execution remaining false, and forward-fix/PITR recovery.

## Explicitly unchanged

- Staff security and finance governance remains owner-deferred: phishing-
  resistant MFA, recent step-up authorization, universal human money-command
  maker-checker, append-only staff-security evidence, and break-glass rehearsal
  are still paid-launch gates. Super Admin can currently authorize both the
  operational and financial fraud commands; this batch does not claim actor
  independence.
- The existing managed KMS/HSM, provider certification, legal/entity, browser
  acceptance, Redis capacity, and worker rollout gates remain open. This fraud
  correctness batch does not certify paid production.

## Validation state

Database client generation/build, the API and API-client builds, Admin
TypeScript, and focused fraud, cancellation, refund, settlement-gating,
timeline, communication, and client suites have passed during active
development. The local full Admin Next production build reached a sandbox-only
Turbopack port-permission failure and is not recorded as a passing build. Final
repository CI, real PostgreSQL migration execution on a populated clone,
runtime-role canaries, and production postflight remain release gates. No Neon
migration or deployment was performed by this documentation pass.

## Next actions

1. Freeze the application/schema/migration diff, run format/type/lint/build and
   the complete focused plus database-backed CI matrix, and resolve every
   failure without weakening an invariant.
2. Rotate any database credential exposed outside approved secret storage.
   Rehearse the unchanged migration on a recent populated Neon branch/clone
   through a direct deploy-role DSN and execute the exact runtime grant/denial
   proof through the pooled API/worker role.
3. Create the production PITR marker, drain Render API and every Northflank
   `realtime`, `on-demand`, `scheduled`, and ad-hoc writer, prove zero old
   sessions/in-flight work, then apply the migration once.
4. Start only the matching image in `FINANCE_RUNTIME_MODE=recovery_only`; run
   migration status, privilege, invariant, reconciliation, replay,
   force-cancel/dispute-refund denial, stakeholder-timeline, and outbox canaries
   without real customer money.
5. Only after those gates pass, deliberately set server-only
   `FINANCE_RUNTIME_MODE=normal` for the intended replicas. Keep
   `PAYOUT_EXECUTION_ENABLED=false` until its separate certification gate is
   approved.
