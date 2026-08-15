---
note_type: domain-memory
domain: orders-fulfillment
project: guestpost-platform
updated: 2026-08-15
---

# Orders & Fulfillment

## Order Lifecycle

Full lifecycle state machine (`OrderStatus` enum, 17 states):

```
DRAFT → PENDING_PAYMENT → PAID → SUBMITTED → ACCEPTED → CONTENT_REQUESTED → CONTENT_CREATION → CONTENT_READY → CUSTOMER_REVIEW → APPROVED → PUBLISHED → VERIFIED → DELIVERED → COMPLETED
```

Cancellation/dispute paths branch off at various states.
Publisher settlement review does not add an Order state: the order remains
`DELIVERED` until one exact `Settlement.RELEASED` state, release ledger row,
and relational release event commit with the transition to `COMPLETED`.

Canonical wallet payment is one externally observable aggregate command:
`DRAFT`/payment `PENDING` becomes `SUBMITTED`/payment `PAID` through one
status-and-version CAS. The same transaction retains separate
`PAYMENT_CAPTURED` and `ORDER_SUBMITTED` milestones, both bound to the resulting
aggregate version with explicit sequence metadata. Aggregate versions count
commands, not event rows; `PAID` remains a compatibility/recovery order status
rather than a separately committed intermediate state of this command.

Cancelling an unpaid order releases only its exact negative order-reservation
ledger fact and appends one positive `RELEASE` bucket-transfer row. Deferred
database assertions are attached to the transaction, order, and cancellation
event sides of the chain; the terminal `CANCELLED`/payment-`PENDING` state and
its evidence cannot be rewritten independently later.

API lifecycle writers use the typed, API-local `transitionOrderCas` helper.
It requires exact from/to statuses, owns the single version increment, and
only permits a narrow lifecycle patch. Identity, immutable order-contract,
settlement-fence, and delivery-evidence mutations require their specialized
domain CAS predicates rather than this helper.

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

## Customer Workbench

- The customer dashboard at `/dashboard` prioritizes payments, content review,
  delivery confirmation, and counterparty cancellation responses. KPI totals
  come from tenant-scoped count queries rather than the length of one page.
- `/dashboard/orders` is a 20-row server-paginated queue with stage, campaign,
  service, full-text, and operational sort controls. The API validates every
  filter, caps page size at 100, and always includes `organizationId` in its
  Prisma predicate. Member attention queries additionally scope results to the
  member's own `customerId`; owners retain organization-wide oversight.
- Customer order detail and checkout display the snapshot value, turnaround,
  fulfillment/review deadline, and one next action. OWNER or order creator is
  the client-side action rule, but dedicated endpoints and ownership guards
  remain authoritative for payment, review, delivery, cancellation, and
  dispute mutations.
- Campaign lists expose an authoritative server-side `orderCount`. Campaign
  detail and Reports page through all matching order pages before computing
  totals or exports. Result reporting consistently includes PUBLISHED,
  VERIFIED, DELIVERED, and COMPLETED.
- Support tickets linked to an order are prioritized when waiting on the
  customer, and ticket forms warn users never to send passwords, API keys,
  complete card details, or other credentials. The unsupported priority input
  was removed because the API never persisted it.

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

## Order-linked support routing

- Customer order tickets derive organization, fulfillment channel, active
  Operations assignee, or assigned publisher from the locked Order. Clients do
  not nominate routing identities.
- Publishers cannot create general support tickets. They must supply an order
  currently routed to their publisher on the `PUBLISHER` channel; foreign and
  Platform orders use the same not-found policy to avoid enumeration.
- A Platform ticket follows the active `FulfillmentAssignment`. Order claim,
  reassignment, and ticket creation serialize on the Order row. Assignment and
  ticket ownership are updated atomically with internal system-event, audit,
  and outbox evidence; the previous assignee loses read and mutation authority
  immediately after commit.
- A general unassigned Platform-support ticket may be claimed by Operations.
  While fulfillment is active, an order-linked ticket can be claimed only
  through the fulfillment order. After fulfillment ends, the latest delivered
  Operations owner is retained when eligible, and an otherwise unassigned
  ticket may be claimed independently without mutating assignment history.
  Super Admin may reassign or unassign that independently owned ticket under
  the same Order-before-Ticket locks. `DISPUTED` qualifies only when the current
  dispute remains open or under review and its recorded previous status is
  post-fulfillment; missing, resolved, and pre-fulfillment dispute state fails
  closed.
- Support histories use deterministic `(createdAt,id)` keyset pagination. Each
  page is chronological, and an older page is prepended and deduplicated by ID.
- Public support inboxes use latest-PUBLIC-activity keyset pagination, append
  older pages, and deduplicate by ticket ID. Internal notes cannot affect
  external activity order or cursor boundaries. No schema migration is
  required for this support contract.

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

`GET /admin/operations-workbench` is the read-only Operations landing summary.
It combines fulfillment with Support assigned to the current operator,
operational cancellations and disputes, delivery/domain verification,
moderation, and assigned-site listing/integration readiness. The server ranks a
bounded action queue and guarantees assigned Support visibility within an equal
severity band; only an unassigned platform fulfillment item can be claimed
inline, using the existing race-safe claim path.

Operations order-monitor and direct order-detail reads are scoped to work the
operator can act on or support: assigned or safely claimable platform orders,
orders with Support assigned to the operator, and active operational
dispute/cancellation or delivery-verification contexts. Guessed unrelated IDs
fail as not found. Contextual customer, publisher, and assignee names are
sanitized; finance records, audit metadata, emails, and provider details are
not returned to Operations.

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
- `OrderArticleVersion` keeps customer source articles and publisher/Operations
  final submissions as immutable, checksum-addressed versions. Article bodies
  never enter `OrderEvent.metadata`; events carry only provenance and integrity
  references. Customer source content is created atomically with the DRAFT
  order but does not advance lifecycle status.
- Publisher order lists and Publisher/Operations direct-order reads fail closed
  for DRAFT and PENDING_PAYMENT orders, preventing pre-payment brief and
  source-article disclosure.
  Finance projections do not include article bodies.

## Order creation contract hardening (2026-07-24)

- Campaign IDs are validated against the active customer organization before
  connection.
- Structured briefs are mandatory and canonical target URL/anchor values come
  from the validated brief.
- Listing service price, currency, version, availability, website, turnaround,
  warranty, and fulfillment channel remain server-derived. New clients submit
  the reviewed quote and receive `REQUOTE_REQUIRED` if it changed.
- New listing-backed orders persist the exact revision entitlement. Historical
  orders that predate this snapshot retain `NULL`; current mutable catalog
  terms are not backfilled as historical evidence, and revision requests fail
  closed until an explicit evidence-repair workflow exists.
- Customer retries reuse an organization-scoped idempotency key.
- Guest-post buyers may submit a plain-text/Markdown source article during
  creation. The body is capped at 200,000 characters and rendered as text.
- Target keywords accept comma/newline strings or arrays, trim and
  case-insensitively deduplicate, and reject more than 20 or more than 80
  characters per keyword without silent truncation.

## Sub-Services

- `order-operations.service.ts` — core business logic
- `order-payment.service.ts` — payment processing
- `order-fulfillment.service.ts` — fulfillment state machine
- `order-review.service.ts` — content review
- `order-dispute.service.ts` — dispute handling
- `refund.service.ts` — refund processing (used by forceCancel, dispute resolution)

## Key Rules

- One website per order (enforced in createOrder/addOrderItem)
- Critical statuses (PAID, ACCEPTED, VERIFIED, COMPLETED, REFUNDED) are system-only
- `forceCancel` delegates refund to `RefundService`
- `confirmDelivery`/settlement non-atomic fixed to single transaction

## Delivery and Settlement Operations (2026-07-12)

- The worker runs repeatable auto-accept and settlement auto-release sweeps; their payloads are signed and the registry guards against drift between scheduled jobs and processors.
- Settlement review auto-approval consumes `QUEUES.SETTLEMENT`, while auto-release consumes the dedicated `QUEUES.SETTLEMENT_RELEASE`. BullMQ workers must not independently filter different job names from one shared queue because either worker can claim and discard the other's job; startup removes legacy auto-release repeatables from the old queue.
- Automated release locks and reruns the canonical eligibility gate, then requires the newest immutable evidence for the active delivery to be a successful link/target/anchor observation no older than 12 hours. Missing, stale, future-dated, or failed evidence is counted as `freshnessBlocked` and performs no money write; the PostgreSQL transition guard mirrors the fixed window.
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
- Every staff manual-delivery approval, including the legacy
  `/admin/orders/:id/manual-verify` compatibility route, delegates to the same
  active-delivery-version intervention. It requires a bounded audited override
  reason, rechecks current staff authority under the order lock, advances the
  delivery evidence and `Order` with optimistic guards, and writes event/audit
  evidence atomically. A status-only manual verification is not a valid
  settlement predicate.
- A technically passing delivery never advances automatically when it creates
  a fraud signal. It remains `MANUAL_REVIEW`, the database projects the
  immutable signal into `DeliveryFraudHold`, and the same transaction records a
  required durable staff fraud alert.
- Customer normal confirmation and manual technical fallback re-read current
  fraud holds under the Order lock. A hold produces customer-safe
  `DELIVERY_FRAUD_REVIEW_REQUIRED`, commits no lifecycle or money mutation, and
  records throttled internal denial evidence. Signal types and cross-order
  references remain staff-only.
- Delivery approval and fraud adjudication are separate. Manual approval and a
  positive verification override reject every unresolved order-level hold.
  Operations can resolve a classified false positive; authorizing URL reuse or
  accepting known risk requires Finance or Super Admin plus a bounded evidence
  reference. `AUTHORIZED_REUSE` is accepted only for a `URL_REUSED` signal.
  Every resolution keeps the immutable original flag and snapshots
  the disposition, evidence reference, reason, resolver, and role-at-time. New
  raw SQL inserts are held to the same classification/role policy by the
  database disposition guard.
- Re-verification reuses a classified staff disposition only for the same
  delivery version, fraud type, and deeply equal signal details. The worker
  revalidates the classification, role-at-time, and required reference under
  the Order lock and audits the reuse. Changed evidence, including a larger URL
  reuse count, creates a new flag and hold; legacy unclassified resolutions
  fail closed.
- A classified URL-reuse decision is also bound to the exact current claim-set
  fingerprint, not only the delivery version. Delivery claim writers and every
  acceptance/settlement authorization boundary lock the Order first and then
  the normalized URL. A database advisory lock plus MVCC-visible
  `DeliveryUrlClaimFence` row covers rolling old writers and forces stale
  serializable snapshots to retry. Any later claimant appends a fresh flag and
  hold before the attempted acceptance or money transition is denied. The
  application fence function returns a boolean only after both locks are held:
  Prisma cannot deserialize PostgreSQL's `void` pseudo-type from `$queryRaw`,
  while database-trigger callers safely discard that scalar with `PERFORM`.
- The Admin verification compatibility routes delegate to the canonical
  intervention service. Finance has read/adjudication access to the queue but
  cannot perform Operations delivery actions. Successful manual verification
  sets `autoAcceptAt`; reversing verification clears it.
- Manual settlement approval requires a reason and is available to `FINANCE`
  and `SUPER_ADMIN` after customer approval. Super Admin retains the separate
  force-approval step for exceptional missing-customer-approval cases.

### Confirmed delivery-policy findings (2026-08-15)

- Confirming a fraud signal is not a clearance or a money command. Operations
  or Super Admin supplies the expected Order and delivery-verification
  versions, a bounded internal reason, and an actor-scoped UUID idempotency
  key. The Order-locked serializable command creates or escalates the structured
  cancellation review before appending one immutable `DeliveryFraudFinding`.
- A new confirmation advances `Order.version` exactly once for the combined
  handoff-and-finding command. An exact replay checks every immutable input,
  advances the version zero times, and may repair only missing durable
  communication projections.
- `CONFIRMED_FRAUD` deliberately leaves the exact `DeliveryFraudHold` in place.
  Finding and clearance are mutually exclusive behind the same Order fence,
  and the hold remains permanent settlement-deny evidence.
- Every finding links a same-order cancellation case. A new case is an
  `ESCALATED`, staff-requested `LEGAL_OR_SECURITY_EMERGENCY` review requesting
  `FULL_REFUND`; a reused `PENDING_FINANCE` case must already have a final
  responsibility, reviewer, and bounded reason. Operations or Super Admin can
  send it only to `PENDING_FINANCE` with `FULL_REFUND`; Finance or Super Admin
  approves the canonical refund and required publisher outcome through a
  separate money command. Super Admin can currently authorize both commands;
  universal actor-independent maker-checker remains deferred governance.
- Force cancellation and dispute refund recheck the finding under the locked
  Order and refuse to bypass the linked case. A deferred Order constraint
  trigger independently rejects `CANCELLED`/`COMPLETED` and permits `REFUNDED`
  only when every linked case has complete `APPROVED` full-refund evidence at
  commit. This timing lets the canonical refund update the Order before the
  case is finalized within the same transaction.
- The Order-page stakeholder timeline is server-projected from flags,
  findings, resolutions, REFUND transactions, and publisher-compensation
  records. Customer, publisher, Operations, Finance, and Super Admin receive
  separate allowlisted copy and money fields. Raw staff reasons, cancellation
  notes, `OrderEvent.message`, generic metadata, provider facts, and support
  identifiers are never external timeline inputs. Audience-specific outbox
  events commit with the domain command and use stable decision-bound dedup
  keys.

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

## 2026-07-24 order article and financial-integrity hardening

- Customer source articles are stored as immutable `OrderArticleVersion` rows and exposed only through tenant/role-scoped order reads.
- Customer and publisher proof/review reads use organization ownership or website publisher ownership; missing scope fails closed with `Order not found`.
- Listing-service order creation always derives at least one priced placement item when a client omits `items`, preventing zero-total paid orders.
- Create and idempotency-replay responses return the persisted post-total order with items and article versions, not the initial zero-value draft snapshot.
- Local migration `20260723180000_order_article_versions` was applied successfully.
- Validation: shared 108/108 tests, API 997/997 tests, focused shared/API/admin/portal/publisher builds, and live customer/publisher/Operations role flows passed.

## 2026-08-02 cart and capture financial boundary

- `ListingService.price`, `Order.amount`, and `OrderItem.price` are positive,
  cent-exact USD amounts. Order creation and aggregation remain in Decimal
  space and never persist a transitional zero-valued Order.
- Add, remove, reprice, and capture serialize through the parent Order row in a
  bounded `SERIALIZABLE` transaction. Exhausted cart retries return the stable
  `ORDER_CART_CONCURRENCY_CONFLICT` response.
- Capture proves at least one `PENDING_PAYMENT` item, exact item-sum/header
  equality, one website identity, and the current ListingService currency and
  price before locking/debiting the Wallet. Price drift commits an atomic
  DRAFT requote and requires explicit customer confirmation.
- PostgreSQL repeats the precision and capture checks. OrderItem insertion,
  mutation, reassignment, and deletion are blocked after PAID state, PURCHASE
  evidence, or Settlement creation.
- A revision request remains active until replacement content is submitted for
  customer review, at which point the service closes that exact request as
  `APPROVED` while holding the parent Order lock. Migration `0960` repairs only
  legacy nonterminal revisions with a `CONTENT_SUBMITTED` event strictly inside
  that revision's request window; equal-timestamp or otherwise unexplained
  duplicates fail preflight. A partial unique index then enforces at most one
  nonterminal Revision per Order.
