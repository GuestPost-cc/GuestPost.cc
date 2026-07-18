---
note_type: domain-memory
domain: orders-fulfillment
project: guestpost-platform
updated: 2026-07-18
---

# Orders & Fulfillment

## Order Lifecycle

Full lifecycle state machine (`OrderStatus` enum, 18 states):

```
DRAFT → SUBMITTED → ACCEPTED → CONTENT_CREATION → CONTENT_READY → CUSTOMER_REVIEW → APPROVED → PUBLISHED → VERIFIED → DELIVERED → SETTLED → COMPLETED
```

Cancellation/dispute paths branch off at various states.

## Publisher Workbench

- The publisher dashboard at `/dashboard` is an operational work queue rather
  than a reporting-first overview. It prioritizes new orders, requested
  changes, cancellations, publishing tasks, and fulfillment deadlines while
  keeping withdrawable funds and lifetime earnings visible.
- `/dashboard/orders` uses one shared publisher workflow mapping for stage
  filters, server status presentation, deadline risk, and next-action copy.
  Desktop uses a compact table; mobile uses action cards. Search and filters
  never grant actions: every mutation still goes through the ownership/RBAC and
  current-status checks on the dedicated order endpoints.
- The typed order client exposes the existing `turnaroundDays`,
  `fulfillmentDueAt`, `warrantyEndsAt`, accepted/submitted timestamps, and
  structured `briefData` fields. The order workspace renders briefs with the
  shared registry-backed `BriefRenderer` and never treats client-derived stage
  labels as authorization.
- Publisher support is available at `/dashboard/support`; order links carry an
  order ID into the actor-scoped support API. The UI explicitly warns against
  sending passwords, keys, or payout credentials.
- File attachments remain unavailable until there is a private, validated
  upload pipeline. The former file selector was removed because it retained
  browser `File` objects without sending or securing them. The former JSON
  “invoice” download was also removed because it was not a real financial
  document.

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

An Operations user who enlists a platform site is always recorded as that
site's `managedByUserId`, even if a different owner ID is supplied in the
request. Operations can read and mutate only its assigned platform sites;
Super Admin alone can inspect the Operations roster and reassign site owners.

The Operations fulfillment queue returns active assignments owned by the
current operator plus platform orders with no active assignment. Claiming is a
self-service action and never cancels another active assignment; the partial
unique index on active `FulfillmentAssignment` rows resolves concurrent claims.
Only Super Admin can assign or reassign an order across staff, and the target
must be an active, non-banned Operations member.

Operations uses `/dashboard/fulfillment` as its daily workbench. The inbox and
dashboard poll every five seconds and on focus, exposing assigned work and each
new unassigned order as an independent claim opportunity. The detail workflow
covers accept, draft/save, atomic content submission for customer review,
revision, publication, verification, and structured cancellation. Mutations
re-check the active assignment and its version inside the same transaction;
another operator's order is hidden from direct-ID access.

Operations performance distinguishes assignment history, explicit self-claims,
delivered work, and delivered sales grouped by currency. Active assignments
must be reassigned or completed before the operator can be suspended or moved
to another staff role.

Platform fulfillment recognizes the full order amount in `PlatformRevenue` and
does not create a publisher settlement or payout.

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
- The staff UI calls DNS ownership checks **Domain Verification** and keeps
  **Delivery Verification** as a separate order-delivery queue. The delivery
  queue contains only `FAILED` and `MANUAL_REVIEW` active delivery versions;
  pending automated checks remain visible on order/fulfillment detail instead
  of becoming actionable staff queue items.
- Delivery queue responses expose `orderId`, website ownership/source,
  publisher context when applicable, and the active delivery-version evidence.
  Staff retry, verify, reject, and re-verification actions address the order by
  `orderId`.
- Manual settlement approval requires a reason and is available to `FINANCE`
  and `SUPER_ADMIN` after customer approval. Super Admin retains the separate
  force-approval step for exceptional missing-customer-approval cases.

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
