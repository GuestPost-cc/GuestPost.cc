# Order Cancellation and Refund Workflow

This document describes the implemented cancellation contract for customer,
publisher, and platform-fulfilled orders. The source of truth is the policy in
`packages/shared/src/order-cancellation-policy.ts` and the transactional domain
service in `apps/api/src/modules/orders/services/order-cancellation.service.ts`.

## Principles

1. Cancellation is a domain action, never a generic status update.
2. Before fulfillment is accepted, cancellation can be immediate.
3. After acceptance, the other party must consent or staff must review the case.
4. After publication, delivery, or completion, the remedy is a dispute because
   delivery evidence and settlement may already exist.
5. Captured payments have one refund path. Wallet credit, financial reversal,
   order state, assignment cleanup, events, and audit records commit together.
6. The snapshotted `Order.fulfillmentChannel` is authoritative. Website ownership
   is only a fallback for legacy orders.
7. Refund responsibility is explicit. Only `PUBLISHER`-attributed refunds affect
   publisher trust.
8. Version guards and database uniqueness constraints make repeated and
   concurrent requests deterministic.

## Decision Matrix

| Order stage | Customer | Publisher listing | Platform listing |
|---|---|---|---|
| `DRAFT`, legacy `PENDING_PAYMENT` | Cancel now; release any reservation | Not applicable | Stale Ops assignment is cancelled |
| `PAID`, `SUBMITTED` | Cancel now; full wallet refund | Decline; full wallet refund | Operations declines; full wallet refund |
| `ACCEPTED` through `APPROVED` | Request cancellation | Request cancellation | Operations requests cancellation |
| `PUBLISHED` through `SETTLED` | Open dispute | Respond through dispute/support | Respond through dispute/support |
| `COMPLETED` | Open dispute only inside a configured warranty window | Respond through dispute/support | Respond through dispute/support |
| `CANCELLED`, `REFUNDED`, `DISPUTED` | No new cancellation action | No new cancellation action | No new cancellation action |

There is no unilateral post-acceptance grace period. An active cancellation case
pauses accept/content/revision/review/publication/delivery/assignment actions.
Customer mutations require the organization owner or original order creator.
Publisher decline/request/response mutations require a publisher owner. On a
platform order, only the actively assigned Operations user (or Super Admin) can
act as the fulfiller and answer the customer's request.

## Structured Cancellation Case

`OrderCancellationRequest` records:

- requester and actor-role snapshot;
- reason code and human note;
- order status and fulfillment channel at request time;
- response deadline and response;
- Operations reviewer and recommendation;
- Finance approver for contested refunds;
- responsibility attribution and final resolution;
- refund transaction ID and idempotency key.

A partial unique database index permits only one active case per order. Terminal
case history is retained. Creating a case also increments `Order.version` without
changing the lifecycle status. This closes the race where fulfillment and a
cancellation request try to commit simultaneously.

## Resolution Paths

### Mutual agreement

The counterparty can accept a `REQUESTED` case. The full wallet refund and case
resolution commit in the same transaction. The counterparty can instead contest,
which moves the case to `UNDER_REVIEW`.

If the request had no evidence-backed responsibility attribution, mutual
acceptance resolves it as `SHARED`; a refund is never persisted as
`UNDETERMINED`.

### Contested case

Operations or Super Admin can choose:

- `CONTINUE_ORDER`: reject the request and release the fulfillment hold;
- `FULL_REFUND`: record responsibility and send the case to `PENDING_FINANCE`;
- `ESCALATE_TO_DISPUTE`: create a dispute and transition the order to `DISPUTED`.

Finance or Super Admin must approve a contested full refund. Operations cannot
move money through the dispute or cancellation review route.

The same separation applies after publication: Operations may restore or reject
a dispute, while Finance or Super Admin approves a refund and must choose an
explicit responsibility. A dispute refund is never attributed from the listing
channel alone.

### Break glass

Only Super Admin can force-cancel. The request must include the exact order ID,
current order version, structured reason, note, idempotency key, and explicit
responsibility. Paid orders still use the canonical refund transaction.

## Money and Fulfillment Invariants

For a paid refund, one transaction:

1. rejects duplicate refund/idempotency references;
2. reverses `PlatformRevenue`, or cancels/claws back publisher settlement;
3. cancels active `FulfillmentAssignment` rows;
4. credits the full captured amount to the organization wallet;
5. changes the order to `REFUNDED` and records responsibility;
6. creates the `REFUND` ledger transaction and order event;
7. creates the audit row.

There are no partial refunds in this version. Refunds return to the GuestPost
wallet, matching the current payment ledger model.

Platform orders do not create publisher settlements. Delivery confirmation or
auto-accept creates/reuses `PlatformRevenue` and transitions the order to
`COMPLETED`. Refunds reverse, never delete, that revenue record.

## Deadlines and Scheduled Jobs

- Acceptance window: 24 hours by default (`ORDER_ACCEPTANCE_WINDOW_HOURS`). A
  paid `SUBMITTED` order with a recorded `submittedAt` is automatically refunded
  when the fulfiller does not accept it.
- Cancellation response window: 24 hours by default
  (`CANCELLATION_RESPONSE_WINDOW_HOURS`). Unanswered requests become
  `ESCALATED` and stay on fulfillment hold for staff review.
- Sweep cadence: 15 minutes by default
  (`ORDER_ACCEPTANCE_SWEEP_MINUTES`, `CANCELLATION_TIMEOUT_SWEEP_MINUTES`).

Legacy `SUBMITTED` rows without `submittedAt` are intentionally not mass-refunded
by the worker. The migration backfills lifecycle timestamps from immutable order
events where available.

## API

Customer and publisher routes:

- `GET /orders/:id/cancellation-preview`
- `POST /orders/:id/cancel`
- `POST /orders/:id/decline`
- `POST /orders/:id/cancellation-requests`
- `POST /orders/:id/cancellation-requests/:requestId/respond`
- `POST /orders/:id/dispute`

Staff routes:

- `GET /admin/cancellation-requests`
- `GET /admin/orders/:id/cancellation-preview`
- `POST /admin/cancellation-requests/:id/review`
- `POST /admin/cancellation-requests/:id/finance-approve`
- `POST /admin/orders/:id/decline`
- `POST /admin/orders/:id/cancellation-requests`
- `POST /admin/orders/:orderId/cancellation-requests/:requestId/respond`
- `POST /admin/orders/:id/force-cancel`

Clients must fetch the preview and send its `expectedVersion`. They must not
derive cancellation eligibility from local status arrays.

There is intentionally no generic admin refund endpoint. Routine refunds must
resolve through a cancellation case or dispute; Super Admin force-cancel is the
audited break-glass path.

## Deployment and Verification

1. Apply migration `20260716120000_order_cancellation_workflow` before deploying
   API or worker code.
2. Deploy the API and worker together so new repeatable jobs and database fields
   become active in one release window.
3. Confirm the worker registers `cancellation-response-timeout-sweep` and
   `order-acceptance-timeout-sweep` without repeatable-job registry drift.
4. Verify a customer immediate refund, a publisher decline, a platform decline,
   a mutually accepted request, a contested Finance-approved request, and a
   post-publication dispute in staging.
5. Reconcile wallet balance, refund transaction, assignment status, settlement
   or platform revenue reversal, order event, and audit log for every scenario.

## Tests

- Shared policy matrix:
  `packages/shared/src/__tests__/order-cancellation-policy.spec.ts`
- Cancellation orchestration and fulfillment hold:
  `apps/api/src/modules/orders/services/__tests__/order-cancellation.service.spec.ts`
- Refund, assignment cleanup, and trust attribution:
  `apps/api/src/modules/orders/services/__tests__/refund.service.spec.ts`
