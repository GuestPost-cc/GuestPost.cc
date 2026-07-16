# ADR 0005: Structured Order Cancellation

- Status: Accepted
- Date: 2026-07-16

## Context

The buyer UI previously attempted a nonexistent generic status-update endpoint,
while the API allowed broad unilateral cancellation after acceptance and even
after publication. Platform-owned orders could retain active assignments, refund
attribution punished publishers for unrelated cancellations, dispute writes were
not consistently atomic, and platform delivery could remain `DELIVERED` without
recognized revenue or a terminal transition.

## Decision

Use a shared pure policy and a dedicated `OrderCancellationService`. Immediate
pre-acceptance exits are distinct from post-acceptance consent cases and
post-publication disputes. Store cancellation cases as structured records, pause
fulfillment while a case is active, separate operational review from Finance
approval, and route every captured-payment return through one transaction-aware
refund primitive. Persist fulfillment channel, lifecycle timestamps, warranty,
and refund responsibility on the order.

## Consequences

- Cancellation copy and available actions come from the API preview.
- The flow adds a database migration and two repeatable worker jobs.
- Partial refunds remain unsupported; all approved refunds are full wallet
  refunds.
- A historical order can currently have one dispute record. A second dispute is
  rejected with a clear conflict and must be reopened through support; converting
  disputes to a one-to-many history is a separate future schema decision.
- Correct responsibility attribution is required for meaningful trust scores.
- Dispute refunds require Finance or Super Admin and explicit responsibility;
  Operations retains the non-financial restore/reject decisions.
