# Payments and payouts architecture

`docs/FINANCIAL_INVARIANTS.md` is the canonical contract for amounts,
reservations, identity, concurrency, terminal evidence, errors,
reconciliation, and incident repair. This document maps that contract onto the
current provider architecture.

## Non-negotiable ownership rule

Stripe and future providers move money. GuestPost's internal ledger determines
who owns it. A provider success response is evidence for a narrowly defined
state transition; it is never a replacement balance.

```text
Customer card
  -> DepositAttempt
  -> verified provider event
  -> DEPOSIT transaction + wallet credit (one database transaction)
  -> wallet purchase
  -> order/settlement
  -> publisher withdrawable balance
  -> Withdrawal + source allocations
  -> PayoutExecution
  -> provider bank confirmation
```

## Customer deposits

`DepositAttempt` is provider-neutral. It stores the customer method (`card`),
provider (`stripe`), public reference, gross amount, wallet credit, customer
fee, currency, idempotency key, external IDs, state, and the single ledger
transaction that credited the wallet.

The Stripe adapter may create/retrieve Checkout objects and verify Stripe
signatures. It cannot update `Wallet` or create a `Transaction`. `BillingService`
does that only after confirming all of the following from Stripe's server-side
object:

- mode matches the configured test/live key;
- payment is complete;
- currency, amount, wallet, and deposit-attempt metadata match server state;
- the provider event and deposit are not already processed;
- the wallet balance update and ledger row commit together.

Every signed Stripe event is first persisted in `PaymentProviderEvent`.
Provider/event/object identity, normalized facts, mode, fingerprint, and receipt
time are immutable and the row is never deleted. For Stripe, `livemode` is
non-null and must agree with the configured key mode; `sk_*` and least-privilege
`rk_*` credentials are classified by the same shared parser. A deposit
duplicate is accepted only when a post-rollback reread proves the exact
Checkout reference, PaymentIntent, wallet, amount, currency, ledger row, and
linked wallet-credit-backed `DepositAttempt`; otherwise the inbox event is
quarantined and Finance/Super Admin is alerted.

A conflicting signed envelope that reuses the identity of a designated
dispute role event is handled differently from an ordinary inbox collision.
The API locks and rereads the event, keeps the canonical `PROCESSED`
`openedByEventId`/`resolvedByEventId` evidence immutable, and records a
deduplicated identity-conflict incident plus Finance/Super Admin alert.
Repeated collisions are acknowledged without duplicating the incident or
changing money. Non-designated colliding inbox rows remain quarantinable.

The inbox lease is fenced by the exact pair `(attempts, lockedAt)`. Every
processing branch carries that pair through its transaction and includes it in
completion, failure, or quarantine predicates. Recovery increments the attempt
and changes the timestamp, so an older process cannot overwrite the recovered
owner even if it fails after the new claim. A live `PROCESSING` row is never an
idempotent success response; only an unchanged terminal snapshot can authorize
an exact 2xx replay.

The wallet-credit-backed states are `SUCCEEDED`, `PARTIALLY_REFUNDED`,
`REFUNDED`, `DISPUTED`, and `CHARGEBACK`. Refund and dispute lifecycle changes
are derivative views of an already-committed funding fact; they do not make
the original `DEPOSIT` row or exact-replay evidence disappear.

Checkout-success rows do not persist a replayable provider payload. If an
event arrives while finance mode is `locked`, the API persists its immutable
inbox envelope as `PENDING` and returns 503. An early redelivery that finds a
live `PROCESSING` lease also returns 503. Both responses keep Stripe
redelivery active. A later signed delivery can claim the pending row after
recovery is enabled or recover an expired lease; hourly reconciliation reports
stale, failed, or quarantined rows. Local state alone is never used to
synthesize a wallet credit. There is currently no independent authenticated
Checkout/PaymentIntent catch-up processor; recovery for this gap depends on a
fresh signature-verified Stripe redelivery.

In locked mode, only normalized dispute events may return 2xx as deferred
because the five-minute worker can replay their complete durable envelope.
Checkout expiry/failure and Radar early-fraud-warning events are persisted but
return 503 until a fresh signed redelivery can process them in a
recovery-capable mode. Unsupported event types are atomically terminalized as
`IGNORED`, including while locked.

The success page polls an authenticated endpoint by opaque public reference.
Its return URL carries no Stripe session identifier. It does not receive
internal wallet or transaction identifiers and cannot cause a credit.

Every public money-creation request requires a client idempotency key. Reusing
one with a different amount, currency, method, or destination fails with a
conflict instead of silently returning an unrelated financial object.

Customer wallets are closed-loop. There is no customer cash-out endpoint and a
wallet debit is never represented as an external refund without a durable
return aggregate and provider evidence.

Chargebacks create a provider-neutral dispute case keyed by the Stripe dispute
ID. The case links to the originating deposit and owns its wallet hold,
structured shortfall, and single terminal resolution. The deposit keeps the
PaymentIntent provider identity; internal hold/resolution rows use
server-generated ledger references and do not reuse that identity. Duplicate,
contradictory, unsupported, and out-of-order events converge through the case
state machine or remain retryable without moving money.

The API and five-minute worker share one serializable transition core. The
inbox row is locked first, the exact attempt/timestamp fence is revalidated,
the current Stripe key mode/live gate is checked immediately before the wallet
lock, retries use bounded backoff, and deterministic or exhausted events are
durably quarantined with an operator alert.

Case role evidence is commit-time atomic: a designated opening or resolution
event must finish as the exact `PROCESSED` inbox row back-linked to that case
and deposit. Distinct duplicate events may correlate to the case but cannot
replace the designated evidence. Credited deposit-attempt identity and its
`DEPOSIT` row are immutable before the first case can race them. The certified
dispute path is USD-only and all booked/exposure values are whole cents.

Held and shortfall amounts are the immutable booking snapshot. A won case
releases its hold and removes current exposure without rewriting that
historical snapshot.

## Publisher recipients and methods

`PublisherProviderAccount` records provider onboarding state. A
`PayoutMethod` points to it and is the customer-visible destination choice.
For Stripe the saved method contains no raw bank credentials. Stripe-hosted
Express onboarding owns KYC and bank collection.

Provider-account routing identity and payout-method binding are immutable
financial evidence. Status and capability facts may change, but publisher,
provider, external account ID, method type, and provider-account association
cannot be rebound or deleted in place.

An account is usable only when all gates are true:

- details submitted;
- Transfers capability active;
- payouts enabled;
- GuestPost manual payout schedule configured;
- local account status `ENABLED`;
- account default currency is USD (the only currency supported in this phase).

Manual scheduling is intentional. It lets one GuestPost withdrawal map to one
Stripe Payout and one statement reference instead of relying on Stripe's
automatic batched payout schedule.

## Withdrawal traceability

Each new withdrawal receives a reference such as `GP-WD-...`, fee-policy
snapshot, gross amount, fee, net amount, and currency. Its source allocations
consume, FIFO:

1. an honest carry-forward bucket for balances that existed at migration;
2. exact post-cutover `SETTLEMENT_RELEASE` transactions, net of debt repayment.

Allocations retain settlement, order, and service type. Their source and amount
identity is database-immutable and rows cannot be deleted. Rejection releases
them once after the parent becomes `REJECTED`; a deferred commit-time check
prevents rejection with an active reservation. Provider cancellation keeps the
reservation attached while returning the withdrawal to `APPROVED`.

The request transaction reserves the liability by subtracting the amount from
`withdrawableBalance` and creating the allocations. Approval proves those
unreleased allocations still equal the withdrawal; it does not look for the
reserved amount in available balance a second time. Eligibility is derived from
real membership/user state and the selected active payout method.

The database-enforced withdrawal graph is:

```text
PENDING -> APPROVED | REJECTED
APPROVED -> PROCESSING | REJECTED (claim-free pre-provider abandonment only)
PROCESSING -> APPROVED | FAILED | COMPLETED
FAILED -> APPROVED | COMPLETED
COMPLETED | REJECTED | REVERSED -> terminal
```

Returning to `APPROVED` requires typed cancellation on the latest execution,
and completion requires exactly one completed evidence-backed execution.
Finance may abandon an `APPROVED` withdrawal through the explicit, reviewed
safe-abandon command only when every execution is `PRE_PROVIDER_ABORTED`, no
durable send claim or provider object ever existed, and approval provenance is
preserved. The ordinary reject command remains restricted to `PENDING`.
Abandonment releases allocations and restores the balance exactly once in the
same transaction as the typed audit event.
`FAILED -> COMPLETED` permits late verified terminal evidence to converge.
`REVERSED` remains a legacy enum value, but the current guard rejects new
runtime transitions to it until a typed reversal command exists.

Payout-method deactivation is serialized with reservation lifecycle through a
database-maintained nonterminal-withdrawal count. A method cannot deactivate
while any `PENDING`, `APPROVED`, `PROCESSING`, or `FAILED` withdrawal still
references it; the method update and audit event commit atomically. An owner
may reactivate a managed method only through the explicit audited command,
which locks the provider account before the method and revalidates ownership,
active status, capabilities, onboarding completion, manual schedule, and USD
currency. Stripe synchronization never silently reactivates an owner-disabled
method.

Execution status is separately constrained:

```text
PROCESSING -> FAILED | COMPLETED | CANCELLED
FAILED -> COMPLETED
COMPLETED | CANCELLED -> terminal
```

New runtime executions are inserted only as `PROCESSING`, with canonical
command, route, actor, method, amount, currency, and idempotency snapshots.
Every update advances the optimistic version by exactly one.

## Stripe Connect execution states

| Local stage | Meaning | May complete withdrawal? |
|---|---|---|
| `CREATED` | No provider evidence yet | No |
| `DESTINATION_VALIDATED` | Immutable destination/provider snapshots were revalidated; no provider call has been claimed yet | No |
| `PROVIDER_SEND_CLAIMED` | The original provider send owns the execution; timeout is ambiguous and cannot return to `APPROVED` | No |
| `TRANSFER_CREATED` | Stripe Transfer accepted; API is preparing the bank stage | No |
| `TRANSFER_RECOVERY_REQUIRED` | Transfer exists; resume bank stage with original idempotency key | No |
| `BANK_PAYOUT_SEND_CLAIMED` / `BANK_PAYOUT_RESUME_CLAIMED` | One caller owns the Stripe bank-payout call with its original idempotency key | No |
| `PROVIDER_SEND_CLAIM_EXPIRED` / `BANK_PAYOUT_CLAIM_EXPIRED` | The original claim is too old for a blind create replay; provider lookup and Finance adjudication are mandatory | No |
| `BANK_PAYOUT_CREATED` | Payout accepted; local finalization is not yet confirmed | No |
| `BANK_PAYOUT_PENDING` | Persisted bank payout is pending/in transit | No |
| `BANK_PAYOUT_RECOVERY_REQUIRED` | Payout failed/uncertain after transfer | No |
| `PROVIDER_SENT` | A non-Stripe/manual provider accepted its exact claimed command | No |
| `PROVIDER_OUTCOME_UNKNOWN` / `PROVIDER_COMPLETION_RECOVERY_REQUIRED` | A provider call may have moved money or returned terminal evidence that is not yet safely finalized | No |
| `LEGACY_PROVIDER_OUTCOME_UNKNOWN` | Migration classified a historical pre-reference execution whose old writer may already have called a provider; never safe to resend automatically | No |
| `PROVIDER_FAILURE_REVIEW_REQUIRED` | Authenticated failure evidence exists, but liability remains reserved pending a typed recovery decision | No |
| `CANCEL_REQUESTED` | Provider cancellation/reversal is being reconciled | No |
| `CANCELLED_REVERSED` | Payout canceled and Transfer reversed | No |
| `PRE_PROVIDER_ABORTED` | Immutable destination/provider validation failed before a send claim; execution is cancelled and may be replaced | No |
| `BANK_PAID` | Stripe Payout is `paid` | Yes |
| `MANUAL_CONFIRMED` | Existing manual execution was completed with immutable bank evidence, known requester/approver/execution initiator provenance, and a current Finance/Super Admin checker distinct from each | Manual route only |

The complete allowed stage-transition graph is:

```text
CREATED
  -> DESTINATION_VALIDATED | PRE_PROVIDER_ABORTED
DESTINATION_VALIDATED
  -> PROVIDER_SEND_CLAIMED | PRE_PROVIDER_ABORTED
PROVIDER_SEND_CLAIMED
  -> PROVIDER_SEND_CLAIM_EXPIRED
   | TRANSFER_CREATED
   | TRANSFER_RECOVERY_REQUIRED
   | PROVIDER_SENT
   | PROVIDER_OUTCOME_UNKNOWN
   | PROVIDER_COMPLETION_RECOVERY_REQUIRED
TRANSFER_CREATED
  -> BANK_PAYOUT_SEND_CLAIMED | TRANSFER_RECOVERY_REQUIRED
TRANSFER_RECOVERY_REQUIRED
  -> BANK_PAYOUT_RESUME_CLAIMED | CANCEL_REQUESTED
BANK_PAYOUT_SEND_CLAIMED | BANK_PAYOUT_RESUME_CLAIMED
  -> BANK_PAYOUT_CLAIM_EXPIRED
   | BANK_PAID
   | BANK_PAYOUT_CREATED
   | BANK_PAYOUT_RECOVERY_REQUIRED
   | PROVIDER_COMPLETION_RECOVERY_REQUIRED
BANK_PAYOUT_CREATED | BANK_PAYOUT_PENDING | BANK_PAYOUT_RECOVERY_REQUIRED
  -> BANK_PAID
   | CANCEL_REQUESTED
   | PROVIDER_COMPLETION_RECOVERY_REQUIRED
   | BANK_PAYOUT_RECOVERY_REQUIRED
BANK_PAID
  -> PROVIDER_COMPLETION_RECOVERY_REQUIRED | BANK_PAYOUT_RECOVERY_REQUIRED
PROVIDER_SENT | PROVIDER_OUTCOME_UNKNOWN
  -> MANUAL_CONFIRMED
   | PROVIDER_COMPLETION_RECOVERY_REQUIRED
   | PROVIDER_FAILURE_REVIEW_REQUIRED
PROVIDER_COMPLETION_RECOVERY_REQUIRED
  -> BANK_PAID
   | BANK_PAYOUT_RECOVERY_REQUIRED
   | PROVIDER_FAILURE_REVIEW_REQUIRED
CANCEL_REQUESTED
  -> BANK_PAID | CANCELLED_REVERSED
```

Stages with no outgoing edge above are terminal or review-only under the
current implementation. In particular, `LEGACY_PROVIDER_OUTCOME_UNKNOWN`,
`*_CLAIM_EXPIRED`, `PRE_PROVIDER_ABORTED`, `CANCELLED_REVERSED`, and
`PROVIDER_FAILURE_REVIEW_REQUIRED` cannot be advanced by a generic retry.

Transfer creation and bank-payout creation use separate stable idempotency keys.
The Transfer ID is persisted before the Payout call. A crash in between can be
resumed without sending another Transfer. Webhooks and status polling match the
Payout ID using the execution's immutable connected-account snapshot. Stripe
webhooks must also carry that exact top-level Connect `account` and an
allowlisted bank-Payout event type. Terminal updates use one canonical evidence
finalizer plus database constraints.

The create response, authenticated status poll/retrieval, and verified webhook
all cross the same completion boundary. Each must provide the persisted bank
Payout ID, a positive provider amount in minor units, and normalized currency;
the amount/currency must exactly equal the immutable execution destination.
Stripe calls and events must also use the immutable connected account. Missing
or mismatched evidence cannot release liability. Verified webhook conflicts,
including a late failure after completion, are quarantined and alert
Finance/Super Admin without reopening the withdrawal or changing
`lifetimePaid`.

Finance may safely abort `CREATED` or `DESTINATION_VALIDATED` only when a
locked check proves no provider ID or durable external claim exists. After a
send claim, cancellation remains blocked without typed provider evidence.
Stale handoffs become explicit recovery states after 15 minutes; they are
never treated as failed funds that can be restored locally.

This `PRE_PROVIDER_ABORT` is a local no-send proof, not a provider
cancellation. Once a claim or provider object exists, recovery must use the
route's typed cancellation/reversal evidence and preserve the reservation
until external truth is established.

`CANCEL_REQUESTED` owns a 15-minute provider-call lease. Finance sees
**Cancellation in progress** while that lease is fresh; an errored or stale
command exposes **Resume cancellation**, which calls the cancellation endpoint
again with the same execution identity. It never uses generic payout Retry.
The adapter authenticates the parent Transfer mode and command before any
mutation. A crash after Stripe accepted the reversal is recovered by listing
and matching exactly one full reversal carrying the withdrawal reference and
payout-execution ID; partial, multiple, paginated, or mismatched reversals are
held for Finance review.

A `PayoutExecutionClaim` row is the sole database authority that a provider
mutation was claimed. It is append-only and unique per execution and call
family (`PROVIDER_SEND` or `BANK_PAYOUT_SEND`), and stores the exact provider
idempotency key, its SHA-256 fingerprint, first claim actor/time, and monotonic
last-claim time. Creating the row and moving the execution to its claimed
stage are one deferred-constraint-protected commit.

`providerMetadata` remains useful for immutable destination/provider snapshots
and typed completion/cancellation facts, but is informational for send
authority. The database removes and permanently rejects an `externalClaims`
JSON member. Audit metadata likewise cannot substitute for a normalized claim.

A claimed provider mutation has a 15-minute ownership lease. From 15 minutes
through 23 hours after the original claim, Finance may use **Recover claim**:
the service repeats only the exact original Stripe call with the exact original
idempotency key, after a new locked validation of the withdrawal reservation,
requester, destination, account, provider config, amount, and currency. The
current key must match the fingerprint stored by the first durable claim;
missing or mismatched identity is quarantined before provider I/O. The
new-send kill switch does not block this replay because it resolves an already
durable claim, but it still blocks every new claim. At 23 hours the claim is
quarantined, Finance/Super Admin are alerted, and no create call is made; Stripe
object lookup and human adjudication are required because provider idempotency
records may be pruned after 24 hours.

Automated payout completion belongs exclusively to verified provider events or
authenticated retrieval of the persisted provider object. A generic Finance
“Mark Paid” action cannot complete an approved or automated withdrawal, create
a synthetic execution, or replace provider evidence. If a manual payout route
is enabled, Finance may complete only its existing in-flight manual execution
with the configured bank/payment evidence and actor separation.

Historical completions migrated as `LEGACY_UNVERIFIED` are classifications, not
new proof. Reconciliation reports every such row until Finance substantiates it
through provider/bank records and an incident-reviewed repair process.
Historical cancellations are likewise `LEGACY_UNVERIFIED` and cannot authorize
a replacement execution.

Maker-checker is enforced at the database boundary. Approval requires a
current unbanned Finance/Super Admin. The execution initiator and first
provider-send claimant are current eligible staff and each must differ from
the recorded approver. Manual completion adds a current eligible checker who
must differ from the publisher requester, approver, and execution initiator.

Wise remains present only as an uncertified adapter boundary. Automated Wise
sends, automated completion, and claimed-send replay stay disabled until its
terminal amount/currency evidence, idempotency retention, cancellation
semantics, and provider-side reconciliation pass the provider certification
gates.

## Fee policy and statements

Policy `stripe-initial-v1` promises:

- customer deposit gross = wallet credit;
- publisher withdrawal gross = bank-payout amount;
- customer/publisher fee = USD 0.00;
- Stripe fees are a platform expense.

Customer card statements request `GUESTPOST* WALLET ####`. Publisher bank
statements request compact `GPOST`/withdrawal-reference wording within provider
limits. UI and support material must say “may appear” because banks can replace
or truncate the descriptor.

## Current boundary and future ledger

The current `Transaction`/balance model remains authoritative for this rollout.
Before multi-currency or multiple providers are live at scale, introduce
balanced `FinancialAccount`, `LedgerEntry`, and `LedgerPosting` records plus a
clearing account per provider/currency. Do not mix currencies in one wallet or
publisher balance.

The evidence-trigger migrations are maintenance-window cutovers, not ordinary
rolling migrations. Drain every old API and worker writer before applying
them, start only the matching release afterward, and use a feature freeze plus
forward fix for rollback. An old writer is incompatible once protected
financial rows may exist.
