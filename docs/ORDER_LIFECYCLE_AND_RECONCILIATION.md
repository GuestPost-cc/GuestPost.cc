# Order Lifecycle and Reconciliation

This document is the operational and engineering contract for customer,
publisher, and platform-handled orders. The database order status and version
are canonical. Lifecycle checkmarks, labels, timelines, work queues, and
financial dashboards are projections of that state and must never become
independent state machines.

Related policies:

- [Order cancellation](./ORDER_CANCELLATION.md)
- [Security guidelines](./SECURITY_GUIDELINES.md)
- [Structured cancellation ADR](./adr/0005-structured-order-cancellation.md)

## Canonical lifecycle

`packages/shared/src/lifecycle/order-lifecycle.ts` owns the mapping from every
normal `OrderStatus` to the seven lifecycle stages. All customer, publisher,
Operations, Finance, and Super Admin pages must use that mapping.

| Stage | Statuses |
| --- | --- |
| Payment | `DRAFT`, `PENDING_PAYMENT`, `PAID` |
| Content | `SUBMITTED`, `ACCEPTED`, `CONTENT_REQUESTED`, `CONTENT_CREATION`, `CONTENT_READY` |
| Review | `CUSTOMER_REVIEW`, `APPROVED` |
| Published | `PUBLISHED` |
| Verified | `VERIFIED` |
| Delivered | `DELIVERED` |
| Complete | `SETTLED`, `COMPLETED` |

`CANCELLED`, `REFUNDED`, and `DISPUTED` are exception states. They do not map
to a normal stage. A dispute pauses normal fulfillment and settlement
progression. Cancellation and refund behavior follows the dedicated
cancellation policy.

The progress component marks stages before the current stage complete. The
current stage remains current until the order advances. A `COMPLETED` or
`SETTLED` order marks the final stage complete. Statuses that share a stage are
still shown with their specific status label so, for example, `ACCEPTED` and
`CONTENT_READY` are not visually indistinguishable.

## Creation and payment

The customer marketplace is the only order-creation entry point.

1. The customer selects an active listing service.
2. The portal shows the server-projected service contract, fulfillment
   channel, price, currency, turnaround, revisions, warranty, requirements,
   and website-access state.
3. The customer submits a structured brief and may submit a source article.
4. The client supplies an organization-scoped idempotency key and the reviewed
   quote assertions.
5. The API re-resolves the listing service, website, price, currency,
   availability, service version, and fulfillment channel.
6. If the reviewed quote is stale, creation fails with `REQUOTE_REQUIRED`.
7. The API creates the draft, priced order items, customer article version,
   canonical event, and audit evidence in the required transaction boundary.
8. Payment moves the order through `PENDING_PAYMENT` to `PAID`; fulfillment
   visibility begins only after the applicable paid/submitted boundary.

Campaign actions route to `/dashboard/marketplace?campaignId=...`. The
`campaignId` is preserved through listing and service navigation. The portal
only submits it when it matches the organization-scoped campaign response, and
the API authorizes it again before connecting the order. The retired
`/dashboard/orders/new` route is a compatibility redirect only. It accepts the
historical `campaign` query name but does not contain a second creation path.

Target keywords accept comma-separated, newline-separated, or array input.
Normalization trims values, removes case-insensitive duplicates, and rejects
more than 20 keywords or a keyword longer than 80 characters. Values are not
silently truncated.

The API derives an item from the selected listing service when a modern client
does not submit an item array. A paid order must not be created with a zero
total because a client omitted a redundant price-bearing field.

## Fulfillment channels

### Publisher fulfilled

Publisher access is derived from ownership of the order website, not from
customer-controlled identifiers. Draft and unpaid source articles are not
visible to a publisher. After the authorized fulfillment boundary, the
publisher can accept or decline, create or submit content, respond to
revisions, and provide publication evidence through dedicated commands.

Content submission for review is one command. The article version, content
record, order status/version, order event, and audit evidence commit together.
The client must not emulate this command with several independently failing
requests.

### Platform handled

Platform-handled orders are fulfilled by an assigned Operations user or a
Super Admin under the existing route guards. Assignment and claim rules are
server-authoritative. Operations can prepare content, submit it for customer
review, record publication evidence, and progress verification and delivery
only through authorized fulfillment commands.

Operations order projections exclude order amounts, settlements, customer
wallet data, publisher payout data, and unapproved event metadata. Finance
retains its separate financial workspace and cannot become a fulfillment
actor merely by reading an order.

## Review, publication, verification, and delivery

Customer approval and revision requests use optimistic order versions so a
stale action cannot overwrite a concurrent transition. Publication evidence
is stored as structured order data and represented by a canonical event.

Automatic and manual verification use the same domain transition rules.
System activity uses nullable actor fields rather than sentinel user IDs.
Verification evidence, the status/version transition, event, and audit record
must be atomic. Retryable notifications and queue jobs run after commit.

Delivery, settlement, and completion are channel-aware:

- Publisher-fulfilled orders create and release publisher settlements under
  the settlement policy.
- Platform-handled orders create platform revenue and must not create a
  publisher settlement.
- A completed transition must leave the order, event history, delivery
  evidence, and required financial record mutually consistent.

## Article provenance

`OrderArticleVersion` stores customer source articles and publisher or
Operations final submissions as immutable versions.

- `source` identifies `CUSTOMER`, `PUBLISHER`, or `OPERATIONS`.
- `purpose` distinguishes `SOURCE_ARTICLE` from `FINAL_SUBMISSION`.
- The body is plain text or Markdown, limited to 200,000 characters, and
  rendered as text rather than trusted HTML.
- A SHA-256 checksum and word count provide integrity evidence.
- Version uniqueness is enforced per order, source, and purpose.
- `supersedesId` records version lineage without modifying old content.
- Article bodies never enter order-event metadata or audit metadata.

The customer sees source and final article history relevant to the order. A
publisher sees content only after its authorized fulfillment boundary.
Operations sees platform-fulfillment content required for assigned work.
Finance projections never include article bodies.

Migration `20260723180000_order_article_versions` must be applied before
deploying API or frontend code that selects article versions. Prisma Client
generation must use the migrated schema.

## Role-safe order projections

Authorization is enforced before projection. Projection then minimizes the
payload for the authenticated actor.

| Actor | Required scope | Included | Excluded |
| --- | --- | --- | --- |
| Customer owner | Active organization owns the order | Brief, customer-visible articles, lifecycle, public events, customer amounts | Publisher payout internals, platform revenue internals, reports, ledger and wallet identifiers |
| Customer member | Active organization owns the order and member created it | Same customer-safe fields for owned orders | Other members' orders and all internal finance data |
| Publisher | Publisher owns the order website | Fulfillment data, relevant articles, own settlement breakdown, public events | Customer wallet/refund internals, approval internals, platform reports |
| Operations | Assigned/claimable platform fulfillment or authorized operational exception | Fulfillment evidence, relevant articles, allowlisted events | Order amount, currency, settlements, wallet and payout data, raw event metadata |
| Finance | Finance/Super Admin financial route | Required settlement and reconciliation evidence | Article bodies, fulfillment authority, customer contacts, raw event metadata |
| Super Admin | Explicit Super Admin route | Role-appropriate administrative projection | Secrets, provider credentials, and unnecessary raw payloads |

Order events use a public event-type allowlist and a recursive metadata-key
allowlist. Unknown future keys fail closed. Financial event messages are
actor-specific and do not reveal a counterparty's internal amounts.

Website URL visibility is also server-projected. Customer marketplace and
order payloads omit the raw website, sample, and signup URLs until the active
organization has verified successful-deposit evidence. A historical verified
`DEPOSIT` ledger row is supported only as a compatibility fallback. CSS blur is
presentation, not a secrecy boundary.

## Timeline and progress presentation

`packages/ui/src/lib/order-event-presentation.ts` owns event labels and the
shared lifecycle component owns stage rendering.

- Timelines sort `createdAt` newest first.
- Invalid or missing timestamps render a safe fallback and do not crash a
  detail page.
- Role pages display sanitized event details rather than raw metadata.
- Active-order pages poll and invalidate the role-appropriate order list and
  detail caches after mutations.
- Header status uses the shared status presentation rather than local string
  replacement.

A stale checkmark is a cache or projection defect unless the canonical status,
version, and event disagree. UI code must not write a compensating status.

## Transaction and concurrency rules

Every domain transition must:

1. Authorize the actor and order route.
2. Validate the current status and expected version.
3. Update status and increment version.
4. Write the required content, revision, publication, verification, delivery,
   settlement, revenue, or refund record.
5. Write the canonical `OrderEvent`.
6. Write required audit evidence.
7. Commit those durable changes atomically.
8. Enqueue retryable jobs and send notifications only after commit.

Idempotency protects order creation and money commands. Optimistic versions
protect lifecycle commands. Neither mechanism replaces database uniqueness,
foreign keys, check constraints, or transaction isolation.

## Financial invariants

Money comparisons use fixed-point units, never JavaScript floating-point
equality.

### Customer payment

- A paid order has the expected purchase ledger evidence.
- Purchase amount and currency match the persisted order total.
- Duplicate purchase evidence is a reconciliation finding.
- Deposit attempts may credit a wallet only after verified provider success,
  and the attempt, wallet, ledger, provider inbox, and audit state commit
  atomically.

### Publisher fulfillment

- A final publisher-fulfilled order has exactly one active settlement.
- `grossAmount == platformFee + publisherAmount`.
- A released settlement has exactly one matching release transaction.
- A refund requiring reversal cannot leave the settlement active or released
  without the corresponding reversal state.

### Platform fulfillment

- A final platform-handled order has no publisher settlement.
- It has exactly one unreversed `PlatformRevenue` record.
- `order.amount == PlatformRevenue.amount`.
- `PlatformRevenue.amount == platformFee + netRevenue`.
- `grossAmount` is a publisher-settlement concept and is not used to reconcile
  platform revenue.

### Payout traceability

- Withdrawal source allocations equal the gross withdrawal amount.
- A completed Stripe Connect execution requires bank-payout evidence and the
  `BANK_PAID` stage.
- Duplicate completed executions, stale processing, orphan execution states,
  and publisher lifetime-paid drift are findings and require investigation.

## Reconciliation

`packages/shared/src/reconciliation-core.ts` is the shared definition of
financial drift for the API's on-demand admin scan and the scheduled worker
scan. Both paths must call the same core.

The scan checks:

- Wallet cached balances against ledger totals.
- Publisher withdrawable balances against publisher ledger totals.
- Settlement amount, release synchronization, ownership, and completeness.
- Purchases against paid order state, amount, currency, and duplication.
- Refund state, amount, duplication, and settlement reversal.
- Final publisher orders for required settlements.
- Final platform orders for required revenue and forbidden settlements.
- Provider-neutral deposit attempts against wallet ledger evidence.
- Withdrawal allocations and Stripe bank-payout evidence.
- Stale, orphaned, duplicate, or lifetime-drift payout states.

Finding IDs are stable across scans and are derived from the finding code,
entity, integrity group, and related transaction, settlement, or execution.
This permits reliable operator comparison without treating each scan as a new
incident.

The API persists a sanitized `FINANCIAL_RECONCILIATION_RUN` audit summary with
counts and finding codes. Raw credentials, provider payloads, decrypted payout
data, and unrestricted metadata must never be included. Reconciliation is
detective control: it reports drift and links to the existing authorized
workspace. It does not silently repair balances, settlements, revenue, or
order statuses.

## Diagnosing lifecycle mismatches

When a role page shows an incorrect checkmark or timeline:

1. Read the order's canonical `status`, `version`, fulfillment channel, and
   exception state through an authorized server endpoint.
2. Confirm the latest status-changing event is consistent with that status and
   version.
3. Confirm the role projection contains the expected event and no forbidden
   fields.
4. Confirm the page uses the shared lifecycle and event presentation modules.
5. Invalidate the role's detail and list caches and verify active-order polling.
6. Check for an invalid event timestamp; it should affect only timestamp
   display, not ordering of valid events or lifecycle state.
7. Run reconciliation when the mismatch touches payment, settlement, platform
   revenue, refund, wallet, publisher balance, or payout state.
8. Use the authorized domain command to resolve a real state problem. Never
   patch a status, balance, ledger row, settlement, or revenue row directly.

## Deployment and validation

Release order:

1. Back up and review the target database.
2. Apply `20260723180000_order_article_versions`.
3. Generate Prisma Client from the migrated schema.
4. Build and deploy the API and worker.
5. Build and deploy portal, publisher, and admin applications.
6. Run customer, publisher-fulfilled, and platform-handled smoke orders.
7. Run reconciliation and investigate every new critical finding.

Required automated coverage includes:

- Lifecycle status completeness and final-stage rendering.
- Middleware preservation of the original path and query through sign-in.
- Campaign and service query preservation.
- Keyword normalization and limits.
- Quote, campaign, idempotency, item pricing, and zero-total protections.
- Customer, publisher, Operations, Finance, and Super Admin read scopes.
- Atomic content, review, publication, verification, delivery, and completion
  transitions.
- Customer and fulfiller article provenance and disclosure boundaries.
- Publisher settlement and platform-revenue reconciliation invariants.
- Stable reconciliation finding identifiers and sanitized audit summaries.
