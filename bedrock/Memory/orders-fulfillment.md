---
note_type: domain-memory
domain: orders-fulfillment
project: guestpost-platform
updated: 2026-06-11
---

# Orders & Fulfillment

## Order Lifecycle

Full lifecycle state machine (`OrderStatus` enum, 18 states):

```
DRAFT → SUBMITTED → ACCEPTED → CONTENT_CREATION → CONTENT_READY → CUSTOMER_REVIEW → APPROVED → PUBLISHED → VERIFIED → DELIVERED → SETTLED → COMPLETED
```

Cancellation/dispute paths branch off at various states.

### Business-Action Endpoints

No generic status transitions. Each action validates actor type, org ownership, current status, and business rules:
- `submit-payment`, `accept`, `submit-content`, `mark-content-ready`, `submit-for-review`, `approve-content`, `mark-published`, `confirm-delivery`, `cancel`, `dispute`, etc.

### Service Types

`GUEST_POST`, `NICHE_EDIT`, `EDITORIAL_LINK`, `OUTREACH_LINK`, `LOCAL_CITATION`, `FOUNDATION_LINK`, `BLOG_ARTICLE`, `SEO_CONTENT`

## Sub-Services

- `order-operations.service.ts` — core business logic
- `order-payment.service.ts` — payment processing
- `order-fulfillment.service.ts` — fulfillment state machine
- `order-review.service.ts` — content review
- `order-dispute.service.ts` — dispute handling
- `refund.service.ts` — refund processing (used by forceCancel, dispute resolution)

## Key Rules

- One website per order (enforced in createOrder/addOrderItem)
- Critical statuses (PAID, ACCEPTED, VERIFIED, SETTLED, COMPLETED, REFUNDED) are system-only
- `forceCancel` delegates refund to `RefundService`
- `confirmDelivery`/settlement non-atomic fixed to single transaction

## Key Models

- `Order` — header with status, totals, version field
- `OrderItem` — line items per order
- `OrderEvent` — event log per order
- `ContentOrder` — content tracking
- `Revision` — content revision history
- `Report` — SEO/content report
- `Publication` — published URL tracking
- `OrderDispute` — dispute with `previousStatus`
- `PlatformRevenue` — platform fee tracking (with `reversedAt`)
- `Campaign` — order grouping

## Key Files

- `apps/api/src/modules/orders/` — controller + services
- `apps/api/src/modules/orders/services/__tests__/`
