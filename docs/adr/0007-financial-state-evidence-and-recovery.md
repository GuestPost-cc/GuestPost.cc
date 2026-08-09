# ADR 0007: Financial state, evidence, and recovery

- Status: Accepted
- Date: 2026-07-29
- Owners: Finance Engineering, Security

## Context

Several finance paths conflated internal state with external evidence:

- publisher approval queried a field absent from the data model and rechecked
  funds already reserved at request time;
- a Stripe dispute hold reused the deposit PaymentIntent identity, colliding
  with the provider-reference uniqueness constraint;
- an operator action could synthesize manual completion for an automated
  payout;
- a customer-wallet endpoint created an internal withdrawal without moving
  external money.

The common failure was not one provider adapter. It was the absence of one
repository-wide contract for reservations, identity, terminal evidence,
ambiguous outcomes, and repair.

## Decision

`docs/FINANCIAL_INVARIANTS.md` is the canonical financial engineering
contract.

We will:

1. represent internal commands, ledger rows, and provider objects with separate
   identity namespaces;
2. reserve internal liability before any external send;
3. perform external calls outside long database transactions with stable
   provider idempotency;
4. complete external-money operations only from route-specific terminal
   evidence;
5. preserve ambiguous outcomes for retrieval/reconciliation;
6. represent provider disputes as provider-neutral durable cases with
   monotonic states and owned holds;
7. keep customer wallets closed-loop until an original-source return design is
   approved and implemented;
8. make money transition, ledger, audit, and any mandatory durable
   notification intent atomic;
9. use append-only, incident-linked compensating commands for correction;
10. distinguish a locked pre-provider abort, which proves no external call was
    claimed, from provider cancellation/reversal, which requires typed
    provider evidence after a claim or provider ID exists;
11. bind automated payout completion to the persisted provider object, exact
    provider minor-unit amount, normalized currency, and route account scope;
12. make append-only normalized `PayoutExecutionClaim` rows the sole authority
    for an external payout send; `providerMetadata` JSON remains informational
    and `externalClaims` is forbidden;
13. enforce complete withdrawal, payout-execution status, and execution-stage
    graphs plus optimistic versions in PostgreSQL, not only in service code;
14. enforce maker-checker at each payout boundary: approver differs from
    execution initiator and first provider-send claimant, while a manual
    completion checker differs from requester, approver, and initiator;
15. preserve the credited deposit fact across `SUCCEEDED`,
    `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`, and `CHARGEBACK`, and require
    explicit immutable Stripe `livemode` evidence;
16. use a fail-closed finance runtime policy: `normal` permits all classified
    operations, `recovery_only` permits reads, inbound evidence, recovery, and
    reconciliation, and `locked` permits only reads and inbound evidence;
17. require real PostgreSQL and provider-sandbox release evidence, including a
    sanitized populated-clone migration rehearsal and proof that every
    financial constraint is validated;
18. fence every normalized provider-inbox claim with the exact
    `(attempts, lockedAt)` pair through aggregate mutation, completion,
    failure, and quarantine; only unchanged terminal snapshots are replayable
    as 2xx.

## Consequences

- “Mark Paid” is not a generic state override.
- A full-balance publisher withdrawal is valid because approval proves its
  reservation instead of looking for the amount in available balance again.
- Provider uniqueness on a deposit does not identify a dispute hold.
- Duplicate classification requires exact immutable-field comparison after
  rollback.
- Unknown or out-of-order provider events stay retryable/quarantined rather
  than being acknowledged as successful money transitions.
- A stale provider-inbox owner affects zero rows after lease recovery and
  cannot fail, quarantine, complete, audit, or move money for the new owner.
- Payout recovery may advance only the normalized claim's lease timestamp and
  repeat its exact original key. A JSON flag, audit record, or provider
  metadata snapshot cannot authorize a send or prove a no-send condition.
- Refund and dispute lifecycle states cannot make an already credited deposit
  disappear from exact-replay or dispute-correlation checks.
- A late provider failure after local completion is contradictory evidence:
  quarantine and alert without rewriting `lifetimePaid`, allocations, or the
  completed aggregate.
- Internal reconciliation must be supplemented by provider-truth
  reconciliation.
- Some operator workflows become deliberately slower because they require
  evidence and, where configured, maker-checker approval.
- Financial-evidence trigger migrations require a hard drain. Mixed old/new
  writers are unsupported, and an old application is not a rollback target
  after protected rows may have been written; incidents use feature freezes
  and forward fixes instead.
- Production with a missing or malformed `FINANCE_RUNTIME_MODE` enters
  `locked`; reopening `normal` is an explicit operator decision after migration
  and reconciliation evidence passes.
- A clean-database migration replay is necessary but insufficient. Historical
  classifications, lock duration, row counts, trigger inventory, incident
  queries, and `pg_constraint.convalidated` must be proven on a populated
  clone before the production hard drain.

## Alternatives rejected

### Keep generic administrative overrides

Rejected because privileged UI access is not settlement evidence and can
release liability without money movement.

### Treat every uniqueness error as an idempotent replay

Rejected because unrelated identities and malformed commands can collide. A
duplicate is safe only when the existing aggregate exactly matches.

### Refund arbitrary wallet balances through Stripe

Rejected because wallet balances can combine multiple funding and refund
sources. A valid external return needs original-source eligibility and
allocation.

### Put provider calls inside database transactions

Rejected because database rollback cannot undo an external side effect and
long transactions worsen contention and failure ambiguity.

## Follow-up

- Keep `PAYMENTS_ARCHITECTURE.md`, provider rollout guides, operations
  runbooks, reconciliation, tests, and Bedrock memory aligned with the
  canonical invariants.
- Introduce a balanced double-entry ledger before multi-currency or
  multi-provider scale; the current single-entry ledger remains an explicitly
  monitored interim boundary.
- Keep Wise automated sends and claimed-send replay disabled until its
  amount/currency evidence, terminal-state mapping, idempotency window,
  cancellation semantics, and provider-side reconciliation are certified.
