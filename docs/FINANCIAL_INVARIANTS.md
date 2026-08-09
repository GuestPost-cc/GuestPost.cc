# Financial invariants

This document is the canonical engineering contract for every GuestPost money
path. It applies to customer deposits and wallets, order payments and refunds,
publisher settlements and withdrawals, provider payouts, disputes,
reconciliation, and incident repair.

Provider documentation describes how an external system behaves. This document
describes what GuestPost is allowed to conclude from that behavior.

## 1. Ownership and evidence

- A provider moves external money. It does not own GuestPost balances.
- GuestPost's database owns internal liability and reservation state.
- A provider response is evidence for one specific transition; it is never a
  replacement balance.
- An internal row cannot prove an external transfer happened. A terminal
  external-money state requires provider or independently reviewed bank
  evidence.
- Browser success pages, redirects, operator assertions, screenshots, and
  caller-supplied identifiers are not settlement evidence.

Every money-changing command must identify:

1. the aggregate being changed;
2. the actor or authenticated provider event;
3. the amount and ISO currency;
4. the source and destination liability positions;
5. the idempotency identity;
6. the evidence authorizing the transition;
7. the audit event and recovery path.

## 2. Canonical operation lifecycle

An operation that can call an external provider follows this sequence:

```text
validate immutable command
  -> claim scoped idempotency identity
  -> reserve internal funds and persist durable operation
  -> commit
  -> call provider with stable provider idempotency key
  -> persist provider acceptance/reference
  -> wait for verified terminal evidence
  -> atomically finalize liability + ledger + audit
```

External calls do not run inside a long database transaction. A database
rollback cannot undo a provider call.

Timeout after send is **ambiguous**, not failed. Funds remain reserved while
provider retrieval or webhook reconciliation establishes truth. Code must not:

- retry with a new provider idempotency key;
- release the reservation because a response was lost;
- mark the operation completed without terminal evidence.

## 3. Amounts and currencies

- The launch accounting currency is exactly `USD`. Catalog prices, orders,
  wallets, deposits, disputes, settlements, publisher balances, revenue,
  withdrawals, payout executions, allocations, batches, and ledger rows must
  all persist the case-sensitive value `USD`.
- Do not uppercase or relabel a persisted non-USD financial row. Provider
  envelopes may be normalized at their authenticated boundary, but a legacy
  `EUR`, `GBP`, lowercase, blank, or mixed-currency database fact is corruption
  that blocks the transition and the USD-boundary migration until reconciled.
- Every service boundary compares amount and currency together. An order may
  spend only a USD wallet against a USD listing-service snapshot; every ledger
  write sets currency explicitly rather than relying on a database default.
- Persist money as `Decimal` or provider minor units, never binary floating
  point.
- Normalize provider minor units with a currency-specific exponent. Do not
  assume every currency has two decimal places.
- Validate positive amount, supported currency, precision, configured minimum,
  configured maximum, and aggregate/daily limits before reservation.
- Amount and currency are immutable after an operation is accepted.
- An event whose amount or currency differs from its aggregate is quarantined
  for reconciliation and performs no money mutation.
- A balance row contains one currency. Cross-currency operations require
  explicit source amount, destination amount, rate, and fee evidence.

## 4. Identity and idempotency

Internal command identity, ledger identity, and provider identity are separate
namespaces.

- Client idempotency keys are scoped to actor/tenant, command type, and target
  aggregate. Raw client input is never stored as a globally unique ledger
  reference.
- The first accepted command stores a hash of immutable inputs. Repeating the
  same key and inputs returns the canonical result. Reusing the key with
  different inputs returns `409 Conflict`.
- Order creation hashes a canonical, tenant-, customer-, and actor-bound
  payload into `Order.requestFingerprint`. The tenant-scoped key and hash are
  immutable. A concurrent unique-key loser re-reads the committed winner only
  after rollback and returns it only when the hash matches; historical rows
  without verifiable binding fail closed instead of being replayed.
- Ledger references are server-generated and domain-prefixed.
- Provider object uniqueness is scoped by provider and provider object type.
  A deposit PaymentIntent identity must not be reused as the identity of an
  internal dispute hold.
- A uniqueness violation is not automatically an idempotent success. After the
  failed transaction rolls back, code must re-read in a fresh transaction and
  compare all immutable fields. A different object is a collision and must
  fail closed.

## 5. Locking, transactions, and retries

Each money-path family declares one total lock order and every writer follows
it. Current orders are:

- payout execution creation and external-call claims:
  `PayoutWebhookEvent (when present) -> Withdrawal -> PayoutExecution ->
  PublisherBalance -> PayoutProvider -> PublisherProviderAccount (managed
  routes) -> PayoutMethod`;
- payout finalization/abandonment:
  `PayoutWebhookEvent (when present) -> Withdrawal -> PayoutExecution ->
  PublisherBalance -> deferred PayoutMethod liability update`;
- new withdrawal reservation:
  `Settlement/Transaction allocation parents (when present) ->
  PublisherBalance -> PublisherProviderAccount (managed routes) -> deferred
  PayoutMethod liability update`;
- managed payout-method reactivation:
  `PublisherProviderAccount -> PayoutMethod`;
- payout-method deactivation: `PayoutMethod` only;
- customer order payment:
  `Order -> Wallet -> PaymentDispute exposure predicate -> ledger`;
- customer payment dispute:
  `PaymentProviderEvent -> immutable deposit lookup -> Wallet -> PaymentDispute -> ledger`.
- settlement creation/approval/release:
  `Order aggregate lock -> relational eligibility snapshot -> Settlement ->
  PublisherBalance -> ledger/audit`. Delivery, dispute, revision, fraud, and
  cancellation writers acquire the same Order lock before becoming visible;
  the release reader does not lock child rows in the reverse order.

For every `OrderDeliveryVersion`, `OrderDispute`, `Revision`,
`DeliveryFraudFlag`, `DeliveryFraudFlagResolution`, or
`OrderCancellationRequest` command, the parent `Order ... FOR UPDATE` lock is
the first application lock in the retryable transaction. `DeliveryFraudHold`
is not a command surface: PostgreSQL projects it from an immutable flag and
removes it only while appending the matching adjudication. Blocker-table
triggers are database backstops, not the application lock strategy:
PostgreSQL can already own the child tuple when a `BEFORE` trigger runs, which
would invert the lock order against a settlement reader. When only a child ID
is supplied, resolve `orderId` with a non-locking preflight read, then lock
`Order` first and re-read/revalidate the child inside the transaction. The
canonical helper runs these closures at `SERIALIZABLE` with a bounded retry
only for trusted serialization/deadlock codes. Provider, queue, external
notification delivery, email, and object-storage work stays outside the
retryable closure; durable notification rows may remain part of the atomic
database work.

The deposit lookup is evidence validation, not a row lock. Customer spend and
dispute processing intentionally share `Wallet ... FOR UPDATE` before either
path reads or creates `PaymentDispute` state. This orders the case-insertion
predicate even when a zero-held or won dispute does not change
`Wallet.version`. A transaction that crosses aggregate families requires an
explicit deadlock-order review.

Use a conditional status/version update or an explicit row lock. Never perform
an unguarded read-modify-write.

Provider-managed payout routing identity is append-only. A
`PublisherProviderAccount` cannot change publisher, provider, external account
ID, or creation identity and cannot be deleted. A `PayoutMethod` cannot change
publisher, type, or provider-account binding. Readiness facts remain mutable,
but every reservation, reactivation, and external-send claim must revalidate
the full Stripe readiness predicate while following the account-before-method
lock suffix. Provider synchronization may create a missing active managed
method, but it never reactivates a method that its owner disabled.

- Retry only recognized serialization, deadlock, or optimistic-conflict
  failures.
- Retries are bounded and use jitter.
- Business conflicts, validation failures, evidence mismatches, and unknown
  uniqueness collisions are not retried as transient failures.
- Do not catch a PostgreSQL error and continue querying through the aborted
  transaction. Roll back first, then classify or re-read in a fresh
  transaction.
- A public request may return a retryable error only when repeating its scoped
  idempotency key is safe.

Settlement financial identity, review policy, and reporting snapshots are
immutable after creation. A release commits only with one exact
`SETTLEMENT_RELEASE` ledger row whose settlement, order, publisher, amount, and
currency match; that evidence is append-only. A released settlement without
that pair cannot commit, including through direct SQL.

A captured Order (`PAID`, including a later `REFUNDED` payment state) has
exactly one append-only `PURCHASE` row. That row is negative,
USD, exact to the Order amount, belongs to the Organization's USD Wallet, and
has no provider, publisher, or settlement identity. It is the canonical
capture evidence; a status flag, reservation row, audit event, or redirect
cannot substitute for it. Payment capture claims the Order first, then moves
Wallet available → reserved → consumed and inserts the `PURCHASE` in the same
serializable transaction. Concurrent submissions may produce only one winner.
The database verifies this relationship in both directions at commit: a
captured header cannot commit without its exact PURCHASE, and an Order with a
PURCHASE cannot be rewritten to `PENDING` or `FAILED`.

Platform-owned fulfillment does not weaken that proof. A new
`PlatformRevenue` row is allowed only while the locked Order is paid,
`DELIVERED`, explicitly snapshotted as `PLATFORM`, and passes the same active
delivery/dispute/revision/cancellation/unresolved-fraud gate as publisher
settlement. Its USD amount equals the Order and the one canonical `PURCHASE`;
`amount = platformFee + netRevenue` in whole cents. It snapshots integer
`platformFeeBps` plus the singleton `PlatformSettings` row/version identity.
Those fields and all attribution snapshots are immutable. A refund may append
`reversedAt` exactly once, but cannot edit or delete recognition evidence.
Reversed rows that predate versioned policy evidence may retain a null policy
pair; no new or unreversed row may do so.

Before that capture, `ListingService.price`, every `OrderItem.price`, and
`Order.amount` are positive USD values exact to one cent. Order construction
and cart totals stay in Decimal space. Add, remove, reprice, and capture all
take the parent Order lock first and increment the Order version when the cart
changes. Capture requires at least one `PENDING_PAYMENT` item, one matching
website identity, and `Order.amount = SUM(OrderItem.price)` before touching the
Wallet. The command also carries the exact Order version, canonical two-decimal
amount string, and `USD` currency shown to the buyer. A stale command fails
before any Wallet or item read; it cannot adopt a concurrent cart mutation or
server re-price.

Capture locks and revalidates the complete immutable attribution chain:
`Order.listingServiceId -> ListingService.listingId -> MarketplaceListing.websiteId
-> Order.websiteId`. The service, Order type, listing, website, and
fulfillment-channel snapshot must agree; the service must be `AVAILABLE`, the
listing `APPROVED`, and the website active and ownership-verified. Every item
price must equal the current selected service price. PostgreSQL repeats the
amount, precision, catalog-attribution, live-availability, and capture checks.
Once the
Order is paid, has PURCHASE evidence, or has a Settlement, OrderItem insertion,
mutation, reassignment, and deletion are forbidden.

## 6. Customer wallet

For every wallet:

```text
availableBalance >= 0
reservedBalance >= 0
```

- Available funds can be spent.
- Reserved funds remain a customer liability but cannot be spent.
- Moving available to reserved does not create or destroy customer liability.
- Capture consumes the specific reservation it owns.
- Release returns that specific reservation to available.
- A shared reserved bucket must never be consumed without a domain record
  proving which reservation owns the amount.
- Every new available-balance spend enters through `BillingService.reserve`.
  In the same transaction it locks the wallet row, re-reads and authorizes the
  wallet, checks durable dispute exposure, then validates and moves the
  balance. No controller, worker, or internal service may decrement available
  funds around that boundary.
- `payFromReserved` consumes only a commitment created before capture; it does
  not authorize a new available-balance spend and must not be used to bypass
  the reserve gate.

Customer wallets are closed-loop until a separately approved external-return
design exists. No endpoint may reduce a wallet under the label “withdrawal”
without a durable external return aggregate, source-funding allocation,
destination policy, provider execution, terminal evidence, and reconciliation.

An external customer return must ordinarily return funds to eligible original
funding sources. A generic transfer to an arbitrary destination is not a card
refund and is not authorized by the wallet balance alone.

## 7. Customer deposits

A wallet credit requires all of:

- a durable `DepositAttempt`;
- verified webhook evidence, or authenticated provider retrieval only through
  a separately implemented and certified exact-evidence finalizer;
- exact amount, currency, environment, wallet, and metadata match;
- one provider payment identity;
- one `DEPOSIT` ledger row;
- one atomic wallet credit, attempt transition, inbox transition, and audit.

Redirects and checkout-session creation do not authorize a credit.

The authenticated deposit-capability read is advisory only. New Checkout
creation requires the explicit deposit feature gate, normal finance mode, an
owned canonical USD wallet, and the same server-side checks in the command.
An explicit client idempotency key is never truncated: it must match the
bounded safe-key grammar or the command is rejected. Initial lookup,
post-unique-conflict reread, attachment races, and provider-failure races all
compare the exact actor, tenant, wallet, amount, wallet credit, zero-fee
snapshot, method, provider, currency, and empty pre-credit linkage.

A Stripe Checkout create or retrieval response is reduced to bounded facts and
accepted only when its object/session identity, client reference, metadata,
wallet, actor, organization, amount, USD currency, payment mode, credential
environment, expiry, and trusted HTTPS Checkout host match that immutable
attempt. An open URL is returned only after this comparison. Provider and
database diagnostics never cross the adapter boundary: pre-checkout failures
persist only a categorical `failureCode`, and a failed evidence write or an
unproven CAS successor returns a stable unavailable response without moving
money.

Every signed payment-provider event first commits to the durable inbox as
`PENDING` (or, when the signed envelope is malformed, terminal
`QUARANTINED`). Provider identity, event type, object identity, normalized
financial facts, environment, fingerprint, and receipt timestamps are
immutable for every event type; rows are never deleted. Claims use
`PENDING|FAILED -> PROCESSING`, increment one attempt, and own a bounded lease.
Every other transition preserves the attempt counter exactly; terminalization
cannot manufacture a new claim generation. Only the claimant may reach a
controlled terminal state.

Inbox ownership is the exact fencing token `(attempts, lockedAt)`, not merely
`status = PROCESSING`. Every claimant-authorized read, wallet/aggregate
transition, completion, failure, and quarantine must either lock the inbox row
and revalidate that exact token or use a conditional write containing all
three predicates: `status`, `attempts`, and `lockedAt`. Lease recovery
increments `attempts` and assigns a fresh `lockedAt`; an old owner then affects
zero rows and must return non-2xx without audit, notification, or money
mutation. A snapshot of another active lease is never authority. Exact replay
may return 2xx only from a locked, unchanged terminal snapshot
(`PROCESSED`, `IGNORED`, or `QUARANTINED`) whose terminal evidence also
matches.

A deposit uniqueness violation is accepted as an exact replay only after the
failed transaction rolls back and one `DEPOSIT` row is re-read with the exact
session reference, provider PaymentIntent, wallet, amount, currency, and linked
wallet-credit-backed `DepositAttempt`. Wallet-credit-backed means the attempt
is in exactly one of `SUCCEEDED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`,
or `CHARGEBACK`: those derivative states do not erase the immutable fact that
the original wallet credit and `DEPOSIT` row committed. Any difference is an
identity collision: quarantine the inbox event, alert Finance/Super Admin, and
move no money.

The quarantine rule has one evidence-preservation exception. If a verified
duplicate provider identity conflicts with an inbox row designated by
`PaymentDispute.openedByEventId` or `resolvedByEventId`, that canonical row
must remain `PROCESSED`; the deferred exact-role constraint intentionally
forbids rewriting it. Under the event row lock, retain the role link and all
immutable facts, create one durable
`PAYMENT_PROVIDER_EVENT_IDENTITY_CONFLICT_DETECTED` incident, and send
deduplicated Finance/Super Admin alerts. Repeated delivery of the same
collision returns 2xx without another incident, alert, case transition, or
money movement. Only a colliding event that is not designated canonical role
evidence may transition to `QUARANTINED`.

Every newly accepted Stripe inbox envelope has non-null `livemode` evidence,
and it must match the configured credential mode before any transition. A
durable dispute replay rechecks the current secret/restricted-key mode and the
live-money gate immediately before taking the wallet lock. A test event delayed
across live promotion, a live event delayed across a test rollback, or live
evidence while the gate is disabled is deterministically quarantined by the
exact inbox lease; it is not retried indefinitely.
Historical rows that predate this field are not retroactively assigned a mode;
they cannot authorize a new money transition and require fresh signed delivery
or incident review. Both
full-access (`sk_test_`/`sk_live_`) and restricted
(`rk_test_`/`rk_live_`) keys use the same mode classifier. Missing, malformed,
or contradictory mode evidence fails closed and is never inferred from an
event ID, endpoint, or deployment name.

The current normalized checkout inbox intentionally does not store enough
provider data to recreate a wallet credit without a fresh signed delivery.
Therefore locked finance mode first persists a checkout-success event as
`PENDING` and then returns non-2xx. Any signed redelivery that finds another
live `PROCESSING` lease also returns non-2xx, regardless of event type; an
active lease is not a terminal replay. These responses keep Stripe redelivery
active. After recovery is enabled, or after the lease expires, a fresh signed
delivery may claim and reprocess the row. Scheduled reconciliation treats
stale, failed, and quarantined deposit-success inbox rows as critical; it must
never manufacture a completion from local state.

Only normalized dispute envelopes contain enough durable facts for locked mode
to acknowledge them as deferred for the worker. Checkout expiry/failure and
Radar early-fraud-warning rows also depend on their fresh signed bodies, so
locked mode persists them as `PENDING` and returns non-2xx. A later signed
delivery processes them after recovery is enabled. Unsupported signed event
types require no money facts and are atomically terminalized as `IGNORED`;
they must not remain permanently `PENDING`.

The implemented Stripe deposit path has no independent authenticated
Checkout/PaymentIntent catch-up worker. Today, only a fresh
signature-verified Stripe delivery can supply the missing completion facts
after this crash gap. Authenticated provider retrieval remains a valid future
evidence source only after a separately reviewed implementation persists,
matches, and reconciles the same immutable facts; operators must not assume
that recovery path exists now.

## 8. Payment disputes and risk holds

A provider dispute has one durable, provider-neutral case keyed by
`(provider, providerDisputeId)`. The deposit payment identity remains attached
to the deposit and is never reused for the hold transaction.

Required invariants:

- each case's designated opening/resolution event is an exact `PROCESSED`
  inbox row with a matching case/deposit backlink and immutable provider
  envelope; this is checked bidirectionally at commit;
- additional duplicate provider events may correlate to the case without
  replacing its unique designated opening/resolution evidence;
- an open linked case with a positive hold has one exact reservation ledger
  row; a structured zero-held case has no zero-value ledger row;
- the immutable booked amounts satisfy
  `heldAmount + shortfallAmount = disputedAmount`;
- current uncovered exposure equals `shortfallAmount` while the case is
  open or lost, and is zero after a won outcome;
- amount and currency match normalized provider truth and the linked funding
  context; the certified dispute path is USD-only and every case amount,
  hold, shortfall, and current-exposure value is a whole number of cents;
- only an open/held case may transition once to a terminal outcome;
- won/released and lost/debited are mutually exclusive;
- a terminal case has at most one resolution ledger row;
- terminal events cannot regress the successful deposit funding fact;
- duplicate and out-of-order events converge on provider truth;
- a complete, verified close-before-open event may create the case directly in
  its terminal state and book that outcome once; an incomplete, unsupported,
  or contradictory event remains retryable/quarantined and does not move
  money.

Once a deposit is wallet-credit-backed, its `DepositAttempt` identity and
linked `DEPOSIT` ledger row are immutable and cannot be deleted, even before
the first dispute exists. This earlier boundary closes the case-creation race.
At commit, its non-refund customer projection is derived from all cases with
strict precedence: any `LOST` case means `CHARGEBACK`; otherwise any `OPEN`
case means `DISPUTED`; otherwise it is `SUCCEEDED`. `PARTIALLY_REFUNDED` and
`REFUNDED` are independent sticky projections until refunds have a normalized
aggregate of their own.

A lost dispute consumes only the reservation owned by that dispute. A won
dispute releases only that reservation. A lost close that arrives before the
open event may debit available funds directly; that resolution path must remain
distinguishable from a missing historical hold. Uncovered exposure is a
structured financial fact, not text embedded only in an audit description.

`heldAmount` and `shortfallAmount` are immutable booking facts.
`currentExposureAmount` is the mutable, monotonic exposure projection. A later
`WON` outcome sets current exposure to zero without rewriting the amount that
was unheld when the case was booked.

Any positive `currentExposureAmount` on an `OPEN` or `LOST` case is a
fail-closed wallet spend hold. After locking the wallet, `BillingService.reserve`
returns `409 WALLET_SPEND_BLOCKED_BY_DISPUTE` before any balance or ledger
mutation. A `WON` case, or a case with zero current exposure, does not block a
new reservation.

Credits and refunds may still post while exposure exists, but they do not make
that wallet spendable. If dispute processing wins the wallet lock, a concurrent
reservation waits and then observes the case; if spending won the lock and
committed before the case existed, dispute processing calculates its hold and
shortfall from the post-spend wallet state. A `LOST` shortfall remains blocked
after future credits until a separately reviewed recovery/netting workflow
allocates evidence and updates the accounting model. The current system does
not auto-sweep credits, and operators must not edit exposure or balances
ad hoc.

Dispute events are retried from their immutable normalized inbox facts on the
five-minute maintenance lane. Stale claims are recovered, transient failures
use bounded exponential backoff, and deterministic contradictions or retry
exhaustion become terminal quarantine evidence with Finance/Super Admin
notification. Application handling and worker recovery use the same
serializable transition core, lock the inbox event first, and carry the exact
claim `(attempts, lockedAt)` into the core. A stale pre-recovery worker cannot
fail or quarantine the newer attempt, and must not log that either mutation
succeeded.

## 9. Publisher withdrawals

### Publisher settlement eligibility

Settlement policy is not settlement evidence. Creation, customer/system/admin
approval, and final release all use the same live predicate while holding the
Order aggregate lock. Eligibility requires all of the following:

- order status `DELIVERED`, payment status `PAID`, and currency exactly `USD`;
- the active delivery identity belongs to the order and is independently
  `VERIFIED` or carries a current explicit `APPROVED`/`OVERRIDDEN` intervention;
- an explicit `REJECTED` intervention always wins;
- no open/under-review dispute and no current `DeliveryFraudHold`;
- every revision is terminal (`APPROVED` or `REJECTED`); and
- every cancellation request is safely terminal (`REJECTED`, `WITHDRAWN`, or
  `APPROVED` with the explicit `CONTINUE_ORDER` resolution).

A staff manual-delivery override is evidence only when the canonical
active-delivery-version intervention accepts it. The transition must require a
bounded audited reason, recheck current staff authority while holding the Order
lock, advance the delivery version and Order with optimistic guards, and append
the event and audit facts atomically. Compatibility routes must delegate to
that same transition. Updating only `Order.status`, `verifiedAt`, or
`verifyMethod` is not delivery evidence and must never make a settlement
eligible.

Revision and cancellation states are terminal allowlists: a future enum value
blocks settlement until reviewed. PostgreSQL serializes blocker writes through
the Order row and independently rejects an ineligible Settlement insert or
release. A conditional update that loses after the first financial write must
throw so the entire transaction rolls back; returning “skipped” would commit a
partial release. One settlement can own at most one `SETTLEMENT_RELEASE` ledger
row.

Publisher attribution is relational and cannot be caller-selected:
`Order.websiteId -> Website.publisherId` is canonical. Once any Order
references a Website, ordinary writes cannot change that Website's publisher
or ownership type. A Settlement must match that publisher, the exact paid
Order amount and currency, and the snapshotted listing-service identity.
OrderItem publisher fields and stale request payloads are not liability
authority.

There is exactly one `PlatformSettings` row. Its fee percentage has at most two
decimal places and resolves exactly to integer basis points; clamping,
rounding an unrepresentable input, `NaN`, and sub-basis-point values are
rejected. Every new Settlement and PlatformRevenue row snapshots both the
basis points and the settings row/version identity. Its exact fee split must
equal that policy at creation and cannot drift when the singleton changes
later. Released/cancelled/reversed historical snapshots remain immutable
evidence.

Delivery fraud flags are bound to the same Order as their delivery and are
immutable after insertion. PostgreSQL atomically projects each flag into
`DeliveryFraudHold`; its structural `(deliveryVersionId, type)` uniqueness is
the one-open-hold concurrency invariant. A recurring signal after resolution
appends a new immutable flag and hold instead of rewriting history. Eligibility
reads the hold projection, never “absence of a duplicate” or a mutable flag
status. A hold can disappear only in the same transaction that appends its
one immutable `DeliveryFraudFlagResolution`; a deferred constraint rejects a
standalone delete.

`STAFF_CLEARED` requires a current, non-banned STAFF user with an allowed
`SUPER_ADMIN`, `OPERATIONS`, or `FINANCE` membership, the role snapshotted at
decision time, and a substantive reason. `LINK_RESTORED` has no synthetic
staff actor: it requires fresh, passing, append-only
`DeliveryVerificationEvidence` for the same active, non-superseded delivery
and links that evidence by ID. Verification evidence and raw delivery
snapshots are append-only. Resolution insertion advances the settlement fence
under the Order lock, so it cannot race release. Slow verification and
link-recheck jobs re-read active-delivery identity, supersession, and the
signed optimistic generation under that lock before changing state or
appending evidence. Stale jobs may leave an unreferenced content-addressed
object, but no database evidence, state, flag, or hold.

Automated policy may choose when an eligible row is reviewed, but it never
bypasses this predicate. Its additional freshness boundary is defined below;
human and system decisions remain distinct immutable evidence.

Every customer revision surface uses the canonical Order-review transition:
after locking Order it revalidates organization, an ACTIVE organization
membership, creator-or-owner authority, `CUSTOMER_REVIEW` status, cancellation
holds, and the snapshotted revision limit before creating a Revision. That
limit is the immutable
`Order.revisionRoundsSnapshot` captured at create time; mutable marketplace
terms are never consulted for an in-flight order. A pre-final delivery re-verification
atomically clears any old manual intervention before moving back to a pending
state. Once an order is `DELIVERED`, `SETTLED`, `COMPLETED`, `CANCELLED`, or
`REFUNDED`, manual rejection, re-verification, and negative verification
override cannot rewrite the delivery evidence that authorized or concluded its
financial lifecycle.

Orders created before the revision snapshot existed retain `NULL` as explicit
unverified contract evidence. Migration must not copy the current mutable
ListingService entitlement into history. A revision request on such an order
fails closed with `REVISION_POLICY_EVIDENCE_MISSING` pending a separately
designed, reviewed evidence-repair workflow.

Automated release has one additional evidence boundary: after locking the
canonical Order and Settlement, it selects the newest immutable verification
observation for the currently active delivery. The observation must be no more
than 12 hours old, not future-dated or committed after the release time, have
HTTP status `200`, `301`, or `302`, and prove the link, target URL, and anchor.
The 12-hour constant is fixed in application and PostgreSQL (one missed margin
for the six-hour monitor) and is not deployment-configurable. Missing, stale,
or failed evidence increments `freshnessBlocked` and performs no approval,
balance, ledger, or Order write. Human release does not use this freshness
window, but still requires durable ADMIN approval and every canonical
eligibility gate above. Workers emit structured warnings for
`freshnessBlocked`, link-check failures, and `scanCapReached`; operators must
treat those as an incomplete evidence scan, never as permission to release.

A withdrawal request reserves an existing publisher liability exactly once:

```text
withdrawable source
  -> immutable WithdrawalAllocation reservation
  -> provider execution
  -> verified paid completion
```

The effective withdrawal state graph is:

```text
PENDING -> APPROVED | REJECTED
APPROVED -> PROCESSING | REJECTED (claim-free pre-provider abandonment only)
PROCESSING -> APPROVED | FAILED | COMPLETED
FAILED -> APPROVED | COMPLETED
COMPLETED | REJECTED | REVERSED -> terminal
```

`PROCESSING|FAILED -> APPROVED` requires the latest execution to carry typed
safe-cancellation evidence. `FAILED -> COMPLETED` exists only so verified late
terminal evidence can converge. Although `REVERSED` remains in the enum for
legacy compatibility, the current database guard rejects every new transition
to it because no certified runtime reversal command carries sufficient
provider evidence.

An `APPROVED -> REJECTED` transition is a typed Finance abandonment, not a
generic reversal. It is allowed only while every execution is a
`PRE_PROVIDER_ABORTED` cancellation and no normalized send claim or provider
object ID ever existed. The original approver remains recorded; the rejecting
Finance actor, reason, allocation releases, balance restoration, reversal
ledger row, and `WITHDRAWAL_PRE_PROVIDER_ABANDONED` audit event commit
atomically.

The effective payout-execution status graph is:

```text
PROCESSING -> FAILED | COMPLETED | CANCELLED
FAILED -> COMPLETED
COMPLETED | CANCELLED -> terminal
```

New executions enter as `PROCESSING`; runtime inserts cannot start terminal.
Every update increments `version` by exactly one.

- Request checks available funds and atomically subtracts them from
  `withdrawableBalance`.
- Allocations must sum to the withdrawal gross amount, use the same currency,
  and remain unreleased while the withdrawal is active.
- Approval validates the existing reservation, requester eligibility, hold
  period, active method, and absence of conflicting execution. It does not
  require the already-reserved amount to still be available.
- Requester eligibility is tied to the recorded requester, not to the presence
  of some other eligible publisher owner, and is revalidated at approval and
  immediately before the external send.
- Allocation identity, source, amount, currency, and sequence are immutable at
  the database layer; rows cannot be deleted. Rejection releases each
  allocation exactly once after the parent becomes `REJECTED`, and a deferred
  assertion prevents commit while any reservation remains active.
- Payout methods carry a trigger-maintained count of `PENDING`, `APPROVED`,
  `PROCESSING`, and `FAILED` withdrawals. Deactivation is a serializable,
  audited update and is database-rejected until this reserved-liability count
  reaches zero; flags cannot override or rewrite the counter.
- Legacy direct payout-method entry is off unless explicitly enabled. Its
  bounded rail-specific schemas reject unknown and cross-rail fields, and
  current publisher-owner/user/publisher rows are locked and revalidated in
  the same serializable transaction as encryption, default-method
  serialization, creation, and audit.
- The certified new-withdrawal method set is code-owned and closed: manual
  `bank_transfer` while that rollout is enabled, or a fully ready
  `stripe_connect` method bound to the same publisher's active USD provider
  account. PayPal and Wise rows are legacy lifecycle records only: they may be
  listed for support visibility and disabled, but cannot be created,
  reactivated, selected, or used for a new reservation. A previously
  committed command may be returned only as an exact idempotent replay; replay
  never creates new liability or provider work.
- Method lists expose a server-computed eligibility result. Publisher clients
  select only active, certified methods carrying affirmative executable
  eligibility. A failed method query, failed provider-status query, paused
  finance mode, disabled rollout, provider-binding mismatch, incomplete
  provider readiness, non-USD provider currency, positive publisher debt, or
  absent destination is a non-submittable state. The request, approval, and
  external-send claim transactions re-lock and re-evaluate the same canonical
  predicate; UI state is never authority. A disabled route may still expose a
  narrowly scoped recovery operation only for an existing durable send claim,
  with its original idempotency key, lease, amount, currency, and routing
  evidence; the recovery client is not available to new-send commands.
- Evidence-backed payout cancellation returns the existing reserved
  withdrawal to `APPROVED`; it does not release allocations or restore the
  balance again. Generic failed-withdrawal reversal remains disabled.
- Completion consumes the reservation only after terminal payment evidence and
  increments `lifetimePaid` exactly once.
- A missing publisher balance, allocation mismatch, version conflict, or
  ambiguous execution fails closed.
- Legacy reservation reconstruction is evidence-only. A missing `PENDING`
  allocation requires one exact pre-cutover withdrawal debit, matching
  requester audit, and no decision, reversal, execution, or allocation. A
  missing `REJECTED` allocation requires the same exact pre-cutover request
  evidence plus one exact post-cutover rejection reversal and matching
  request/rejection actor audits, with no approval or payout execution.
  Migration `20260802097000_legacy_withdrawal_reservation_evidence` aborts on
  every missing, duplicate, partial, contradictory, or ambiguous fact.
- An evidence-proven pending reconstruction increases carry-forward and
  carry-forward-used equally; available carry-forward and withdrawable
  liability remain unchanged. An evidence-proven rejected reconstruction
  creates a released allocation and increases only carry-forward because its
  exact reversal already restored the liability. Neither path changes
  pending, approved, debt, lifetime earnings, or lifetime paid.
- Across active and completed states, at most one money-moving execution may
  exist for a withdrawal; a partial unique index enforces the combined set.
  A replacement execution is also rejected when any prior execution lacks
  typed cancellation evidence, including `FAILED` rows outside that index.
- New withdrawals and executions must use canonical provenance-backed insert
  shapes. Database triggers reject stale applications that omit requester,
  idempotency, payout-method, command, or immutable routing-snapshot data.
- Every provider call is preceded by an atomic execution claim that revalidates
  the destination and binds the immutable destination snapshot used for the
  send.
- `PayoutExecutionClaim` is the sole database authority for an external send.
  It is append-only and unique by `(executionId, kind)`, where kind is exactly
  `PROVIDER_SEND` or `BANK_PAYOUT_SEND`. It stores the exact idempotency key,
  its SHA-256 fingerprint, the immutable first claim time and actor, and a
  monotonic `lastClaimedAt` lease timestamp.
- Approval, external send, recovery/retry, cancellation, and cancellation
  resume are deliberate Finance actions, never one-click mutations. External
  send requires the operator to type the withdrawal public reference; recovery
  and cancellation require their explicit action token. Every external-send,
  recovery, or cancellation command carries a trimmed 10–500 character
  rationale. The service revalidates the current unbanned Finance/Super Admin
  actor and commits that rationale as audit evidence before provider I/O.
  Operator rationale is internal evidence and is never sent to a provider as
  an instruction.
- `PayoutExecution.providerMetadata` is informational evidence and immutable
  routing/completion context; it is never send authority. The
  `externalClaims` JSON member is removed during migration and rejected by the
  database thereafter. Code, incident queries, and operators must never treat
  a JSON flag or audit row as proof that a provider call was claimed.
- A claimed send is owned for 15 minutes. An ambiguous claim may be replayed
  only from 15 minutes through 23 hours, with the exact original provider
  idempotency key and a fresh locked validation of reservation, actor, routing,
  provider configuration, amount, and currency. Recovery must match the first
  durable claim's idempotency-key fingerprint; a missing or changed
  fingerprint is quarantined and never overwritten from current row state.
  The original claim timestamp is immutable across retries.
- At 23 hours, a claimed send becomes review-only. It is quarantined and
  alerted to Finance/Super Admin; automated create replay is forbidden because
  the provider may no longer retain the idempotency record.
- A returned Stripe Transfer or bank Payout is untrusted until its object type,
  object ID, amount, currency, connected account, and withdrawal reference all
  match the immutable command. A mismatch never contributes provider IDs,
  accepted references, fees, or provider metadata to the execution. The
  reservation and claimed stage remain intact; a sanitized error update,
  `PAYOUT_PROVIDER_RESPONSE_QUARANTINED` audit, and deduplicated Finance/Super
  Admin notifications commit together. Even when a concurrent stage/version
  prevents that error update, the same locked transaction records expected
  versus observed state with `stateMutationApplied=false` and sends the alert.
  Recovery may use only the original fenced idempotency key; Finance/Security
  must establish provider truth before any completion, cancellation, balance
  release, or replacement send.
- A sent or outcome-unknown execution cannot be cancelled, reversed, retried
  with a new identity, or returned to `APPROVED` without provider/bank evidence
  proving no money moved.
- `CREATED` or `DESTINATION_VALIDATED` may be safely aborted only when a locked
  check proves no provider ID or external-call claim exists. Typed
  `PRE_PROVIDER_ABORT` cancels that execution and atomically returns the still-
  reserved withdrawal to `APPROVED`.
- `PRE_PROVIDER_ABORT` is local proof that no external call was claimed; it is
  not provider cancellation or reversal evidence. Once a provider claim or
  provider object ID exists, only typed provider cancellation/reversal evidence
  may authorize the corresponding recovery transition.
- Provider cancellation requires typed Stripe response evidence: immutable
  Transfer/Payout IDs, a unique reversal reference, evidence time, terminal
  Payout status when applicable, actor, and cancellation time. `CANCELLED`
  executions are immutable.
- `CANCEL_REQUESTED` is an exact external-call lease, not a generic retry
  state. A second Finance command is rejected while the 15-minute lease is
  fresh. Only an errored or stale command may use **Resume cancellation**, and
  every terminal/error write is fenced by the claimed execution version.
- Stripe `TransferReversal` has no `livemode` field. Cancellation mode
  authority comes from the authenticated parent Transfer; any Payout and
  canceled-Payout response must carry the same mode before a reversal is
  issued. Reversal evidence must match Transfer ID, full amount, currency,
  withdrawal reference, and payout-execution ID.
- Cancellation recovery does not depend only on Stripe's idempotency retention.
  If the Transfer is already fully reversed, authenticated lookup must find
  exactly one full `trr_...` reversal with the immutable command metadata.
  Partial, multiple, truncated, or mismatched reversal evidence leaves the
  reservation held and creates the cancellation-evidence incident. It never
  creates another reversal or reopens the withdrawal.

Requester, approver, executor, and completer provenance must not overwrite one
another. Organization-wide payout blocking requires an explicit publisher
payout-hold field and reason; it must not be inferred from a nonexistent model
property.

Maker-checker is enforced at each trust boundary:

- approval and rejection require a current, unbanned Finance or Super Admin;
- an execution initiator must be current and eligible and must differ from the
  withdrawal approver;
- the first `PROVIDER_SEND` claimant must be current and eligible and must
  differ from the approver;
- manual completion requires a current eligible checker distinct from the
  requester, approver, and execution initiator.

No JSON metadata, role change after the fact, or generic administrative
permission may substitute for those recorded actors.

## 10. Payout completion evidence

| Payout route | Evidence required for completion |
|---|---|
| Stripe Connect | Persisted bank Payout ID in `paid` state from the create response, authenticated retrieval, or verified `payout.paid`; exact positive provider amount in minor units, exact normalized destination currency, and the immutable connected-account ID used for the execution |
| Wise | After certification only: persisted transfer ID in paid/completed state from verified terminal event or authenticated retrieval, with exact provider amount/currency and any provider-account scope required by the route |
| Manual bank route | Existing manual execution, exact canonical withdrawal public reference from the locked Withdrawal row, immutable bank/payment reference, paid timestamp, amount/currency match, staff reason, known requester/approver/execution initiator provenance, and a current Finance/Super Admin payment checker distinct from each |

The Wise row defines the evidence bar for future certification; automated Wise
sends and claimed-send replay are currently disabled.

Every automated completion source—provider create response, authenticated
status poll/retrieval, or verified webhook—must supply a positive provider
amount in minor units and normalized ISO currency. They must equal the
execution's immutable `destinationAmount` and `destinationCurrency` using the
certified currency exponent. Stripe evidence must additionally identify the
persisted `po_...` bank Payout, never the Transfer, and use the exact connected
account in the immutable destination snapshot. Missing or mismatched
reference, amount, currency, account, or event type is a deterministic
evidence conflict: no liability changes. A verified webhook conflict is
quarantined and alerts Finance/Super Admin.

Payout webhook processing authority is the exact
`(PayoutWebhookEvent.attempts, lockedAt)` claim that the worker acquired.
That token is carried through completion, terminal-failure review, retry,
ignore, and quarantine. The database compares the token embedded in canonical
completion evidence with the locked inbox row before allowing liability to be
released. Recovering a stale lease increments the attempt and assigns a new
timestamp; the former claimant then performs no payout, inbox, audit, or
notification mutation and may not adopt the newer claimant's token.

Generic “Mark Paid” is not valid evidence. An automated withdrawal cannot be
converted into a manual completion. Manual completion cannot create an
execution after the fact merely to justify a completed withdrawal. The Finance
dialog must show publisher, amount/currency, withdrawal reference, and
execution identity and require the exact untrimmed public reference. The
canonical finalizer compares it with the already-locked Withdrawal row; a null
or mismatch is audited and changes no execution, balance, allocation, or
ledger state.

The requester, approver, and execution initiator must all be known, and the
manual payment checker must be different from each of them. The initiator and
checker must each be a current, unbanned Finance or Super Admin staff member
at their respective trust boundary. Any missing or ambiguous requester,
approver, or execution initiator provenance—including an in-flight legacy
row—blocks manual completion pending a reviewed, evidence-backed repair.
Thresholds and role requirements are server-side policy.

Completion is terminal. Its source, evidence reference and time, actor or
verified webhook, bank trace, and completed timestamp are immutable. A
contradictory later provider event is quarantined as a critical reconciliation
conflict; it cannot regress or silently overwrite the completed state.
Signed Stripe terminal events are also bound to the top-level Connect
`account` and an allowlisted bank-Payout event type. A late failure after local
completion is quarantined as contradictory provider evidence and alerted, but
never automatically decrements `lifetimePaid`, restores allocations, reopens
the withdrawal, or starts another payout.

The database rejects a direct non-terminal-to-`COMPLETED` Withdrawal update
unless exactly one matching evidence-backed `COMPLETED` PayoutExecution already
exists. This makes stale pre-migration “Mark Paid” writers fail closed even if
an application-layer authorization check is bypassed.

## 11. Audit, notification, and denial evidence

- The money mutation, domain transition, ledger row, and mandatory audit row
  commit atomically.
- Notification delivery is not a source of financial truth. When an alert is
  required for safe recovery, its durable in-app notification record commits
  with the transition. External delivery happens after commit and may be
  retried; failure cannot rewrite a committed financial result.
- A denied high-risk action needs durable audit evidence. Commit the denial
  result, then throw the public API error outside that transaction.
- Audit metadata stores identifiers and normalized facts, not secrets, bank
  details, full provider payloads, or authentication material.

## 12. Error contract

| Class | Result |
|---|---|
| Invalid amount/currency/input | `400`, no mutation |
| Unauthenticated or unauthorized | `401`/`403`, no existence leak |
| Missing aggregate | `404`, no mutation |
| Idempotency input mismatch or state/version conflict | `409`, no partial mutation |
| Positive open/lost dispute exposure on wallet spend | `409 WALLET_SPEND_BLOCKED_BY_DISPUTE`, no balance or ledger mutation |
| Provider unavailable before send | retryable failure, reservation retained or safely released according to recorded send state |
| Timeout/unknown after send | ambiguous/recovery state, reservation retained |
| Provider terminal rejection with proof of no movement | failed/cancelled state; release through an idempotent compensating transition |
| Evidence mismatch or contradictory event | quarantined/retryable event, alert, no money mutation |
| Internal database/audit failure | transaction rollback; provider-side ambiguity reconciled before retry |

Public errors must not expose provider payloads, database constraints, account
details, or whether an out-of-scope tenant object exists. Logs use correlation,
aggregate, event, and safe provider-reference identifiers.

### Aggregate provisioning

`Wallet` and `PublisherBalance` rows are accounting state, even while all
amounts are zero. They are created atomically with the owning `Organization`
or `Publisher`, never by a GET/list endpoint. Migration
`20260729120000_provision_finance_aggregates` backfills history-free owners and
aborts if a publisher or organization has attributable financial history but
no balance/wallet row. Only ACTIVE memberships attribute an ambiguous legacy
personal wallet to an organization; a PENDING invite never does. The payout
provenance and aggregate migrations acquire stable, short-timeout SHARE lock
barriers before their preflights so a concurrent old writer cannot invalidate
the snapshot. A missing aggregate after that cutover is an invariant failure:
reads return `404` without repairing or mutating state, and Finance must
investigate it.

## 13. Reconciliation

Internal sums alone cannot prove external money correctness. Reconciliation
must assert:

- provider-paid deposits correspond to exactly one wallet credit;
- processed dispute-open events correspond to a durable case and hold;
- active and terminal dispute cases satisfy their hold/resolution invariants;
- publisher withdrawal allocations equal the active withdrawal amount;
- every completed automated withdrawal has route-specific terminal provider
  evidence;
- every completed manual withdrawal has the required manual evidence and actor
  separation;
- `lifetimePaid` equals evidence-backed completed withdrawals;
- no customer wallet debit claims external withdrawal without an external
  return aggregate and execution;
- stale reservations, ambiguous sends, failed inbox rows, and evidence
  mismatches page Finance.

Provider balance/transaction reports are part of reconciliation. A report that
only compares cached balances to GuestPost ledger rows is incomplete.

## 14. Incident repair

- Set `FINANCE_RUNTIME_MODE=recovery_only` before a financial cutover or
  incident repair. This blocks new liabilities, operator decisions, external
  sends, and manual completion while keeping authenticated webhook ingestion,
  exact provider retrieval, evidence recovery, and reconciliation available
  for money already in flight.
- `FINANCE_RUNTIME_MODE=locked` is the stronger evidence-preservation mode. It
  continues to accept durable inbound evidence but pauses recovery mutations.
- Production requires an explicit valid runtime mode. Missing or malformed
  configuration resolves to `locked`, never `normal`.
- Capture database and provider evidence before repair.
- Establish provider truth before changing liability.
- Never delete or rewrite financial history.
- Repair with an incident-linked, reason-required, idempotent compensating
  command that writes ledger, aggregate, audit, and any mandatory durable
  notification intent together.
- Require independent review for production compensation.
- Re-run reconciliation and retain before/after evidence.

The runtime policy is exact:

| Operation kind | `normal` | `recovery_only` | `locked` |
|---|---:|---:|---:|
| `read`, `inbound_evidence` | allow | allow | allow |
| `recovery` | allow | allow | block |
| `reconciliation` | allow | allow | block |
| `new_liability`, `operator_decision`, `external_send`, `manual_completion` | allow | block | block |

Production resolves a missing or invalid value to `locked`; development and
tests may default to `normal`. A blocked API operation returns stable
`503 FINANCE_OPERATION_BLOCKED`. `locked` still records authenticated inbound
evidence but does not run a mutating recovery or reconciliation worker.
Persistence does not imply a 2xx acknowledgment when later processing requires
facts held only in the signed request body: checkout-success returns 503 until
a recovery-capable mode can consume a fresh delivery. `locked` does not replace
provider feature flags, the payout-send kill switch, gateway controls during a
hard drain, or database evidence guards.

Direct SQL is acceptable for read-only incident analysis. Direct balance
`UPDATE` statements are not a repair procedure. Never improvise allocation,
ledger, or balance SQL to bypass an evidence-repair preflight; preserve the
rows and build a typed, reviewed, incident-specific compensation only after
external and internal evidence agree.

## 15. Change and release gate

Every changed money path requires:

- generated Prisma client and migration validation;
- real PostgreSQL integration tests for constraints and concurrency;
- unit tests for validation and authorization;
- duplicate, replay, out-of-order, timeout, rollback, and conflict tests;
- provider sandbox evidence when an external route changes;
- reconciliation assertions for the new state;
- a kill switch and recovery runbook;
- Finance/Security code-owner review;
- additive deployment ordering and post-deploy evidence queries.
- a populated historical-data migration fixture and, before deployment, a
  rehearsal against a sanitized recent database clone;
- proof that every installed PostgreSQL financial constraint is validated
  (`pg_constraint.convalidated = true`).

A migration that installs financial-evidence triggers is additive in schema
shape but not mixed-version compatible. Its release requires a hard drain of
every old API and worker writer before migration, restoration of ingress only
to the evidence-aware release, and a rehearsed forward-fix plan. Once protected
financial rows may exist, dropping guards or rolling the application back to
an old writer is forbidden.

Mocks may test orchestration, but they cannot certify database uniqueness,
transaction rollback, locking, or provider truth.
