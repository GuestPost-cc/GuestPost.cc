# Order lifecycle integrity

Status: implemented and locally validated; stacked draft PR and GitHub CI are
pending.

Completed:

- Role-safe customer, publisher, and Operations projections.
- Atomic publisher, customer-review, Operations, and delivery-verification
  transitions with canonical events and transactional audit records.
- Platform-aware reconciliation and per-order financial integrity checks.
- Correct final lifecycle checkmark, safe event timestamps, active-order
  polling, and correct role list cache invalidation.
- Full order-event and cancellation history retrieval on role order details.

Validated:

- Shared package: 108 tests.
- API: 997 tests.
- Focused shared, API, admin, portal, and publisher production builds.
- Customer, publisher, and Operations role-flow smoke orders.

Next:

- Publish the stacked draft PR and require GitHub CI before retargeting it to
  `main`.
