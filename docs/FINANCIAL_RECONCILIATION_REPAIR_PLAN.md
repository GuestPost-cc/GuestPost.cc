# GuestPost Financial Reconciliation and Repair Plan

## Purpose

Make financial drift visible, explainable, and safely repairable from the Admin
portal without editing or deleting historical ledger evidence. The workflow
covers detection, investigation, approval, correction, verification, and
stakeholder communication. A finding is never itself permission to move money.

This is an implementation plan, not approval to change any live account. The
first use case is the force-cancel order shown in the September 30, 2026
incident: an order for USD 5.00 was force-cancelled with USD 5.00 publisher
compensation, while a separate USD 5.00 customer refund was also recorded.
Under that decision, the expected customer refund is USD 0.00 and total
publisher compensation plus customer refund must not exceed captured order
value. The expected correction is to retain valid publisher compensation and
investigate/reverse the unsupported customer wallet credit only if the evidence
and available customer balance permit it.

## Confirmed project behavior

- `packages/shared/src/reconciliation-core.ts` owns reconciliation rules shared
  by the API and worker. It already reports invalid force-cancel publisher
  compensation evidence and refunds exceeding the amount supported by the
  terminal order.
- `apps/api/src/modules/admin/reconciliation.service.ts` runs the scan and
  writes a staff audit event. `GET /admin/reconciliation` is staff-protected;
  it does not repair money.
- `apps/admin/src/app/dashboard/finance/page.tsx` describes this as a read-only
  scan and directs staff to inspect linked records. Findings for the same order
  can appear as separate rows; operators need one case and one proposed action.
- `apps/api/src/modules/orders/services/refund.service.ts` is the canonical
  order refund writer. `docs/ORDER_CANCELLATION.md` says refunds currently
  credit the GuestPost organization wallet; this is not proof that a specific
  incident has no separate provider movement, which still must be checked.
- `docs/FINANCIAL_INVARIANTS.md` requires provider truth, immutable history,
  an incident-linked and idempotent compensating command, atomic ledger /
  aggregate / audit / notification intent, production independent review, and
  a before-and-after reconciliation.
- `bedrock/Work/NOW.md` records that universal staff step-up/MFA is currently
  owner-deferred and this incident's order-level staging canary has not yet
  been run. These are explicit rollout constraints, not assumed complete.

## Non-negotiable accounting rules

1. Never edit/delete a transaction, refund, compensation decision, audit entry,
   or provider evidence. Correct with a new, linked compensating entry.
2. Never provide a generic amount/balance editor or an unrestricted
   “mark resolved” action. Only supported, typed repair recipes may move money.
3. Use integer minor units or exact Prisma `Decimal`, explicit `USD`, and
   server-derived amounts. The browser may request a preview but cannot choose
   a new balance or authoritative correction amount.
4. A refund and publisher compensation are separate liabilities. Validate the
   complete order disposition as one unit; do not fix each displayed finding
   independently.
5. A wallet credit is internal GuestPost liability. Verify it against the
   original refund transaction and provider records; never infer an external
   card/bank refund from a GuestPost ledger row.
6. If evidence conflicts, funds have been spent/reserved, currency is invalid,
   or no approved repair recipe applies, make no mutation. Escalate for manual
   Finance decision rather than creating a negative wallet or taking unrelated
   funds.
7. Re-running the same command must not make another ledger entry. Retrying
   with changed inputs must conflict.

## Target operator workflow

### 1. Detect and open one case

Keep scans detection-only. Persist each run's version, time, detector, and
finding snapshots; group related findings by authoritative aggregate (for this
case, `orderId`) into one reconciliation case. Retain each finding code and
source snapshot so multiple symptoms do not create multiple repair buttons.
Use a deterministic fingerprint over the aggregate, finding code(s), and
immutable evidence identities to deduplicate recurring scans while preserving
new evidence revisions.

The case page should show order amount/currency/status/version; captured
`PURCHASE`; all `REFUND` and compensation rows and their source references;
customer and publisher wallet identities and available/reserved balances;
relevant cancellation/dispute decision and reason; provider evidence/status;
and expected-versus-actual totals. Clearly label evidence that is missing or
not independently verified. Do not expose private provider payloads or
internal notes to customers/publishers.

### 2. Investigate and preview a typed repair

The server re-reads current rows and determines the supported target state.
For the example, target totals are USD 5.00 compensation + USD 0.00 refund =
USD 5.00 order capture. The UI can propose a reversal of the exact erroneous
USD 5.00 customer wallet credit, but only after confirming all of the following:

- the order is the expected terminal force-cancel decision and the recorded
  responsibility/reason authorizes full publisher compensation;
- the compensation amount, publisher identity, ledger credit/debt disposition,
  order amount, and currency match authoritative evidence;
- the target `REFUND` transaction is the unique erroneous credit for this
  order, is not already reversed, and is not an actual separate provider
  refund;
- a locked, fresh read shows enough *available* customer wallet liability to
  reverse the credit; reserved funds are not spendable for this purpose;
- there is no concurrent order/wallet mutation, unresolved payment dispute, or
  other state that makes the proposed correction ambiguous.

The preview must state exactly which entries will be appended, which balances
will change, which original evidence remains untouched, and why. Bind the
approval to a digest of the case evidence, exact amount/currency, and command
version. Any relevant evidence change expires the preview and requires a new
one.

If the refund credit has been spent or reserved, or provider/order evidence is
ambiguous, the supported result for the first release is **blocked / Finance
review required**. Do not debit other customer deposits, permit an overdraft,
or silently create a receivable. A customer recovery / receivable policy would
be a separate, explicitly approved product/accounting decision.

### 3. Approve and apply

Use maker-checker approval for production: the initiator cannot approve their
own correction. Restrict the action to authorized Finance/Super Admin staff;
Operations may inspect but cannot move money. Require a reason, incident/case
reference, current expected versions, and scoped idempotency key. Require
recent step-up authentication when the project's staff-security capability is
available; do not treat that capability as already implemented.

Classify this as a financial recovery operation: allow it only in
`FINANCE_RUNTIME_MODE=recovery_only` (not `locked`), using the existing
fail-closed runtime policy. An emergency policy may keep new liabilities and
external sends paused while permitting this narrowly scoped correction.

In one bounded serializable transaction:

1. lock and re-read the Order and customer Wallet in the documented global
   order; revalidate case evidence, source refund, compensation, provider truth,
   balances, approval, runtime mode, and expected versions;
2. claim the scoped idempotency identity and compare immutable command inputs;
3. append one typed, exact-source refund-reversal ledger transaction (the
   precise `TransactionType`, database guards, reconciliation sums, and report
   treatment must be designed together);
4. update the wallet available balance/version by the same exact amount, with
   a database constraint/guard proving the reversal links to one eligible
   source refund and cannot exceed its unreversed amount;
5. append the immutable repair execution record, actor/approver identities,
   reason, case/evidence digest, before/after amounts, and audit event;
6. write any mandatory durable notification intent in the same commit.

No provider API call belongs inside this transaction. If external provider
money actually moved, do not use the internal-wallet repair recipe; create a
separate provider recovery case and establish provider truth first. A database
rollback must never be mistaken for a reversal of external money.

### 4. Verify and close

After commit, rerun the canonical shared reconciliation. Close the case only
when the original findings no longer reproduce, the order's disposition sums
to its capture, wallet aggregate equals its append-only ledger, compensation
and refund evidence link to the same order/currency, and provider evidence
agrees. Store the before-and-after report and exact repair transaction IDs.
If verification fails, mark the case attention-required and stop retries from
reapplying the correction.

Show the customer the actual refund amount and status, and show the publisher
their compensation amount, reason, and status on their respective order views.
Use the existing audience-safe order event/communications patterns; never
surface staff-only evidence or the other party's private account information.
For a correction that changes a customer wallet credit, send a clear, factual
notice through the durable communications outbox with a support/case reference.

## Admin interface and API shape

Keep the current reconciliation scan read-only. Add a case workbench with
`Detected`, `Needs evidence`, `Awaiting approval`, `Applied`, `Verified`, and
`Blocked` states. Each order case has a timeline, evidence panel, inspection
links, an explicit preview, and—only when eligible—separate propose, approve,
and execute controls. Never expose an execute control for unsupported findings.

Proposed API surface (final paths can follow existing admin conventions):

- `GET /admin/reconciliation/cases` — filter, sort, and page durable cases.
- `GET /admin/reconciliation/cases/:id` — current evidence and immutable
  activity.
- `POST /admin/reconciliation/cases/:id/preview` — read-only, version-bound
  proposal.
- `POST /admin/reconciliation/cases/:id/approve` — independent approval of
  the exact preview digest.
- `POST /admin/reconciliation/cases/:id/execute` — idempotent, typed recovery
  command; returns the canonical result on an exact retry.
- `POST /admin/reconciliation/cases/:id/verify` — run/attach a fresh scan;
  preferably automated after execution and also available for an operator
  retry.

Authorization, mode checks, amount derivation, evidence reads, approval
separation, and idempotency are enforced in the API/domain service and database,
not just hidden/disabled in React. Keep controllers thin. Responses and logs
must not leak secrets or raw provider payloads.

## Data and migration design

Before adding schema, inspect all `TransactionType` checks, refund and wallet
ledger sum calculations, reconciliation queries, database triggers, generated
financial reports, and transaction-reference uniqueness rules. Add the
smallest durable case/repair records needed for deduplication and immutable
execution history. A repair record should bind one case, one exact source
transaction, one compensating transaction, exact USD amount, reason, evidence
fingerprint, initiator, independent approver, idempotency key, and timestamps.
Unique constraints must prevent multiple repairs of the same source amount and
duplicate command keys. Database guards must reject mutation/deletion and
invalid cross-order, cross-wallet, cross-currency, or over-reversal links.

The reconciliation scanner should distinguish a valid reversal from an
additional refund; it must validate both source and compensation evidence and
not count a repair twice. Migrations must be additive, fail closed on
unclassifiable historical rows, and never silently backfill an assumed
financial outcome.

## Delivery phases and exit criteria

### Phase 0 — Incident evidence and design sign-off

- Snapshot the order, all ledger/compensation/cancellation/dispute rows, audit
  events, wallet aggregate and ledger-derived balance, and provider evidence.
- Confirm the customer refund was an internal GuestPost wallet credit and
  whether it remains available, is reserved, or was spent.
- Have Finance approve the disposition and confirm behavior for spent credits.
- Do not repair production as part of feature development or use direct balance
  SQL. If the evidence is incomplete, preserve the case without mutation.

**Exit:** signed evidence-backed target for the incident and documented
blocked path for unavailable/ambiguous funds.

### Phase 1 — Case model and detection UX

- Persist deduplicated grouped case snapshots and lifecycle audit events.
- Group all findings for one order, link to order detail, and display source
  amounts/reasons and expected versus actual disposition.
- Make unsupported cases explicitly read-only; no money command yet.

**Exit:** repeated scans are idempotent, existing detectors still agree between
API and worker, permissions are tested, and case history is immutable.

### Phase 2 — Preview, approval, and one repair recipe

- Implement only the exact erroneous internal refund-credit reversal described
  here; no generic adjustments, partial refunds, or provider refunds.
- Add two-person approval, exact-source matching, available-funds preflight,
  `recovery_only` gate, serializable transaction, idempotency, audit, DB guard,
  and durable notification.
- Add reconciliation support for the new compensating transaction.

**Exit:** unsafe cases fail closed; parallel/replayed commands yield exactly
one compensation; a source refund cannot be reversed more than once or across
orders/wallets/currencies.

### Phase 3 — Verify, communicate, and stage

- Display customer refund and publisher compensation facts on the correct
  audience-specific order pages, preserving each decision reason without
  leaking internal notes.
- Run migration and end-to-end test in isolated Coolify staging with test-only
  DB/payment credentials and `recovery_only` behavior.
- Exercise the $5 force-cancel case plus failure/concurrency matrix below.

**Exit:** staging canary proves `purchase = compensation + supported refund`
and wallet aggregate = ledger, with fresh reconciliation clear and one
customer/publisher view each showing correct amounts/reasons.

### Phase 4 — Reviewed release and controlled production use

- Open a follow-up PR with migration review, API/UI tests, full CI, CodeRabbit,
  Strix, code-owner approval, and resolved threads. Do not merge/deploy this
  feature on the authority granted for PR #145; obtain release approval for
  this new change separately.
- Deploy with the repair action disabled. Verify migration and read-only case
  ingestion first; enable the action only after backup/evidence readiness,
  tested rollback/forward-fix plan, two trained staff accounts, and on-call
  monitoring.
- Perform one approved repair at a time. Keep auto-repair out of scope.

**Exit:** production repair has independent approval, complete before/after
evidence, clear post-repair reconciliation, and no unexplained ledger/provider
variance.

## Required test matrix

- Happy path: exact source refund, compensation is valid, balance available,
  provider evidence confirms internal wallet credit only.
- Already reversed / duplicate click / network retry: one ledger reversal and
  identical canonical result.
- Same idempotency key with changed amount, actor, source, or reason: conflict.
- Two concurrent operators, two competing cases for one order, and a wallet
  spend between preview and execute: one winner or safe conflict; never double
  debit.
- Customer balance below correction amount; amount partly spent; amount
  reserved; wallet/ledger drift; invalid currency/precision: no mutation and
  blocked case.
- No publisher compensation, partial compensation, invalid reason, wrong
  publisher, wrong order, multiple refund rows, missing purchase, refund already
  externally sent, and unresolved dispute: no unsupported recipe executes.
- Wrong role, self-approval, stale approval digest, changed order version,
  missing/invalid mode, `locked`, and `recovery_only`: rejected as policy
  requires.
- Failures injected between ledger/balance/audit/notification writes:
  transaction commits all or none; durable notification retry does not repeat
  money movement.
- Database tests prove append-only repair evidence, exact source linkage,
  no over-reversal, and exact USD/refund aggregation. API and worker scans
  report the same result.
- Re-run reports zero original findings only after evidence validates; false
  positive dismissal never changes balances.

## Monitoring and operational controls

Page Finance on critical reconciliation cases and any case blocked past its
review SLA. Track counts and age by finding code and case state, repair preview
to approval latency, rejected/blocked reasons, idempotent retries, verification
outcomes, and post-repair recurrence. Avoid logging customer email, provider
secrets, or raw payloads. Keep a kill switch for new repair execution that
leaves reads, evidence capture, and case review available. If correctness is
uncertain, set finance to `recovery_only` or `locked` per the incident runbook;
never quiet an alert by resolving/dismissing a case without matching evidence.

## Decisions still required before implementation

1. Finance must confirm the example incident's provider and wallet evidence and
   disposition; screenshot findings alone do not prove whether the customer
   used the wallet credit.
2. Product/Finance must decide what to do if an erroneous refund credit has
   already been spent. This plan defaults to blocked/manual review and does not
   create customer debt or a negative wallet.
3. Security owners must define the available staff step-up authentication
   mechanism and production eligibility, since universal staff step-up/MFA is
   not currently recorded as implemented.
4. Finance must approve the customer-facing wording and notification timing
   when a prior wallet credit is reversed.

Until those decisions and staging exit criteria are met, reconciliation remains
detection-only for financial corrections.
