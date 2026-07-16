---
note_type: domain-memory
domain: orders-fulfillment
project: guestpost-platform
updated: 2026-07-16
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

## Order snapshot fields (Phase 6 hardening)

At creation, the order locks in immutable references to the customer's pick. The five snapshot columns are written inside the same txn as the order row; later listing/service edits never alter an in-flight contract:

| Column | Purpose |
|---|---|
| `listingId` | Source `MarketplaceListing` at the moment of pick. |
| `listingServiceId` | Specific `ListingService` row (price/TAT/requirements frozen). Required since Phase 4 hard switch. |
| `fulfillmentChannel` | `PUBLISHER` or `PLATFORM` — authoritative for all downstream routing (settlement vs PlatformRevenue, publisher inbox vs Ops queue, ticket assignment). Never re-derived from `Website.ownershipType`. |
| `turnaroundDays` | Snapshot of service's TAT. |
| `briefData` | Per-`ServiceType` structured brief, validated by `@guestpost/shared` Zod registry. JSONB. Legacy `Order.title`/`instructions` kept as denormalized mirrors for older renderers. |

## Routing logic (no more website.ownershipType reads in hot path)

- `OrderOwnershipGuard` reads `order.fulfillmentChannel`. Publisher actor refused when channel=PLATFORM (covers website-reassigned-mid-flight).
- `OrderFulfillmentService` (publisher path) reads `order.fulfillmentChannel === "PUBLISHER"` AND `website.publisherId === actor.publisherId` (latter still authoritative for publisher identity).
- `OrderOperationsService` (platform/Ops path) reads `order.fulfillmentChannel === "PLATFORM"`.
- Refund / dispute / delivery / settlement all branch off `order.fulfillmentChannel` with a one-line fallback to `website.ownershipType` for pre-Phase-2 legacy orders.

## PLATFORM auto-assignment

When `OrdersService.create` resolves the snapshot and `fulfillmentChannel=PLATFORM`, the same txn creates a `FulfillmentAssignment` row (`assignedToUserId = website.managedByUserId`, status=ASSIGNED, metadata `{auto: true}`). If the site has no `managedByUserId` the order falls back to the shared unassigned-Ops queue surfaced by `operationsQueue()`.

Admin ownership reassignment loads its eligible owner roster from the static `GET /admin/staff/operations` route. Keep this route outside the `/admin/users/*` namespace: a prior `/admin/users/ops` route was shadowed by `/admin/users/:id` and returned `User not found`. The roster includes only non-banned users with an active `OPERATIONS` staff membership. Reassignment changes routing for new work only; in-flight assignments remain unchanged.

## Audit metadata standard

All Order-scoped `audit.log({entityType:"Order"|"Settlement"|…})` callsites spread the output of `packages/shared/src/audit/order-event-metadata.ts:orderEventMetadata(order)` into `metadata` — guarantees every audit row carries `{listingId, listingServiceId, serviceType, fulfillmentChannel, ownerType, websiteId, amount}`. Currently applied at SETTLEMENT_CREATED + ORDER_REFUNDED; more callsites to follow.

## Content storage (clarified)

- `Order.briefData` — what the **customer** submitted as the brief (Phase 6).
- `ContentOrder` table — what the **publisher** submitted as the content deliverable (`title`, `brief`, `deliverable`, `status`). Live read path via `order.submittedContent` in the api-client → portal order detail. Originally on the Phase 7 drop list, then reclassified as live and kept.

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

## Delivery and Settlement Operations (2026-07-12)

- The worker runs repeatable auto-accept and settlement auto-release sweeps; their payloads are signed and the registry guards against drift between scheduled jobs and processors.
- Settlement review auto-approval consumes `QUEUES.SETTLEMENT`, while auto-release consumes the dedicated `QUEUES.SETTLEMENT_RELEASE`. BullMQ workers must not independently filter different job names from one shared queue because either worker can claim and discard the other's job; startup removes legacy auto-release repeatables from the old queue.
- `SettlementApproval` timestamps are exposed as `approvedAt` (not `createdAt`), and `approvedBy` is a user ID or a `SYSTEM_*` actor token. The admin order-detail API enriches human approvers as `approvedByUser`; UI renderers must retain system-token labels and defensively handle missing/invalid timestamps.
- Delivery verification can be reviewed from the staff queue, including evidence and intervention actions. Customer and staff views expose the review-window countdown.
- Manual settlement approval requires a reason and is restricted to `SUPER_ADMIN`; automatic paths continue to follow the configured review-window policy.

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
