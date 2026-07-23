# Order Lifecycle Integrity

The durable engineering and operations guide is
`docs/ORDER_LIFECYCLE_AND_RECONCILIATION.md`.

## Canonical lifecycle

- `packages/shared/src/lifecycle/order-lifecycle.ts` is the canonical mapping
  from order statuses to the seven customer-facing lifecycle stages.
- `packages/ui/src/components/order-lifecycle-progress.tsx` renders that model.
  A `COMPLETED` order marks the final stage complete; statuses that share a
  stage remain explicit in the "Current status" label.
- Order history labels are centralized in
  `packages/ui/src/lib/order-event-presentation.ts`.

## Transaction boundary

- Lifecycle status/version changes must commit atomically with the matching
  `OrderEvent` and any required content, revision, delivery, or audit record.
- Notifications and queue jobs happen after commit because they are retryable
  side effects and must not roll back canonical order state.
- Publisher content submission uses the single
  `POST /orders/:id/submit-content-for-review` command rather than three
  independently failing client requests.
- Automatic and manual verification never use sentinel user IDs for system
  actors; nullable actor fields represent system activity.

## Role-safe order views

- Customer order payloads do not contain publisher payouts, platform fees,
  settlement approvals, internal reports, wallet identifiers, or ledger IDs.
- Publisher payloads may contain their own settlement breakdown but not
  customer wallet/refund details or approval internals.
- Operations payloads omit order financials and receive allowlisted event
  metadata only.
- Event metadata is allowlisted recursively so future server metadata fails
  closed instead of becoming public automatically.

## Financial reconciliation

- Publisher-fulfilled final orders require exactly one active settlement.
- Platform-handled final orders require no publisher settlement and exactly
  one unreversed `PlatformRevenue` record.
- Platform revenue is valid only when `order.amount == PlatformRevenue.amount`
  and `PlatformRevenue.amount == platformFee + netRevenue`, compared with
  fixed-point units. `grossAmount` belongs to publisher settlements, not
  `PlatformRevenue`.
- Reconciliation finding IDs are stable across scans. Scan summaries and issue
  codes are persisted as `FINANCIAL_RECONCILIATION_RUN` audit records.
