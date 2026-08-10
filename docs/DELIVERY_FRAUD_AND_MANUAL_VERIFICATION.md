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

Signals are computed before the transaction, then revalidated and inserted
only after the worker takes the canonical Order lock and confirms the signed
delivery generation is still active. A stale or superseded job cannot attach a
hold to the current order state.

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
state, and the authoritative `DeliveryFraudHold` projection. If any hold exists:

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
flag. The worker validates the classification, role-at-time snapshot, and any
required evidence reference again under the Order lock, then records
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

## Concurrency and database authority

Sensitive paths use `runLockedOrderSerializableTransaction`. The Order row is
the first lock. Fraud flag/hold/resolution triggers take the same parent lock and
advance the settlement fence, closing these races:

- customer acceptance versus fraud flag insertion;
- staff approval versus fraud adjudication;
- fraud resolution versus settlement creation or release;
- delivery re-verification versus supersession or another intervention.

`DeliveryFraudFlag` and `DeliveryFraudFlagResolution` are append-only evidence.
`DeliveryFraudHold` is the database-maintained current projection. A hold can be
deleted only by the matching immutable resolution transaction. Settlement and
platform-revenue eligibility independently reject every unresolved order-level
hold even if an application caller is defective.

## Operator runbook

1. Open **Delivery Verification**. Fraud cases are critical-priority entries.
2. Compare the flagged delivery, immutable verification evidence, other-order
   reference (when applicable), page snapshot, and relevant support/case
   evidence.
3. Select the narrowest accurate disposition and enter a substantive reason.
4. Add the case/evidence reference when one exists.
5. Resolve each flag independently. Resolution alone does not change Order or
   delivery status.
6. Re-run automated verification, manually approve, reject, or wait for the
   customer fallback as appropriate. An exact recurrence reuses the classified
   disposition; changed fraud evidence returns to the queue as a new hold.
7. Confirm that the settlement review shows no current fraud hold before any
   money release decision.

Finance can read the queue and resolve classified risk. Delivery retry,
approval, rejection, and re-verification requests remain restricted to
Operations and Super Admin.

## Relevant code

- `packages/shared/src/delivery-verification-core.ts`
- `packages/shared/src/settlement-gating.ts`
- `apps/api/src/modules/orders/services/delivery-fraud-guard.ts`
- `apps/api/src/modules/orders/services/order-delivery.service.ts`
- `apps/api/src/modules/orders/services/order-review.service.ts`
- `apps/api/src/modules/orders/services/delivery-intervention.service.ts`
- `apps/api/src/modules/admin/verification-queue.service.ts`
- `packages/database/prisma/migrations/20260802094000_delivery_fraud_resolutions/migration.sql`
- `packages/database/prisma/migrations/20260811120000_delivery_fraud_resolution_dispositions/migration.sql`
