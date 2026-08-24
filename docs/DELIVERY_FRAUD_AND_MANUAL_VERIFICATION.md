# Delivery fraud and manual verification

## Purpose

Delivery verification is settlement evidence, not only a user-interface state.
This document describes how automated fraud signals, customer delivery actions,
staff intervention, audit evidence, notifications, and settlement eligibility
fit together.

The authoritative state is the database. Application checks provide clear
errors and least-privilege workflows; PostgreSQL triggers and the canonical
settlement gate remain the final backstop.

## Detection and escalation

`packages/shared/src/delivery-verification-core.ts` independently fetches the
submitted page, records immutable verification evidence and a content-addressed
snapshot, and evaluates these signals:

- `URL_REUSED`: the normalized published URL exists on another order;
- `TARGET_MISMATCH`: the purchased target URL is absent;
- `ANCHOR_MISMATCH`: the purchased anchor does not match;
- `DOMAIN_MISMATCH`: the delivery is on a different registrable host;
- `RAPID_DELIVERY`: one submitter crosses the bounded submission-rate signal.

Page-local signals are computed before the transaction, then revalidated and
inserted only after the worker takes the canonical Order lock and confirms the
signed delivery generation is still active. `URL_REUSED` is different because
it crosses Order aggregates: the worker takes a transaction-scoped advisory
lock keyed by the normalized URL and recomputes that signal inside the final
transaction. A stale or superseded job cannot attach a hold to the current
order state, and a concurrent claim cannot land between the URL evidence read
and the verification decision.

A technically passing page with any fraud signal is `MANUAL_REVIEW`, never
automatically `VERIFIED`. Each new immutable `DeliveryFraudFlag` is projected by
PostgreSQL into one current `DeliveryFraudHold`. A durable, required
`STAFF_FRAUD_ALERT` communication is recorded in the same transaction for
Operations, Finance, and Super Admin recipients. Its payload contains internal
flag identity and type, but no page HTML, secrets, or cross-order customer data.

## Customer confirmation and a previously used URL

Both customer paths enforce the same policy:

1. Normal confirmation of an automatically verified delivery.
2. Manual customer acceptance after a technical `FAILED` or `MANUAL_REVIEW`
   result.

After taking the Order lock, the API revalidates tenant scope, active
membership, creator-or-owner authority, active delivery identity, cancellation
state, and the authoritative `DeliveryFraudHold` projection. Before trusting a
previous `AUTHORIZED_REUSE`, it also takes the normalized-URL lock and rebuilds
the current claim-set fingerprint. A new claimant creates a fresh immutable
`URL_REUSED` flag/hold and the denial transaction commits that evidence without
committing a delivery or money transition. If any hold exists:

- the API returns HTTP `409` with code `DELIVERY_FRAUD_REVIEW_REQUIRED`;
- the response does not expose the signal type, related order, investigator
  notes, or evidence details;
- no delivery, Order, Settlement, PlatformRevenue, or communication lifecycle
  mutation is committed;
- a throttled audit record captures the denied action, actor, delivery, hold
  count, flag IDs, and types for staff investigation.

The same actor/action/delivery denial is written at most once per hour. This
retains evidence without allowing repeated clicks to amplify audit storage.

After every hold is independently resolved, a customer may accept a technically
unverifiable delivery if it still satisfies the normal fallback rules. Resolving
a hold does not itself approve a delivery or release money.

## Staff adjudication and separation of duties

Delivery approval and fraud adjudication are separate commands:

- Operations or Super Admin may manually approve/reject delivery evidence.
- Operations, Finance, or Super Admin may classify a signal as
  `FALSE_POSITIVE`.
- Only Finance or Super Admin may classify `AUTHORIZED_REUSE` or
  `RISK_ACCEPTED` because those decisions knowingly authorize money-adjacent
  risk. `AUTHORIZED_REUSE` is valid only for a `URL_REUSED` signal; other
  signal types must be classified as a false positive or explicitly accepted
  risk.

Every fraud resolution requires a 20–1,000 character reason and one allowlisted
disposition. A false positive may include an evidence/case reference; known URL
reuse or accepted risk requires one, bounded to 200 characters.
The current staff membership, role, staff user type, and ban state are
revalidated under the Order lock. The role, disposition, evidence reference,
order/delivery identity, signal type, and order status are snapshotted in the
append-only resolution and audit evidence.

Re-verification honors a classified staff disposition only when the delivery
version, signal type, and complete signal details exactly match the adjudicated
flag. URL-reuse details include an exact conflict count plus a bounded,
deterministic fingerprint of the append-only cross-order claim set. The worker
validates the classification, role-at-time snapshot, and any required evidence
reference again under the Order and normalized-URL locks, then records
`ORDER_DELIVERY_FRAUD_DISPOSITION_REUSED`. Changed details—including an
increased reused-URL conflict count—are new evidence and create a new immutable
flag and hold. Historical resolutions without a classified disposition always
fail closed and cannot authorize a retry.

The manual-approve and Super Admin verification-override paths fail with
`DELIVERY_FRAUD_REVIEW_REQUIRED` while any order-level hold remains. They never
clear holds as a side effect. The compatibility admin routes delegate to this
same intervention service, so there is no status-only bypass.

Successful manual verification sets the configured customer review window and
records `autoAcceptAt`. Reversing verification clears that deadline so an old
timer cannot later auto-accept a failed delivery.

## Confirmed fraud and the financial handoff

Clearing a signal and confirming a policy violation are deliberately different
commands. Operations or Super Admin may confirm a current held flag by sending
the expected Order version, the exact delivery verification version, a
substantive 20–1,000 character internal reason, and an actor-scoped UUID
idempotency key. Finance is view-only for the confirm-violation command; its
separate, policy-bounded clearance/risk-disposition authority is unchanged.

Confirmation appends one `DeliveryFraudFinding`; it does **not** append a
`DeliveryFraudFlagResolution`, delete `DeliveryFraudHold`, approve or reject a
delivery, or move money. The hold remains authoritative and continues blocking
customer acceptance, settlement creation/approval/release, and platform
revenue. Confirmation and clearance are mutually exclusive behind the same
Order fence, so concurrent different decisions have one winner and the loser
receives a conflict. A new confirmation treats the cancellation handoff and
finding as one aggregate command: after the finding trigger validates the
expected version, `Order.version` advances exactly once. An exact retry returns
the existing finding, does not advance the Order version, and repairs its
durable communication projections without duplicating evidence.

The same transaction enters the finding into the structured cancellation
workflow:

1. Reuse the one active same-order case when one exists. A `REQUESTED` or
   `UNDER_REVIEW` case is escalated; a complete `PENDING_FINANCE` full-refund
   case may be reused only when it already has `FULL_REFUND`, final
   responsibility, reviewer, and a trimmed 20–2,000 character review reason.
   An inconsistent or terminal stable-key case fails closed.
2. Otherwise create an `ESCALATED`, staff-requested
   `LEGAL_OR_SECURITY_EMERGENCY` case with `FULL_REFUND` requested and
   responsibility still `UNDETERMINED`. The case is created with a configured
   review deadline (`FRAUD_REVIEW_WINDOW_HOURS`, 48 hours by default) so the
   existing deadline-ordered workbenches flag it overdue from creation; the
   cancellation timeout sweep additionally nudges the accountable staff roles
   while the case sits unresolved.
3. Operations or Super Admin assigns final responsibility, records a bounded
   review reason, and recommends `FULL_REFUND`. A finding-linked case cannot
   continue the Order, become a dispute, be withdrawn, rejected, deleted, or
   be repurposed.
4. Finance or Super Admin decides the refund in a separate money command and,
   when the publisher had completed compensable work, supplies an exact USD
   publisher compensation disposition. The existing canonical refund primitive
   writes wallet, ledger, credit note, compensation/debt, event, audit, and
   outbox evidence atomically.

Both review and Finance approval re-lock current `StaffMembership` and `User`
authority after the canonical Order lock. PostgreSQL independently checks the
live role and user state, the full-refund state machine, same-order linkage, and
the exact canonical refund. The approved cancellation row, finding, and linked
refund ledger facts are append-only. Corrections use compensating evidence;
they never rewrite the decision that authorized the original outcome.

Super Admin force cancellation and dispute refund both recheck for a confirmed
finding under the Order lock and direct staff to the linked case instead of
moving money. A `DEFERRABLE INITIALLY DEFERRED` Order constraint trigger is the
direct-SQL/alternate-writer backstop: `CANCELLED` and `COMPLETED` are invalid
terminal shortcuts, while `REFUNDED` is valid only after every linked finding's
case is `APPROVED` with complete full-refund Finance evidence. Deferral lets the
canonical refund update the Order before finalizing the linked case inside one
transaction, then validates the complete aggregate at commit.

This is command and role separation, not maker-checker actor independence: a
Super Admin is currently authorized on both commands. Universal human-initiated
money-command maker-checker and step-up authorization remain explicitly deferred
paid-launch governance work.

## Stakeholder updates and notifications

The Order page is the durable stakeholder record; email and in-app messages are
delivery channels, not the source of truth. The API builds a typed,
audience-specific stakeholder timeline from immutable flags, findings,
resolutions, REFUND transactions, and `PublisherCompensation` records. It never
projects free-form `OrderEvent.message`, generic event metadata, AuditLog text,
provider references, or staff cancellation notes.

- Customers see a safe review state, the final delivery-policy result, and
  their exact wallet refund. They never see signal details, cross-order IDs,
  investigator reasons, staff identity, publisher compensation, or debt.
- Publishers see safe remediation/result copy plus their exact compensation,
  debt applied, and net publisher credit. They never see customer financial
  references or internal evidence.
- Operations sees delivery evidence and the operational outcome, but no
  customer refund, publisher compensation, or debt amounts.
- Finance sees the internal finding reason and canonical refund/compensation
  facts needed for the financial decision. Finance cannot retry, approve,
  reject, or reverify delivery evidence.
- Super Admin sees the full staff-authorized operational and financial view.

Each confirmation, clearance, refund, and compensation decision records
audience-specific `CommunicationEvent` rows inside its domain transaction and
dispatches only after commit. Dedup keys bind the immutable decision identity
and audience. Clearing one of several holds says that review continues; only
the final cleared hold says normal checks may resume. Missing notification
workers cannot erase the committed Order-page history, and the database outbox
sweep recovers delivery later.

## Concurrency and database authority

Sensitive paths use `runLockedOrderSerializableTransaction`. The Order row is
the first lock. A delivery claim writer then takes the normalized-URL advisory
lock before inserting `OrderDeliveryVersion`; verification, both customer
acceptance paths, auto-accept, and every settlement eligibility boundary take
the locks in the same `Order -> normalized URL` order. Fraud
flag/hold/resolution/finding triggers take the same parent lock and advance the
settlement fence, closing these races:

- customer acceptance versus fraud flag insertion;
- staff approval versus fraud adjudication;
- confirmed finding versus clearance or restoration;
- confirmed finding versus cancellation review, staff offboarding, or refund;
- fraud resolution versus settlement creation or release;
- delivery re-verification versus supersession or another intervention.

The database also takes the identical advisory lock for every delivery-version
insert, update, and delete. Its URL trigger sorts after the existing
`OrderDeliveryVersion_settlement_order_lock` trigger, so even an older pod in a
rolling deploy is forced through the same `Order -> URL` sequence. A backfilled
`DeliveryUrlClaimFence` row is locked by readers and advanced by every claim
mutation. This MVCC-visible fence forces a stale `SERIALIZABLE` waiter to retry;
an advisory lock alone would retain the waiter's old snapshot. Application
predicate serialization by itself is also insufficient because an unrelated
cross-order insert can legally serialize reader-first without a cycle. Deploy
the `20260811133000_delivery_url_claim_fence` migration before rolling
application instances that rely on URL-claim freshness.

The restricted API/worker database role must receive schema `USAGE` (never
`CREATE`) on `public`, table `SELECT`,
column-scoped `INSERT ("normalizedUrl", "version")` and `UPDATE ("version")`
on `DeliveryUrlClaimFence`, plus `EXECUTE` on
`acquire_delivery_url_claim_fence(text)` before the new image starts. The
trigger function is not an application call surface and does not need a
runtime `EXECUTE` grant. In hardened clusters, revoke the default `PUBLIC`
function grants and grant only this application function to the runtime role.
Both functions are security-invoker functions, so missing table DML fails
closed and cannot be bypassed through function execution; do not work around
that failure by granting schema creation, ownership, superuser, `BYPASSRLS`,
or deploy-role membership. Prove the exact runtime connection can acquire one
transaction-scoped fence on a disposable URL and that the transaction rolls
back before reopening acceptance or settlement.

If a final API money-release decision discovers a new claim fingerprint, it
returns a tagged block from the database callback so the new flag/hold commits,
then raises the public `SETTLEMENT_BLOCKED` error after commit. Throwing inside
that callback would erase the very evidence that prevented release.

`DeliveryFraudFlag`, `DeliveryFraudFlagResolution`, and
`DeliveryFraudFinding` are append-only evidence. `DeliveryFraudHold` is the
database-maintained current projection. A hold can be deleted only by the
matching immutable resolution transaction; a confirmed finding deliberately
retains it. Settlement and platform-revenue eligibility independently reject
every current order-level hold even if an application caller is defective.

## Operator runbook

1. Open **Delivery Verification**. Fraud cases are critical-priority entries.
2. Compare the flagged delivery, immutable verification evidence, other-order
   reference (when applicable), page snapshot, and relevant support/case
   evidence.
3. For a false positive or explicitly authorized risk, select the narrowest
   accurate disposition and add the evidence reference. Resolve each flag
   independently; resolution alone does not approve delivery or move money.
4. For a confirmed violation, Operations or Super Admin uses **Confirm
   violation**. Open the linked cancellation review; never try to clear the
   retained hold.
5. Operations or Super Admin assigns responsibility and sends the linked case
   to Finance as `FULL_REFUND`. Finance or Super Admin reviews the exact refund
   and publisher compensation policy and records its substantive decision.
   Do not substitute force cancellation or dispute refund; both are blocked
   while confirmed-fraud evidence exists.
6. Confirm that the Order page shows the finding, cancellation state, customer
   refund, and publisher outcome appropriate to the current viewer. Internal
   reasons must not appear in customer/publisher API responses.
7. For cleared evidence, re-run automated verification, manually approve,
   reject, or wait for customer fallback as appropriate. Changed evidence is a
   new immutable flag and hold.
8. Confirm that settlement review has no current hold before release. A
   confirmed finding retains its hold permanently; its Order is resolved only
   through the linked terminal refund workflow.

Finance can read the queue and resolve classified risk. Delivery retry,
approval, rejection, and re-verification requests remain restricted to
Operations and Super Admin.

## Relevant code

- `packages/shared/src/delivery-verification-core.ts`
- `packages/shared/src/delivery-url-claim-core.ts`
- `packages/shared/src/settlement-gating.ts`
- `apps/api/src/modules/orders/services/delivery-fraud-guard.ts`
- `apps/api/src/modules/orders/services/order-delivery.service.ts`
- `apps/api/src/modules/orders/services/order-review.service.ts`
- `apps/api/src/modules/orders/services/delivery-intervention.service.ts`
- `apps/api/src/modules/admin/verification-queue.service.ts`
- `packages/database/prisma/migrations/20260802094000_delivery_fraud_resolutions/migration.sql`
- `packages/database/prisma/migrations/20260811120000_delivery_fraud_resolution_dispositions/migration.sql`
- `packages/database/prisma/migrations/20260811133000_delivery_url_claim_fence/migration.sql`
- `packages/database/prisma/migrations/20260815120000_delivery_fraud_findings/migration.sql`
